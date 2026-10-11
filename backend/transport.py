"""Delivering game events to phones, and the process-wide state that needs it.

Three layers live here, in order:

* :class:`Poller` - one browser's long-poll mailbox. The phones talk plain HTTP
  (no WebSocket), so outgoing messages are queued and handed over on the next
  ``/api/poll``.
* :class:`Session` - one connected phone, independent of transport. It owns the
  player id, holds the room it joined, and translates the client's message types
  into :class:`~backend.models.Room` calls plus the broadcasts those imply.
* The broadcast helpers and the room/connection registries they walk.

The server keeps everything in memory: a single process serves one deployment,
and a round is worthless once it is over, so nothing is persisted. That also
means these registries are the whole source of truth about who is connected.

One rule ties the lifecycle together, because several bugs came from breaking it:
**unregistering a poll token and closing the session behind it always happen
together** - in :func:`sweep_once` and in ``app.api_disconnect``, and nowhere
else. Everything that wants to end a conversation early instead *evicts* the
mailbox (:func:`evict`), which marks it and wakes its parked poll so the phone is
told 410 at once, and leaves the reaper to take the player out of the room if the
phone never comes back. Keeping those two jobs apart is what stops an eviction
from leaving a seated player with nothing left to reap them.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from .models import CLONE_SUFFIX, MAX_PLAYERS, Room
from .sanitize import (
    clean_gallery,
    clean_motion_samples,
    clean_name,
    clean_player_id,
    clean_room_code,
)

log = logging.getLogger(__name__)

POLL_WAIT_MS = 20_000  # how long a poll request is parked before returning empty
POLL_EXPIRY_MS = 30_000  # a session whose phone stopped polling for this long is dropped
SWEEP_INTERVAL_S = 5  # how often sweep_pollers looks for expired mailboxes

#: Most ``motion`` relays one mailbox will hold. Motion is a best-effort feed of
#: "whose phone is moving right now" and ``motion/matching.js`` only correlates
#: the last six seconds of it, so a backlog deeper than this is worthless to the
#: phone and the oldest entries are the ones to lose.
MAX_QUEUED_MOTION = 64

#: Hard ceiling on one mailbox, counted after the sheddable traffic above has
#: been dropped. Reaching it means the backlog is made of messages that may not
#: be silently dropped (``roster``, ``welcome``, ``error``, hit feedback), so the
#: mailbox is evicted instead - see :meth:`Poller._shed`.
MAX_QUEUED_MESSAGES = 512


#: room code -> Room
rooms = {}
#: player id -> Session, i.e. everyone we can currently push a message to
connections = {}
#: poll token -> Poller
pollers = {}
#: room code -> set of asyncio.Queue, one per open SSE listener (see app.events)


def now_ms():
    """Wall-clock milliseconds, matching the client's ``Date.now()``."""
    return time.time() * 1000


