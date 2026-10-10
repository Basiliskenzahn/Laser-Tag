"""Unit tests for the transport layer's lifecycle, the parts HTTP cannot reach.

``backend/test_protocol.py`` drives the real app with polling clients and is the
right place for anything a phone can observe. The cases here are the ones that
need a clock moved, an exception injected, or a look at a session the HTTP layer
has already stopped answering for:

* :func:`~backend.transport.sweep_once` - the reaper had no test at all: not the
  eviction, not the fan-out it triggers, not what a parked poll sees, not what
  happens when ``close()`` raises.
* :class:`~backend.transport.Poller` - two polls on one token, and the mailbox
  caps, which need thousands of messages rather than a real room.
* :func:`~backend.transport.broadcast_state`'s countdown timer, whose hazard is
  structural: it only bites if a sender suspends, and none of them do today.
* A session that holds a room it is no longer a player in.

These poke ``transport``'s module-level registries directly, so
:class:`TransportTestCase` puts back whatever a test added - the protocol tests
share this process and the same globals.
"""

import asyncio
import unittest
import uuid
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from backend import app as app_module
from backend import transport
from backend.models import COUNTDOWN_MS, Room
from backend.sanitize import clean_room_code

SAMPLE = [{"hist": [1.0], "grid": [1.0]}]


async def wait_until(check, timeout=2.0):
    """Poll ``check()`` until truthy or fail, like test_protocol's wait_for."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not check():
        if loop.time() > deadline:
            raise AssertionError("Timed out waiting")
        await asyncio.sleep(0.01)


class TransportTestCase(unittest.IsolatedAsyncioTestCase):
    """Base class that leaves ``transport``'s registries as it found them."""

    REGISTRIES = ("rooms", "connections", "pollers", "sse_clients")

    def setUp(self):
        self._before = {name: set(getattr(transport, name)) for name in self.REGISTRIES}

    def tearDown(self):
        for name, before in self._before.items():
            registry = getattr(transport, name)
            for key in [key for key in registry if key not in before]:
                registry.pop(key, None)

    def mailbox(self):
        """A registered :class:`~backend.transport.Poller` with a session on it."""
        poller = transport.Poller(token=str(uuid.uuid4()))
        transport.pollers[poller.token] = poller
        poller.session = transport.Session(poller.push)
        return poller

    def room(self, label="unit"):
        """A fresh room, registered under the code a client's join would resolve to.

        The code has to survive ``clean_room_code``'s 16-character cap unchanged,
        or ``Session._join`` looks up a different room than the one registered
        here and quietly takes a seat in a new one instead of adopting.
        """
        code = f"{label[:6]}-{uuid.uuid4().hex[:8]}"
        self.assertEqual(clean_room_code(code), code, "test room code must survive cleaning")
        room = Room(code)
        transport.rooms[code] = room
        return room

    def seat(self, room, name="P"):
        """Seat a new session in ``room``, addressed through a real mailbox."""
        poller = self.mailbox()
        session = poller.session
        self.assertTrue(room.join(session.id, name, SAMPLE)["ok"])
        transport.connections[session.id] = session
        session.room = room
        return session, poller


