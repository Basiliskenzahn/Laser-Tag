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
"""

import asyncio
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

POLL_WAIT_MS = 20_000  # how long a poll request is parked before returning empty
POLL_EXPIRY_MS = 30_000  # a session whose phone stopped polling for this long is dropped

#: room code -> Room
rooms = {}
#: player id -> Session, i.e. everyone we can currently push a message to
connections = {}
#: poll token -> Poller
pollers = {}
#: room code -> set of asyncio.Queue, one per open SSE listener (see app.events)
sse_clients = {}


def now_ms():
    """Wall-clock milliseconds, matching the client's ``Date.now()``."""
    return time.time() * 1000


@dataclass
class Poller:
    """A phone's mailbox for the HTTP long-polling transport.

    ``waiter`` is set only while a ``/api/poll`` request is parked on this
    mailbox; resolving it hands the queued messages over immediately instead of
    making the phone wait out the full :data:`POLL_WAIT_MS`.
    """

    queue: list = field(default_factory=list)
    last_seen: float = field(default_factory=now_ms)
    waiter: asyncio.Future | None = None
    session: object = None

    async def push(self, msg):
        """Queue one outgoing message and wake any parked poll.

        Async because this is what gets handed to :class:`Session` as its
        sender, which is transport agnostic and always awaits.
        """
        self.queue.append(msg)
        self.wake()

    def wake(self):
        if self.waiter and not self.waiter.done():
            self.waiter.set_result(True)

    def touch(self):
        """Mark the phone as alive, so :func:`sweep_pollers` leaves it be."""
        self.last_seen = now_ms()

    async def take(self):
        """Drain the mailbox, waiting for a first message if it is empty."""
        if not self.queue:
            self.waiter = asyncio.get_running_loop().create_future()
            try:
                await asyncio.wait_for(self.waiter, POLL_WAIT_MS / 1000)
            except asyncio.TimeoutError:
                pass
            finally:
                self.waiter = None
        queue = self.queue
        self.queue = []
        return queue


async def send_to(player_id, msg):
    """Send to one player if they are still connected; a no-op if they are not."""
    conn = connections.get(player_id)
    if conn is not None:
        await conn.send(msg)


async def broadcast_state(room):
    """Push the scoreboard to everyone, and re-push it when a countdown ends.

    The room has no clock of its own, so the countdown is resolved by this timer
    firing just after ``startsAt``: the follow-up snapshot is the one that
    reports ``playing``. Any previously scheduled timer is cancelled first so
    only one is ever outstanding per room.
    """
    state = room.snapshot()
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "state", "state": state})
    if room.start_timer:
        room.start_timer.cancel()
        room.start_timer = None
    if state["status"] == "countdown":
        async def later():
            await asyncio.sleep((state["startsInMs"] + 10) / 1000)
            await broadcast_state(room)

        room.start_timer = asyncio.create_task(later())


async def broadcast_roster(room):
    """Push the heavy who-to-look-for list (names + galleries) to everyone."""
    players = room.roster()
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "roster", "players": players})


async def broadcast_room_event(room, event):
    """Fan an event out to the room's SSE spectators (scoreboards, overlays).

    Separate from the per-player channels above: these listeners are not players
    and are addressed by room code only.
    """
    dead = []
    for queue in list(sse_clients.get(room.code, set())):
        try:
            await queue.put(event)
        except RuntimeError:
            dead.append(queue)
    for queue in dead:
        sse_clients.get(room.code, set()).discard(queue)


async def process_hit(room, shooter_id, target_id, zone):
    """Resolve a shot and tell everyone who needs to know.

    Shared by both ways a hit can arrive - a ``shoot`` message over the polling
    session and a direct ``POST /api/hit`` - so the notifications stay identical:
    a private confirmation to the shooter, a private "you were hit" to the
    victim, a ``health`` (and on a KO, ``death``) event to SSE listeners, and a
    fresh scoreboard to the room.

    A miss only counts toward the shooter's stats, so nobody is told. The next
    ``state`` carries it, and one always follows before a player's round is
    over: their own knockout, or the end of the round.
    """
    result = room.shoot(shooter_id, target_id, zone)
    if not result.get("ok") or not result["hit"]:
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
    await broadcast_room_event(room, {
        "type": "health",
        "room": room.code,
        "shooterId": shooter_id,
        "targetId": result["victimId"],
        "zone": result["zone"],
        "damage": result["damage"],
        "hp": result["hp"],
        "alive": result["alive"],
    })
    if result["ko"]:
        await broadcast_room_event(room, {
            "type": "death",
            "room": room.code,
            "playerId": result["victimId"],
            "killerId": shooter_id,
        })
    await broadcast_state(room)
    return result