@dataclass
class Poller:
    """A phone's mailbox for the HTTP long-polling transport.

    ``waiters`` holds one future per ``/api/poll`` request parked on this mailbox;
    resolving them hands the queued messages over immediately instead of making
    the phone wait out the full :data:`POLL_WAIT_MS`. It is a list rather than a
    single slot because a buggy or retrying client can have two polls in flight
    at once, and a single slot meant the second one orphaned the first.

    ``evicted`` is the reason this mailbox stopped being usable, or ``""`` while
    it is live. It is what the 410 on the next poll reports, so a client can tell
    "another tab took your seat" from "we forgot you".
    """

    token: str = ""
    queue: list = field(default_factory=list)
    last_seen: float = field(default_factory=now_ms)
    waiters: list = field(default_factory=list)
    session: object = None
    evicted: str = ""

    def is_live(self):
        """Whether this mailbox may still be polled.

        Both halves matter: :func:`evict` marks a mailbox without unregistering
        it, and :func:`sweep_pollers` unregisters it without being able to reach a
        poll already parked on it.
        """
        return not self.evicted and pollers.get(self.token) is self

    async def push(self, msg):
        """Queue one outgoing message and wake any parked poll.

        Returns whether the mailbox took it. An evicted mailbox takes nothing: it
        is never drained again, so queueing would only grow memory a reconnect is
        about to make irrelevant. Callers that record what a phone has been sent
        must key that off the return value - see :func:`broadcast_roster`.

        Async because this is what gets handed to :class:`Session` as its sender,
        which is transport agnostic and always awaits.
        """
        if self.evicted:
            return False
        self.queue.append(msg)
        self._shed()
        self.wake()
        return not self.evicted

    def _shed(self):
        """Keep the backlog bounded, cheapest-to-lose first.

        A mailbox is drained only by a poll, so a phone that stops polling - a
        locked screen, a wifi dropout, a backgrounded tab - accumulates every
        message addressed to it. At ~190 KB per gallery in a scan fan-out that is
        a real amount of memory per stalled phone, and nothing used to bound it.

        Three tiers, in order of increasing harm:

        1. Superseded ``state`` snapshots. A ``state`` is the complete scoreboard
           and the client simply replaces what it holds, so only the newest one is
           worth keeping - and handing over only the newest also makes the
           countdown it carries *less* stale, not more.
        2. The oldest ``motion`` relays beyond :data:`MAX_QUEUED_MOTION`. Stale
           motion is worse than no motion (see that constant).
        3. Whatever is left cannot be dropped without lying to the phone, so the
           mailbox is evicted instead of being trimmed. ``roster`` in particular
           is a *delta*: dropping one silently would leave the phone holding an
           old gallery while the server believed it had sent the new one. Eviction
           ends the conversation, and :func:`evict` drops the delivery record with
           it, so the phone's reconnect is sent the roster in full.

        Tiers 1 and 2 cannot evict anybody: a flood of motion settles at
        :data:`MAX_QUEUED_MOTION` entries and a flood of state at one, so reaching
        tier 3 takes hundreds of queued rosters or errors.

        The cheap exit below is deliberately ``< 2`` and not
        ``<= MAX_QUEUED_MOTION``. Guarding the whole method behind the motion cap
        is what the motion subsystem originally did, and it meant tier 1 did not
        run at all until a mailbox held 65 messages: a phone holding sixty-odd
        superseded scoreboards kept every one of them. Tier 1 is a single pass
        over a list that is almost always one or two entries long, so there is
        nothing to buy by skipping it.
        """
        if len(self.queue) < 2:
            return  # nothing to supersede and nothing to overflow

        newest_state = next(
            (i for i in range(len(self.queue) - 1, -1, -1) if self.queue[i].get("type") == "state"),
            None,
        )
        if newest_state is not None:
            self.queue = [
                msg for i, msg in enumerate(self.queue)
                if msg.get("type") != "state" or i == newest_state
            ]

        motion = [i for i, msg in enumerate(self.queue) if msg.get("type") == "motion"]
        if len(motion) > MAX_QUEUED_MOTION:
            dropped = set(motion[: len(motion) - MAX_QUEUED_MOTION])
            self.queue = [msg for i, msg in enumerate(self.queue) if i not in dropped]

        if len(self.queue) > MAX_QUEUED_MESSAGES:
            evict(self, "overflow")

    def wake(self):
        """Resolve every parked poll, so each returns with whatever is queued."""
        for waiter in self.waiters:
            if not waiter.done():
                waiter.set_result(True)

    def touch(self):
        """Mark the phone as alive, so :func:`sweep_pollers` leaves it be."""
        self.last_seen = now_ms()

    async def take(self):
        """Drain the mailbox, waiting for a first message if it is empty."""
        if not self.queue:
            waiter = asyncio.get_running_loop().create_future()
            self.waiters.append(waiter)
            try:
                await asyncio.wait_for(waiter, POLL_WAIT_MS / 1000)
            except asyncio.TimeoutError:
                pass
            finally:
                # Only ever this poll's own future: a timing-out poll used to null
                # the single slot another poll was parked on.
                if waiter in self.waiters:
                    self.waiters.remove(waiter)
        queue = self.queue
        self.queue = []
        return queue