class PollerMailboxTests(TransportTestCase):
    async def test_two_polls_parked_on_one_token_are_both_woken(self):
        # A single `waiter` slot meant the second poll orphaned the first, which
        # then never resolved: its messages waited out the full POLL_WAIT_MS.
        poller = self.mailbox()
        first = asyncio.ensure_future(poller.take())
        second = asyncio.ensure_future(poller.take())
        await asyncio.sleep(0.05)
        self.assertEqual(len(poller.waiters), 2, "both polls should be parked")

        await poller.push({"type": "ping"})
        drained = await asyncio.wait_for(asyncio.gather(first, second), 1)
        self.assertEqual(sorted(len(batch) for batch in drained), [0, 1],
                         "one poll takes the message, the other returns empty")

    async def test_a_timed_out_poll_does_not_strand_another_parked_one(self):
        # The `finally` used to clear the shared slot unconditionally, so a poll
        # timing out nulled the future a *different* poll was parked on.
        poller = self.mailbox()
        with mock.patch.object(transport, "POLL_WAIT_MS", 10_000):
            patient = asyncio.ensure_future(poller.take())
            await asyncio.sleep(0.05)
        with mock.patch.object(transport, "POLL_WAIT_MS", 50):
            impatient = asyncio.ensure_future(poller.take())
            await asyncio.sleep(0.3)

        self.assertTrue(impatient.done(), "the short poll should have timed out")
        self.assertEqual(await impatient, [])
        await poller.push({"type": "ping"})
        self.assertEqual(await asyncio.wait_for(patient, 1), [{"type": "ping"}],
                         "the still-parked poll must still be reachable")

    async def test_a_flood_of_motion_is_shed_without_ending_the_session(self):
        # Motion is a best-effort relay and matching.js only correlates the last
        # six seconds, so the oldest are the ones to lose - and a phone must never
        # lose its seat over motion alone.
        poller = self.mailbox()
        pushed = 1280
        for i in range(pushed):
            self.assertTrue(await poller.push({"type": "motion", "from": "x", "s": [[i, 1.0]]}))

        self.assertEqual(poller.evicted, "", "motion alone must not evict a mailbox")
        self.assertLess(len(poller.queue), pushed // 4, "the backlog should be shed, not kept")
        self.assertEqual(poller.queue[-1]["s"][0][0], pushed - 1, "the newest sample must survive")
        self.assertEqual(poller.queue[0]["s"][0][0], pushed - len(poller.queue),
                         "and it is the oldest that go")

    async def test_only_the_newest_scoreboard_is_kept_under_pressure(self):
        # A `state` is the complete scoreboard and the client just replaces what it
        # holds, so superseded ones are not worth a phone's wifi - and handing over
        # only the newest makes the countdown it carries less stale, not more.
        poller = self.mailbox()
        for i in range(transport.MAX_QUEUED_MOTION + 10):
            await poller.push({"type": "motion", "from": "x", "s": [[i, 1.0]]})
        for i in range(6):
            await poller.push({"type": "state", "state": {"tick": i}})

        states = [msg for msg in poller.queue if msg["type"] == "state"]
        self.assertEqual(states, [{"type": "state", "state": {"tick": 5}}])

    async def test_a_backlog_of_undroppable_messages_evicts_the_mailbox(self):
        # Nothing here can be dropped without lying to the phone, so the mailbox
        # is ended rather than trimmed. Reaching this takes hundreds of messages
        # that are not motion and not state.
        poller = self.mailbox()
        accepted = 0
        for i in range(transport.MAX_QUEUED_MESSAGES + 10):
            if await poller.push({"type": "error", "message": f"e{i}"}):
                accepted += 1

        self.assertEqual(poller.evicted, "overflow")
        self.assertEqual(poller.queue, [], "an evicted mailbox is never drained again")
        self.assertFalse(poller.is_live())
        self.assertLess(accepted, transport.MAX_QUEUED_MESSAGES + 10,
                        "push must report that it stopped taking messages")

    async def test_an_evicted_mailbox_takes_nothing_more(self):
        poller = self.mailbox()
        transport.evict(poller, "replaced")
        self.assertFalse(await poller.push({"type": "state", "state": {}}))
        self.assertEqual(poller.queue, [], "a dead mailbox must not grow")

    async def test_eviction_forgets_what_the_server_believed_it_delivered(self):
        # The roster delta only withholds a gallery it has already put on that
        # phone's wire. Eviction drops the queue, so it has to drop that belief
        # with it or the phone is told "keep what you have" about a roster that
        # was thrown away.
        poller = self.mailbox()
        poller.session.sent_gallery_revs = {"someone": 3}
        transport.evict(poller, "overflow")
        self.assertEqual(poller.session.sent_gallery_revs, {})

    async def test_a_live_mailbox_keeps_its_token_registered(self):
        poller = self.mailbox()
        self.assertTrue(poller.is_live())
        transport.pollers.pop(poller.token)
        self.assertFalse(poller.is_live(), "an unregistered token is not live either")


class SweepTests(TransportTestCase):
    def expire(self, poller):
        poller.last_seen = transport.now_ms() - transport.POLL_EXPIRY_MS - 1_000

    async def test_an_expired_phone_loses_its_seat_and_the_room_is_told(self):
        room = self.room("sweep-seat")
        alice, alice_box = self.seat(room, "Alice")
        bob, bob_box = self.seat(room, "Bob")
        await transport.broadcast_roster(room)
        alice_box.queue.clear()
        self.expire(bob_box)

        await transport.sweep_once()

        self.assertNotIn(bob.id, room.players, "the reaper must take the seat back")
        self.assertNotIn(bob_box.token, transport.pollers)
        self.assertNotIn(bob.id, transport.connections)
        types = [msg["type"] for msg in alice_box.queue]
        self.assertIn("state", types, "the rest of the room has to hear about it")
        self.assertIn("roster", types)
        state = next(msg["state"] for msg in alice_box.queue if msg["type"] == "state")
        self.assertEqual([player["id"] for player in state["players"]], [alice.id])

    async def test_a_parked_poll_is_woken_when_its_session_is_swept(self):
        # Without the wake, an evicted phone's poll ran out its remaining
        # POLL_WAIT_MS and then answered 200 with pre-eviction content - up to
        # ~20 s of showing a room it had been removed from.
        room = self.room("sweep-parked")
        self.seat(room, "Alice")
        bob, bob_box = self.seat(room, "Bob")
        parked = asyncio.ensure_future(bob_box.take())
        await asyncio.sleep(0.05)
        self.expire(bob_box)

        await transport.sweep_once()

        self.assertEqual(await asyncio.wait_for(parked, 1), [],
                         "the parked poll should have returned at once")
        self.assertEqual(bob_box.evicted, "expired")
        self.assertFalse(bob_box.is_live(), "so the handler answers 410, not 200")

    async def test_one_session_that_cannot_close_does_not_cost_the_others_their_turn(self):
        # A single exception out of close() used to escape the whole sweep.
        room = self.room("sweep-raises")
        self.seat(room, "Alice")
        bob, bob_box = self.seat(room, "Bob")
        carol, carol_box = self.seat(room, "Carol")

        async def boom():
            raise RuntimeError("close failed")

        bob.close = boom
        self.expire(bob_box)
        self.expire(carol_box)

        with self.assertLogs(transport.log, "ERROR") as logs:
            await transport.sweep_once()

        self.assertNotIn(carol.id, room.players, "the session after the failing one was skipped")
        self.assertNotIn(bob_box.token, transport.pollers, "a failing session is still unregistered")
        self.assertTrue(any(record.exc_info for record in logs.records), "the failure must be logged")

    async def test_the_sweep_loop_survives_a_pass_that_raises(self):
        # The loop is only ever awaited at shutdown, so an exception escaping it
        # was silent *and* permanent: no session reaped again for the life of the
        # process, every disconnected phone keeping its seat.
        passes = []

        async def flaky():
            passes.append(len(passes))
            if len(passes) == 1:
                raise RuntimeError("pass failed")

        with mock.patch.object(transport, "SWEEP_INTERVAL_S", 0.01), \
                mock.patch.object(transport, "sweep_once", flaky), \
                self.assertLogs(transport.log, "ERROR"):
            loop_task = asyncio.create_task(transport.sweep_pollers())
            try:
                await wait_until(lambda: len(passes) >= 3, 3)
            finally:
                loop_task.cancel()
                await asyncio.gather(loop_task, return_exceptions=True)

        self.assertGreaterEqual(len(passes), 3, "the loop stopped at the first failure")


class CountdownTimerTests(TransportTestCase):
    async def start_countdown(self, room):
        self.assertTrue(room.start()["ok"])
        await transport.broadcast_state(room)
        self.assertIsNotNone(room.start_timer)

    async def test_a_broadcasting_timer_is_not_reachable_for_cancellation(self):
        # The structural claim. broadcast_state cancels room.start_timer, and the
        # timer task *is* what re-enters broadcast_state, so for the whole of its
        # own broadcast the handle pointed at a running task. That was safe only
        # because nothing in the send path suspends; this asserts the invariant
        # rather than the accident.
        room = self.room("timer-handle")
        self.seat(room, "Alice")
        bob, bob_box = self.seat(room, "Bob")
        seen = []

        async def watching(msg):
            if msg.get("type") == "state" and msg["state"]["status"] == "playing":
                seen.append(room.start_timer is asyncio.current_task())
            return True

        bob.sender = watching
        await self.start_countdown(room)
        await wait_until(lambda: seen, COUNTDOWN_MS / 1000 + 3)

        self.assertTrue(seen)
        self.assertFalse(any(seen),
                         "the timer must hand its slot back before it starts broadcasting")

    async def test_the_countdown_broadcast_finishes_even_when_a_send_suspends(self):
        # The consequence: a competing broadcast_state cancels room.start_timer,
        # and if that handle still points at the timer mid-loop the "countdown
        # over, status playing" message dies part way through and the remaining
        # phones sit on `countdown` forever.
        room = self.room("timer-suspend")
        alice, alice_box = self.seat(room, "Alice")
        self.seat(room, "Bob")
        self.seat(room, "Carol")
        interfered = []

        async def interfering(msg):
            alice_box.queue.append(msg)
            if msg.get("type") == "state" and msg["state"]["status"] == "playing" and not interfered:
                interfered.append(True)
                timer = room.start_timer
                if timer is not None:
                    timer.cancel()  # exactly what a concurrent broadcast_state does
                await asyncio.sleep(0)  # and a sender that yields, which none do today
            return True

        alice.sender = interfering
        await self.start_countdown(room)

        def everyone_is_playing():
            boxes = [transport.pollers[token] for token in transport.pollers
                     if transport.pollers[token].session in
                     [transport.connections[pid] for pid in room.players]]
            return all(
                any(msg.get("type") == "state" and msg["state"]["status"] == "playing"
                    for msg in box.queue)
                for box in boxes
            ) and len(boxes) == 3

        await wait_until(everyone_is_playing, COUNTDOWN_MS / 1000 + 3)
        self.assertTrue(interfered, "the interfering sender never ran")

    async def test_shutdown_cancels_a_pending_countdown_timer(self):
        # Otherwise a shutdown mid-countdown logs "Task was destroyed but it is
        # pending": stop_background_tasks used to cancel only the reaper.
        room = self.room("timer-shutdown")
        self.seat(room, "Alice")
        self.seat(room, "Bob")
        await self.start_countdown(room)
        timer = room.start_timer

        await transport.cancel_room_timers()

        self.assertIsNone(room.start_timer)
        self.assertTrue(timer.done(), "the timer task must be finished, not left pending")


class SeatedWriteAccessTests(TransportTestCase):
    async def test_a_session_whose_player_was_removed_cannot_write_to_the_room(self):
        # receive() gated scan/motion/start on holding a room, never on still
        # being a player in it. A gallery write fans out to every phone.
        room = self.room("seatless")
        alice, _ = self.seat(room, "Alice")
        bob, _ = self.seat(room, "Bob")
        carol, _ = self.seat(room, "Carol")
        room.leave(alice.id)
        before_gallery = bob.room.players[bob.id].gallery
        before_rev = room.players[bob.id].gallery_rev

        await alice.receive({"type": "scan", "targetId": bob.id, "gallery": [{"hist": [9.0], "grid": [9.0]}]})
        await alice.receive({"type": "start"})

        self.assertEqual(room.players[bob.id].gallery, before_gallery,
                         "a seat-less session overwrote another player's gallery")
        self.assertEqual(room.players[bob.id].gallery_rev, before_rev)
        self.assertEqual(room.status, "waiting", "a seat-less session started the round")

    async def test_a_displaced_session_cannot_write_to_the_room(self):
        room = self.room("displaced-write")
        alice, alice_box = self.seat(room, "Alice")
        bob, _ = self.seat(room, "Bob")
        before_rev = room.players[bob.id].gallery_rev

        taking_over = self.mailbox().session
        await taking_over.receive({"type": "join", "name": "Alice", "room": room.code, "playerId": alice.id})

        self.assertEqual(alice_box.evicted, "replaced", "the old mailbox must be evicted")
        self.assertIs(transport.connections[alice.id], taking_over)
        self.assertFalse(alice.is_seated)

        await alice.receive({"type": "scan", "targetId": bob.id, "gallery": [{"hist": [9.0], "grid": [9.0]}]})
        self.assertEqual(room.players[bob.id].gallery_rev, before_rev,
                         "the displaced session still had write access")

    async def test_closing_a_superseded_session_leaves_the_live_one_seated(self):
        # close()'s early return is reached by every reconnect and was asserted by
        # nothing. The reaper eventually closes the displaced session, and that
        # must not take the seat its replacement now holds.
        room = self.room("superseded-close")
        alice, alice_box = self.seat(room, "Alice")
        self.seat(room, "Bob")

        replacement_box = self.mailbox()
        await replacement_box.session.receive(
            {"type": "join", "name": "Alice", "room": room.code, "playerId": alice.id}
        )
        replacement_box.queue.clear()

        await alice.close()

        self.assertIn(alice.id, room.players, "the seat is not the displaced session's to give up")
        self.assertIs(transport.connections[alice.id], replacement_box.session)
        await transport.broadcast_state(room)
        self.assertTrue(any(msg["type"] == "state" for msg in replacement_box.queue),
                        "the live session must still be the push target")


class SseListenerTests(TransportTestCase):
    async def test_a_cancelled_listener_propagates_and_is_forgotten(self):
        # events() swallowed CancelledError and returned normally, which told the
        # server the stream had ended of its own accord and defeated graceful
        # shutdown. The listener still has to be forgotten either way.
        code = f"sse{uuid.uuid4().hex[:6]}"
        request = make_mocked_request("GET", f"/events/{code}", match_info={"room": code})

        with mock.patch.object(web.StreamResponse, "prepare", mock.AsyncMock()), \
                mock.patch.object(web.StreamResponse, "write", mock.AsyncMock()):
            handler = asyncio.create_task(app_module.events(request))
            await wait_until(lambda: code in transport.sse_clients, 2)
            handler.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await handler

        self.assertNotIn(code, transport.sse_clients,
                         "the room's entry goes with its last listener")

    async def test_a_stalled_listener_loses_its_oldest_events_not_the_server(self):
        room = self.room("sse-backlog")
        queue = asyncio.Queue(maxsize=3)
        transport.sse_clients.setdefault(room.code, set()).add(queue)

        for i in range(10):
            await transport.broadcast_room_event(room, {"type": "health", "n": i})

        self.assertEqual(queue.qsize(), 3, "the backlog must stay bounded")
        self.assertEqual([queue.get_nowait()["n"] for _ in range(3)], [7, 8, 9],
                         "the newest events are the ones kept")


if __name__ == "__main__":
    unittest.main()