class Session:
    """One connected phone, independent of transport.

    ``sender(msg)`` delivers a message to it (for the HTTP transport that is a
    :class:`Poller`'s mailbox); the transport calls :meth:`receive` for each
    incoming message and :meth:`close` when the phone goes away.
    """

    def __init__(self, sender):
        self.id = str(uuid.uuid4())
        self.clone_id = f"{self.id}{CLONE_SUFFIX}"
        self.room = None
        self.sender = sender

    async def send(self, msg):
        await self.sender(msg)

    async def receive(self, msg):
        """Dispatch one client message. Unknown shapes and types are ignored."""
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "join" and self.room is None:
            await self._join(msg)
            return

        if self.room is None:
            return

        if msg.get("type") == "scan":
            target_id = msg.get("targetId")
            gallery = clean_gallery(msg.get("gallery"))
            result = self.room.set_gallery(target_id, gallery)
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            await self.send({"type": "scanSaved", "targetId": target_id})
            await broadcast_roster(self.room)
            await broadcast_state(self.room)
        elif msg.get("type") == "clearScan":
            target_id = msg.get("targetId")
            result = self.room.clear_gallery(target_id)
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            # Everyone, not just the sender: each phone drops its own cached copy of that scan,
            # or the scanned player's phone would send it straight back on its next join.
            for player_id in list(self.room.players.keys()):
                await send_to(player_id, {"type": "scanCleared", "targetId": target_id})
            await broadcast_roster(self.room)
            await broadcast_state(self.room)
        elif msg.get("type") == "motion":
            # This phone's motion activity, relayed to the others for motion matching
            # (public/motion/). Every phone checks whose phone moves with whom it sees.
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
          mid-round does not lose its hp or wins.
        * ``debug: True`` - also seats a clone of this player so one phone can
          exercise a two-player round on its own. It needs two free seats, hence
          the stricter capacity check.
        """
        code = clean_room_code(msg.get("room"))
        room = rooms.get(code) or Room(code)
        name = clean_name(msg.get("name"))
        gallery = clean_gallery(msg.get("gallery"))
        requested_id = clean_player_id(msg.get("playerId"))
        if requested_id and requested_id in room.players and not room.players[requested_id].forfeited:
            self.id = requested_id
            self.clone_id = f"{self.id}{CLONE_SUFFIX}"
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

    async def close(self, forfeit=False):
        """Remove this phone's player (and clone) and drop the room if it empties.

        ``forfeit`` is a deliberate leave (the player tapped "leave"), which
        mid-round counts as a knockout - see :meth:`Room.forfeit`. A phone that
        merely went quiet is not forfeited, since it may still come back.

        The identity check keeps a stale session from evicting the live one: on a
        reconnect the new session takes over the id in ``connections``, and the
        old one must then close quietly.
        """
        if connections.get(self.id) is not self:
            return
        connections.pop(self.id, None)
        if not self.room:
            return
        room = self.room
        knocked_out = []
        for player_id in (self.id, self.clone_id):
            if forfeit:
                if room.forfeit(player_id).get("ko"):
                    knocked_out.append(player_id)
            else:
                room.leave(player_id)
        for player_id in knocked_out:
            await broadcast_room_event(room, {
                "type": "death",
                "room": room.code,
                "playerId": player_id,
                "killerId": None,
            })
        if room.is_empty:
            if room.start_timer:
                room.start_timer.cancel()
            rooms.pop(room.code, None)
        else:
            await broadcast_state(room)
            await broadcast_roster(room)
        self.room = None


async def sweep_pollers():
    """Drop sessions whose phone stopped polling.

    Long polling has no disconnect signal of its own - a phone that is closed,
    locked or driven out of range simply stops asking - so without this a room
    would keep dead players in its roster forever. Runs for the lifetime of the
    app (see ``app.start_sweeper``).
    """
    while True:
        await asyncio.sleep(5)
        now = now_ms()
        expired = [token for token, poller in pollers.items() if now - poller.last_seen > POLL_EXPIRY_MS]
        for token in expired:
            poller = pollers.pop(token, None)
            if poller:
                await poller.session.close()