def poller_for(session):
    """The mailbox a session is currently addressed through, or ``None``.

    A linear walk rather than a second registry: :class:`Session` is deliberately
    transport agnostic and holds no mailbox of its own, and another dict keyed by
    session would be one more thing to leak. ``pollers`` holds one entry per phone
    that has connected in the last :data:`POLL_EXPIRY_MS`, and this is only
    walked when a seat changes hands.
    """
    return next((poller for poller in pollers.values() if poller.session is session), None)


def evict(poller, reason):
    """Stop addressing a phone through this mailbox, and record why.

    Everything queued is dropped - an evicted mailbox is never drained again - and
    any parked poll is woken so the phone finds out now instead of waiting out
    :data:`POLL_WAIT_MS` and being told 200 OK about a room it has left.

    The delivery record goes with the queue, because dropping queued messages and
    remembering them as sent is exactly the combination that breaks the roster
    delta (see :func:`roster_for`). After this, the session can only be caught up
    by being replaced, and a replacement starts from an empty record.

    The token is deliberately *not* unregistered here. Unregistering is always
    paired with closing the session (:func:`sweep_once`, ``app.api_disconnect``),
    so leaving the token in place is what guarantees an eviction cannot strand a
    seated player with nothing left to reap them - the reaper still gets to it,
    because an evicted mailbox answers 410 without touching ``last_seen``.
    """
    if poller is None:
        return
    if not poller.evicted:
        poller.evicted = reason
    poller.queue = []
    if poller.session is not None:
        poller.session.sent_gallery_revs = {}
    poller.wake()


async def send_to(player_id, msg):
    """Send to one player if they are still connected; a no-op if they are not."""
    conn = connections.get(player_id)
    if conn is not None:
        await conn.send(msg)


async def broadcast_state(room):
    """Push the scoreboard to everyone, and re-push it when a countdown ends.

    The room has no clock of its own, so the countdown is resolved by this timer
    firing just after ``startsAt``: the follow-up snapshot is the one that
    reports ``playing``. Only one timer is ever outstanding per room.

    The outstanding timer is cancelled *before* anything is sent, and ``later()``
    takes itself out of ``room.start_timer`` the moment it stops sleeping. Those
    two together mean a timer is only ever cancelled while it is still asleep:
    once it has started broadcasting it is no longer reachable for cancellation,
    so it cannot be killed part way through the player loop and leave the rest of
    the room sitting on ``countdown`` forever. Previously the handle stayed in the
    slot for the whole of the timer's own broadcast, which was safe only by
    accident - nothing in the send path suspends today, so there was no point at
    which the cancellation could land.
    """
    state = room.snapshot()
    if room.start_timer is not None:
        room.start_timer.cancel()
        room.start_timer = None
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "state", "state": state})
    if state["status"] == "countdown":
        async def later():
            await asyncio.sleep((state["startsInMs"] + 10) / 1000)
            # Past the point of being cancelled, and no await in between, so this
            # hands the slot back atomically. Guarded because a broadcast that
            # raced us to the cancel may already have put a newer timer there.
            if room.start_timer is asyncio.current_task():
                room.start_timer = None
            await broadcast_state(room)

        room.start_timer = asyncio.create_task(later())


def roster_for(session, room):
    """The who-to-look-for list as this one phone still needs to hear it.

    Returns ``(entries, revisions)``. ``revisions`` is what the session would then
    be holding, and the caller must record it **only once the mailbox has taken
    the message built from** ``entries`` - see :func:`broadcast_roster`. Recording
    it up front is what let a phone end up holding nothing for a player while the
    server believed it had been sent their scan.

    Membership is always complete - every player's ``id`` and ``name`` is in
    every roster message - so a phone can always tell from one message alone who
    is in the room and who left. What is left out is the expensive part: a
    player's ``gallery`` is attached only when their scan differs from the one
    this session was last handed, and an entry with no ``gallery`` key tells the
    client to keep the one it already has.

    This used to send every gallery to everyone on every change, which cost the
    room N x N copies of a ~190 KB payload per scan (7.8 MB measured for six
    players) over captive-portal wifi, and the scanning phone had to download
    its whole share of that before it could even see its own ``scanSaved`` -
    which is the "the scan hangs" bug this replaced. The numbers are recorded in
    ``docs/server/protocol.md`` and asserted in ``backend/test_protocol.py``.

    The bookkeeping deliberately lives on the :class:`Session` rather than on the
    :class:`~backend.models.Player`, because that is what makes the delta safe
    without any version negotiation: a session is one TCP-level conversation with
    one phone, and *any* way of losing a message - a dropped poll, a 410, a
    reload, a reconnect, an evicted mailbox - ends that conversation and gets the
    phone a new Session with an empty record, which is then sent the roster in
    full. There is no state a phone can be left in where it believes it has a
    gallery the server never delivered.

    The one thing that argument rests on is that the server never withholds a
    gallery it has not actually put on that phone's wire. Three things keep that
    true: a revision is recorded only after the mailbox accepted the message
    (:func:`broadcast_roster`), :meth:`Poller._shed` never drops a ``roster``, and
    :func:`evict` clears the record whenever queued messages are dropped. The
    residue is a poll response that is built and then fails to reach the phone -
    the mailbox has already handed it over, so the server cannot know. The client
    covers that by throwing its token away on any failed poll, which ends the
    session; a client that ever *retries* a poll instead would reintroduce the
    bug, so it must reconnect rather than retry.
    """
    revisions = {}
    entries = []
    for player in room.players.values():
        revision = room.mirrored_gallery_rev(player)
        revisions[player.id] = revision
        entries.append(room.roster_entry(player, gallery=session.sent_gallery_revs.get(player.id) != revision))
    return entries, revisions


async def broadcast_roster(room):
    """Push each phone in the room its own delta of the who-to-look-for list.

    Addressed per connection rather than per player, because the delta is a
    property of the conversation with one phone. A debug clone has no connection
    of its own, which is why this walks ``connections`` instead of relying on
    :func:`send_to` to no-op for it.

    The loop stays serial on purpose: a send here is :meth:`Poller.push`, which
    appends to an in-memory mailbox and wakes a parked poll, so nothing in it
    waits on a phone. Gathering these would add a failure mode - one raising send
    abandoning the rest - and buy nothing.
    """
    for player_id in list(room.players.keys()):
        session = connections.get(player_id)
        if session is None:
            continue
        entries, revisions = roster_for(session, room)
        # Recorded only after the mailbox has taken it, never before: an evicted
        # mailbox takes nothing, and a phone must never be told "keep what you
        # have" about a gallery that was dropped on the way to it.
        if await session.send({"type": "roster", "players": entries}):
            session.sent_gallery_revs = revisions




async def process_hit(room, shooter_id, target_id, zone):
    """Resolve a shot and tell everyone who needs to know.

    One caller, ``app.api_hit``: the client resolves aiming on the phone and posts
    the result, and there is no ``shoot`` message in :meth:`Session.receive` for it
    to arrive by. Kept out of the handler so the notifications it implies are
    described in one place: a private confirmation to the shooter, a private "you
    were hit" to the victim, a ``health`` (and on a KO, ``death``) event to SSE
    listeners, and a fresh scoreboard to the room.
    """
    result = room.shoot(shooter_id, target_id, zone)
    if not result.get("ok"):
        return result
    await send_to(shooter_id, {
        "type": "hitConfirmed",
        "zone": result["zone"],
        "damage": result["damage"],
        "ko": result["ko"],
    })
    await send_to(result["victimId"], {
        "type": "gotHit",
        "zone": result["zone"],
        "damage": result["damage"],
        "ko": result["ko"],
    })
    await broadcast_state(room)
    return result


def displace(player_id):
    """Hand a seat to a new session and end the old conversation properly.

    A phone that reloads, or whose connection dropped, comes back with the
    ``playerId`` it remembers and adopts its old seat; the session that held it is
    then no longer the push target. Leaving that old mailbox registered and
    answering 200 with an empty list is what used to freeze it: the client only
    reconnects when a poll *fails*, so a 200 reads as "nothing has happened" and
    the phone sat on a stale roster, stale hp and a stale scoreboard forever,
    without even showing a connection warning.

    So the old mailbox is evicted with a reason, which makes its next poll - and
    the one already parked on it - a 410. :meth:`Session.close` on the displaced
    session then correctly does nothing, because the seat belongs to someone else
    now; the eviction is what had been missing, not the teardown.
    """
    previous = connections.get(player_id)
    if previous is None:
        return
    evict(poller_for(previous), "replaced")
    previous.room = None  # it no longer speaks for this seat


class Session:
    """One connected phone, independent of transport.

    ``sender(msg)`` delivers a message to it and reports whether the transport
    took it (for the HTTP transport that is a :class:`Poller`'s mailbox); the
    transport calls :meth:`receive` for each incoming message and :meth:`close`
    when the phone goes away.
    """

    def __init__(self, sender):
        self.id = str(uuid.uuid4())
        self.clone_id = f"{self.id}{CLONE_SUFFIX}"
        self.room = None
        self.sender = sender
        #: player id -> gallery revision this phone has already been sent, so a
        #: scan is only ever put on its wire once. Empty for a new session, which
        #: is why a reconnecting phone is sent the whole roster (see roster_for).
        self.sent_gallery_revs = {}

    async def send(self, msg):
        """Hand one message to the transport; returns whether it took it."""
        return await self.sender(msg)

    @property
    def is_seated(self):
        """Whether this session still speaks for a player in its room.

        Holding a room is not enough to be allowed to change it. A session whose
        player has been removed, or whose seat has been adopted by a newer
        session, kept full write access: it could overwrite another player's
        gallery - which fans out to every phone in the room - and issue ``start``.
        """
        return (
            self.room is not None
            and connections.get(self.id) is self
            and self.id in self.room.players
        )

    async def receive(self, msg):
        """Dispatch one client message. Unknown shapes and types are ignored."""
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "join" and self.room is None:
            await self._join(msg)
            return

        if not self.is_seated:
            return

        if msg.get("type") == "scan":
            # The one client-supplied id that used to reach the game logic
            # uncleaned, and it is echoed back in scanSaved, so it is cleaned at
            # the boundary like every other. An unknown id is still just an error.
            target_id = clean_player_id(msg.get("targetId"))
            gallery = clean_gallery(msg.get("gallery"))
            result = self.room.set_gallery(target_id, gallery)
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            await self.send({"type": "scanSaved", "targetId": target_id})
            await broadcast_roster(self.room)
            await broadcast_state(self.room)
        elif msg.get("type") == "motion":
            # This phone's motion activity, relayed to the others for motion matching
            # (public/motion/). Every phone checks whose phone moves with whom it sees.
            # The server keeps no history of it and never acts on it.
            samples = clean_motion_samples(msg.get("s"))
            if samples:
                relay = {"type": "motion", "from": self.id, "s": samples}
                for player_id in list(self.room.players.keys()):
                    if player_id != self.id:
                        await send_to(player_id, relay)
        elif msg.get("type") == "start":
            result = self.room.start()
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            await broadcast_state(self.room)

    async def _join(self, msg):
        """Enter a room, creating it if nobody is in it yet.

        Two paths other than a plain join:

        * Reconnect - a phone that supplies a ``playerId`` already in the room
          adopts that player instead of taking a new seat, so a browser reload
          mid-round does not lose its hp or wins. Whoever held that seat is
          displaced properly (see :func:`displace`) rather than left connected to
          a mailbox nobody drains.
        * ``debug: True`` - also seats a clone of this player so one phone can
          exercise a two-player round on its own. It needs two free seats, hence
          the stricter capacity check.
        """
        code = clean_room_code(msg.get("room"))
        room = rooms.get(code) or Room(code)
        name = clean_name(msg.get("name"))
        gallery = clean_gallery(msg.get("gallery"))
        requested_id = clean_player_id(msg.get("playerId"))
        if requested_id and requested_id in room.players:
            self.id = requested_id
            self.clone_id = f"{self.id}{CLONE_SUFFIX}"
            displace(requested_id)
            await self._enter(room, code)
            return
        if msg.get("debug") is True and len(room.players) > MAX_PLAYERS - 2:
            await self.send({"type": "error", "message": "Room is full"})
            return
        result = room.join(self.id, name, gallery)
        if not result["ok"]:
            await self.send({"type": "error", "message": result["error"]})
            return
        if msg.get("debug") is True:
            clone = room.join(self.clone_id, f"{name} clone", gallery)
            if not clone["ok"]:
                room.leave(self.id)
                await self.send({"type": "error", "message": clone["error"]})
                return
        await self._enter(room, code)

    async def _enter(self, room, code):
        """Register this session as the live connection for its player id."""
        rooms[code] = room
        connections[self.id] = self
        self.room = room
        await self.send({"type": "welcome", "id": self.id})
        await broadcast_state(room)
        await broadcast_roster(room)

    async def close(self):
        """Remove this phone's player (and clone) and drop the room if it empties.

        The identity check keeps a stale session from evicting the live one: on a
        reconnect the new session takes over the id in ``connections``, and the
        old one must then close quietly - the seat is not its to give up. Every
        reconnect reaches this branch, by way of the reaper eventually catching up
        with the mailbox :func:`displace` evicted.
        """
        if connections.get(self.id) is not self:
            return
        connections.pop(self.id, None)
        if not self.room:
            return
        room = self.room
        room.leave(self.id)
        room.leave(self.clone_id)
        if room.is_empty:
            if room.start_timer:
                room.start_timer.cancel()
                room.start_timer = None
            rooms.pop(room.code, None)
        else:
            await broadcast_state(room)
            await broadcast_roster(room)
        self.room = None


async def cancel_room_timers():
    """Cancel every outstanding countdown timer and wait for them to finish.

    Called from the app's cleanup: these tasks are created by
    :func:`broadcast_state` and are the only ones besides the reaper, so without
    this a shutdown mid-countdown logs "Task was destroyed but it is pending".
    """
    timers = []
    for room in list(rooms.values()):
        if room.start_timer is not None:
            timers.append(room.start_timer)
            room.start_timer.cancel()
            room.start_timer = None
    if timers:
        await asyncio.gather(*timers, return_exceptions=True)


async def sweep_once():
    """Unregister every mailbox whose phone stopped polling, and close it.

    Together with ``app.api_disconnect`` this is the only place a token leaves
    ``pollers``, and it is the only place a session is closed for going quiet -
    which is what makes :func:`evict` safe to use without worrying about who will
    eventually take the player out of the room.

    Each mailbox is reaped inside its own ``try``: one session whose
    :meth:`Session.close` raises must not cost the rest of them their turn.
    """
    now = now_ms()
    expired = [token for token, poller in pollers.items() if now - poller.last_seen > POLL_EXPIRY_MS]
    for token in expired:
        poller = pollers.pop(token, None)
        if poller is None:
            continue
        try:
            # Wakes whatever poll is parked on it, so an evicted phone is told 410
            # now instead of being answered 200 with a room it has been removed
            # from up to POLL_WAIT_MS later.
            evict(poller, "expired")
            await poller.session.close()
        except Exception:
            log.exception("reaping poll token %s failed", token)


async def sweep_pollers():
    """Drop sessions whose phone stopped polling.

    Long polling has no disconnect signal of its own - a phone that is closed,
    locked or driven out of range simply stops asking - so without this a room
    would keep dead players in its roster forever. Runs for the lifetime of the
    app (see ``app.start_background_tasks``).

    Nothing restarts this process on purpose, and this task is only ever awaited
    at shutdown, so an exception escaping the loop used to be both silent and
    permanent: no session reaped again for the life of the process, every
    disconnected phone keeping its seat and every abandoned room leaking. It is
    logged and the loop carries on instead. ``CancelledError`` is not an
    ``Exception``, so shutdown still stops it.
    """
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        try:
            await sweep_once()
        except Exception:
            log.exception("poll sweep failed")
