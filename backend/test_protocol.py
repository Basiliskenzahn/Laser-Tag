"""HTTP/SSE protocol tests for the Python backend - the actual deployed server.

This is the Python half of the coverage ``deprecated/server/realtime.test.js`` used
to provide for the (now archived) Node implementation: it drives the real aiohttp
app (``create_app()``) with fetch-equivalent polling clients, exactly like phones
do, rather than calling ``Room``/``Session`` methods directly. See
``docs/streamlining.md`` for the history and ``docs/development/testing.md`` for
how to run this.

``rooms``/``connections``/``pollers``/``sse_clients`` in ``backend.transport`` are
module-level globals shared by every test in this process (there is no per-test
app state to reset, same as the Node version had) - every test below uses a
**unique room code** so they cannot interfere with each other.
"""

import asyncio
import json
import unittest
import uuid

import aiohttp
from aiohttp.test_utils import AioHTTPTestCase, TestClient, TestServer

from backend import transport
from backend.app import MAX_BODY_BYTES, create_app
from backend.sanitize import clean_room_code

GALLERY = [{"hist": [1, 0], "grid": [0, 1]}]

#: Field widths one enrolment sample actually arrives with, per
#: docs/server/protocol.md. Most tests here only care that a gallery is present,
#: but the fan-out tests measure bytes, and a two-number stand-in would make a
#: byte assertion meaningless.
SAMPLE_WIDTHS = {"hist": 64, "grid": 192, "lower": 64, "shape": 2, "embed": 256, "reid": 512}


def full_gallery(seed):
    """A realistically sized 24-sample enrolment scan (~190 KB of JSON)."""
    return [
        {
            name: [round(((seed + angle * 7 + i * 13) % 2000) / 1000 - 1, 4) for i in range(width)]
            for name, width in SAMPLE_WIDTHS.items()
        }
        for angle in range(24)
    ]


FULL_GALLERY = full_gallery(1)
RESCAN_GALLERY = full_gallery(2)
#: One gallery's cost on the wire, the unit the fan-out assertions are written in.
GALLERY_BYTES = len(json.dumps(FULL_GALLERY, separators=(",", ":")))


def unique_room(label):
    return f"{label}-{uuid.uuid4().hex[:8]}"


def registry_code(room):
    """The key a room code is actually filed under.

    ``clean_room_code`` caps a code at 16 characters, and the labels above are
    longer than that, so a test that looks a room up in ``transport.rooms`` or
    ``transport.sse_clients`` has to clean it the same way the server did.
    """
    return clean_room_code(room)


def last_state(messages):
    states = [m["state"] for m in messages if m.get("type") == "state"]
    return states[-1] if states else None


def last_roster(messages):
    """The roster a phone would be *holding* after receiving these messages.

    The server sends the roster as a delta (``transport.roster_for``): membership
    is complete in every message, but a player's ``gallery`` is attached only
    when it changed for this connection. So the last message on its own is not
    the roster - this merges them exactly as the client's ``mergeRoster()`` in
    ``frontend/public/roster.js`` does, which keeps the assertions below about
    what a phone ends up knowing rather than which bytes one message carried.
    """
    merged = {}
    seen = False
    for msg in messages:
        if msg.get("type") != "roster":
            continue
        seen = True
        merged = {
            entry["id"]: {
                **entry,
                "gallery": entry.get("gallery", merged.get(entry["id"], {}).get("gallery", [])),
            }
            for entry in msg["players"]
        }
    return list(merged.values()) if seen else None


def gallery_copies(messages):
    """How many galleries these messages actually put on the wire.

    The regression guard for the fan-out: this used to be one per player per
    roster message, i.e. N x N per scan in an N-player room.
    """
    return sum(
        1
        for msg in messages
        if msg.get("type") == "roster"
        for entry in msg["players"]
        if entry.get("gallery")
    )


async def wait_for(check, timeout=2.0):
    """Poll `check()` until truthy or raise, like the JS suite's waitFor()."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not check():
        if loop.time() > deadline:
            raise AssertionError("Timed out waiting")
        await asyncio.sleep(0.01)


async def read_sse_event(resp, event_type, timeout=2.0):
    """Read lines from an open SSE response until `event_type` appears."""
    buffer = b""

    async def _read():
        nonlocal buffer
        while True:
            chunk = await resp.content.read(1024)
            if not chunk:
                return None
            buffer += chunk
            while b"\n\n" in buffer:
                raw, buffer = buffer.split(b"\n\n", 1)
                lines = raw.decode().split("\n")
                name = next((line[7:] for line in lines if line.startswith("event: ")), None)
                data = next((line[6:] for line in lines if line.startswith("data: ")), None)
                if name == event_type and data:
                    return json.loads(data)

    return await asyncio.wait_for(_read(), timeout)


class PollingClient:
    """A long-polling client like the phone's transport, collecting every
    message it receives into `.messages` - mirrors the JS suite's pollingClient()."""

    def __init__(self, client):
        self.client = client
        self.messages = []
        #: Raw bytes of every poll response body, i.e. what this phone actually
        #: had to pull down. Tests diff it across an action to cost that action.
        self.poll_bytes = 0
        self.token = None
        self._task = None
        #: How the poll loop ended, which is the only way this phone ever learns
        #: that it has lost its session - the real client reconnects on exactly
        #: this signal and on nothing else (frontend/public/transport.js treats
        #: any non-ok response as fatal). ``None`` while the loop is still
        #: running, so a test can tell "still polling" from "told to go away".
        self.closed_status = None
        self.closed_reason = None

    @property
    def closed(self):
        return self.closed_status is not None

    async def start(self):
        resp = await self.client.post("/api/connect")
        self.token = (await resp.json())["token"]
        self._task = asyncio.ensure_future(self._poll_loop())
        return self

    async def _poll_loop(self):
        try:
            while True:
                resp = await self.client.get("/api/poll", params={"token": self.token})
                if resp.status != 200:
                    body = {}
                    try:
                        body = await resp.json()
                    except (ValueError, aiohttp.ContentTypeError):
                        pass
                    self.closed_reason = body.get("reason")
                    self.closed_status = resp.status
                    return
                raw = await resp.read()
                self.poll_bytes += len(raw)
                self.messages.extend(json.loads(raw))
        except asyncio.CancelledError:
            pass

    async def send(self, msg):
        return await self.client.post("/api/send", params={"token": self.token}, json=msg)

    async def disconnect(self, forfeit=False):
        params = {"token": self.token, **({"forfeit": "1"} if forfeit else {})}
        return await self.client.post("/api/disconnect", params=params)

    def stop(self):
        if self._task:
            self._task.cancel()

    def welcome_id(self):
        return next(m["id"] for m in self.messages if m["type"] == "welcome")

    def mark(self):
        """A point in the message history, to ask what arrived after it.

        Used instead of clearing ``messages``, because the roster arrives as a
        delta: what this phone *holds* can only be read from the whole history
        (see :func:`last_roster`), while what an action *cost* it is the slice.
        """
        return len(self.messages)

    def since(self, mark):
        return self.messages[mark:]


class ProtocolTests(AioHTTPTestCase):
    async def get_application(self):
        return create_app()

    async def polling_client(self):
        return await PollingClient(self.client).start()

    async def asyncTearDown(self):
        for client in getattr(self, "_clients", []):
            client.stop()
        await super().asyncTearDown()

    def track(self, client):
        self._clients = getattr(self, "_clients", [])
        self._clients.append(client)
        return client

    async def test_two_players_can_join_see_each_other_and_start(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("join-start")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})

        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        await wait_for(lambda: last_roster(a.messages) and len(last_roster(a.messages)) == 2)
        self.assertTrue(any(m["type"] == "welcome" for m in a.messages))

        await b.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages)["status"] == "countdown")

    async def test_launch_waits_for_every_gallery(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("scan-lobby")
        await a.send({"type": "join", "name": "A", "room": room})
        await b.send({"type": "join", "name": "B", "room": room})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)

        await a.send({"type": "start"})
        await wait_for(lambda: any(
            m["type"] == "error" and m["message"].startswith("Scan everyone before launch")
            for m in a.messages
        ))

        a_id = a.welcome_id()
        b_id = b.welcome_id()
        await a.send({"type": "scan", "targetId": b_id, "gallery": GALLERY})
        await wait_for(lambda: (last_roster(a.messages) or [])
                        and next((p for p in last_roster(a.messages) if p["id"] == b_id), {}).get("gallery") == GALLERY)
        await b.send({"type": "scan", "targetId": a_id, "gallery": GALLERY})
        await wait_for(lambda: last_roster(b.messages) and all(p["gallery"] for p in last_roster(b.messages)))

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages)["status"] == "countdown")

    async def test_remembered_player_id_rejoins_without_duplicate_seat(self):
        first = self.track(await self.polling_client())
        second = self.track(await self.polling_client())
        room = unique_room("reload-rejoin")
        await first.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await wait_for(lambda: any(m["type"] == "welcome" for m in first.messages))
        player_id = first.welcome_id()

        await second.send({"type": "join", "name": "A", "room": room, "playerId": player_id, "gallery": GALLERY})
        await wait_for(lambda: any(m["type"] == "welcome" and m["id"] == player_id for m in second.messages))
        await wait_for(lambda: last_state(second.messages) and len(last_state(second.messages)["players"]) == 1)

        # The seat count was all this used to check, which is why it passed while
        # the displaced phone was being frozen solid: whoever lost the seat has to
        # be *told*, and a 410 is the only thing the client treats as a reason to
        # reconnect (frontend/public/transport.js). A 200 reads as "nothing has
        # happened", so answering one here is what left the first phone sitting on
        # a stale roster forever.
        await wait_for(lambda: first.closed)
        self.assertEqual(first.closed_status, 410)
        self.assertEqual(first.closed_reason, "replaced")

        await first.disconnect()
        await wait_for(lambda: last_state(second.messages) and len(last_state(second.messages)["players"]) == 1)
        # And the displaced phone's goodbye must not take the seat with it: the
        # seat is not its to give up any more.
        self.assertIn(player_id, transport.rooms[registry_code(room)].players)

    async def test_a_second_tab_leaves_the_first_phone_told_rather_than_frozen(self):
        # The second-tab case end to end, which needs no attacker at all:
        # app.js calls resumeActiveLobby() on every page load, so a second tab, a
        # session restore or the home-screen icon adopts the same seat.
        first = self.track(await self.polling_client())
        room = unique_room("second-tab")
        await first.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await wait_for(lambda: any(m["type"] == "welcome" for m in first.messages))
        player_id = first.welcome_id()
        await asyncio.sleep(0.2)  # let the first phone's poll park
        frozen_at = first.mark()

        second = self.track(await self.polling_client())
        await second.send({"type": "join", "name": "A", "room": room, "playerId": player_id})
        await wait_for(lambda: any(m["type"] == "welcome" for m in second.messages))

        # The room then changes under both of them.
        other = self.track(await self.polling_client())
        await other.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(second.messages) and len(last_state(second.messages)["players"]) == 2)

        # The phone that kept the seat sees the new player; the displaced one is
        # told to go away instead of being answered 200 with an empty list.
        self.assertTrue(first.closed, "the displaced phone was never told it lost the seat")
        self.assertEqual(first.closed_status, 410)
        self.assertEqual(first.closed_reason, "replaced")
        self.assertEqual(first.since(frozen_at), [], "nothing more should have been pushed to it")

    async def test_a_poll_parked_when_the_seat_is_taken_is_told_on_that_response(self):
        # Not merely eventually. A poll can sit parked here for 20 s, and the
        # handler checks liveness again after the park for two reasons: the phone
        # learns on this response instead of needing another round trip, and
        # nothing still queued can be handed to a session that no longer exists.
        # The entry check alone would answer this woken poll 200 and only 410 the
        # next one, which is why driving a raw parked poll is the only way to see
        # the difference - a PollingClient just polls again and cannot tell.
        room = unique_room("parked-410")
        token = (await (await self.client.post("/api/connect")).json())["token"]
        await self.client.post("/api/send", params={"token": token},
                               json={"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        drained = await (await self.client.get("/api/poll", params={"token": token})).json()
        player_id = next(msg["id"] for msg in drained if msg["type"] == "welcome")

        parked = asyncio.ensure_future(self.client.get("/api/poll", params={"token": token}))
        await asyncio.sleep(0.2)  # let it park on an empty mailbox

        second = self.track(await self.polling_client())
        await second.send({"type": "join", "name": "A", "room": room, "playerId": player_id})
        await wait_for(lambda: any(msg["type"] == "welcome" for msg in second.messages))

        resp = await asyncio.wait_for(parked, 3)
        self.assertEqual(resp.status, 410, "the woken poll itself must answer 410, not 200")
        self.assertEqual((await resp.json())["reason"], "replaced")

    async def test_a_dropped_connection_reconnects_to_the_same_seat_and_hp(self):
        # The other half of the displacement decision: a phone whose connection
        # died - no /api/disconnect, just silence - must still get its seat back,
        # with the hp and wins it had. This is the common real case, and it is why
        # the adoption is honoured rather than refused.
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("dropped-reconnect")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        a_id, b_id = a.welcome_id(), b.welcome_id()

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)
        await self.client.post("/api/hit", json={"room": room, "shooterId": a_id, "targetId": b_id, "zone": "body"})
        await wait_for(lambda: next(p for p in last_state(b.messages)["players"] if p["id"] == b_id)["hp"] == 80)

        b.stop()  # the connection simply stops, the way a phone losing wifi does
        resumed = self.track(await self.polling_client())
        await resumed.send({"type": "join", "name": "B", "room": room, "playerId": b_id})
        await wait_for(lambda: any(m["type"] == "welcome" and m["id"] == b_id for m in resumed.messages), 5)
        await wait_for(lambda: last_state(resumed.messages), 5)

        state = last_state(resumed.messages)
        self.assertEqual(len(state["players"]), 2, "a reconnect must not take a second seat")
        self.assertEqual(next(p for p in state["players"] if p["id"] == b_id)["hp"], 80,
                         "the reconnecting phone lost the hp it had")
        self.assertFalse(resumed.closed)
        # And it lands on a complete roster, never a partial one.
        await wait_for(lambda: (last_roster(resumed.messages) or []) and len(last_roster(resumed.messages)) == 2, 5)
        self.assertTrue(all(p["gallery"] for p in last_roster(resumed.messages)))

    async def test_disconnect_removes_a_lobby_player_immediately(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("leave-lobby")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)

        await b.disconnect()
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 1)
        self.assertEqual(last_state(a.messages)["players"][0]["name"], "A")

    async def test_forfeiting_mid_round_is_a_death_and_cannot_be_resumed(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        c = self.track(await self.polling_client())
        room = unique_room("forfeit")
        for client, name in ((a, "A"), (b, "B"), (c, "C")):
            await client.send({"type": "join", "name": name, "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 3)
        b_id = b.welcome_id()
        events_resp = await self.client.get(f"/events/{room}")

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)
        await b.disconnect(forfeit=True)

        event = await read_sse_event(events_resp, "death")
        self.assertEqual((event["playerId"], event["killerId"]), (b_id, None))
        await wait_for(lambda: next((p for p in last_state(a.messages)["players"] if p["id"] == b_id), {}).get("forfeited"))
        self.assertEqual(last_state(a.messages)["status"], "playing")

        rejoin = self.track(await self.polling_client())
        await rejoin.send({"type": "join", "name": "B", "room": room, "playerId": b_id, "gallery": GALLERY})
        await wait_for(lambda: any(m["type"] == "error" for m in rejoin.messages))
        self.assertFalse(any(m["type"] == "welcome" for m in rejoin.messages))

    async def test_debug_clone_receives_the_local_players_scan(self):
        debug = self.track(await self.polling_client())
        room = unique_room("clone-scan-lobby")
        await debug.send({"type": "join", "name": "Debug", "room": room, "debug": True})
        await wait_for(lambda: last_state(debug.messages) and len(last_state(debug.messages)["players"]) == 2)
        debug_id = debug.welcome_id()
        clone = next(p for p in last_state(debug.messages)["players"] if p["id"] != debug_id)

        await debug.send({"type": "scan", "targetId": debug_id, "gallery": GALLERY})
        await wait_for(lambda: last_roster(debug.messages)
                        and next((p for p in last_roster(debug.messages) if p["id"] == debug_id), {}).get("gallery")
                        and next((p for p in last_roster(debug.messages) if p["id"] == clone["id"]), {}).get("gallery"))

    async def test_debug_clone_mirrors_a_scan_taken_by_another_device(self):
        debug = self.track(await self.polling_client())
        scanner = self.track(await self.polling_client())
        room = unique_room("clone-remote-scan")
        await debug.send({"type": "join", "name": "Debug", "room": room, "debug": True})
        await scanner.send({"type": "join", "name": "Scanner", "room": room})
        await wait_for(lambda: last_state(debug.messages) and len(last_state(debug.messages)["players"]) == 3)

        debug_id = debug.welcome_id()
        clone = next(p for p in last_state(debug.messages)["players"] if p["id"] != debug_id and p["name"] == "Debug clone")
        await scanner.send({"type": "scan", "targetId": debug_id, "gallery": GALLERY})
        await wait_for(lambda: last_roster(debug.messages)
                        and next((p for p in last_roster(debug.messages) if p["id"] == debug_id), {}).get("gallery")
                        and next((p for p in last_roster(debug.messages) if p["id"] == clone["id"]), {}).get("gallery"))

    async def test_clearing_a_scan_tells_everyone_and_unscans_the_player(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("clear-scan")
        await a.send({"type": "join", "name": "A", "room": room})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        b_id = b.welcome_id()

        await a.send({"type": "clearScan", "targetId": b_id})
        await wait_for(lambda: any(m["type"] == "scanCleared" and m["targetId"] == b_id for m in b.messages))
        await wait_for(lambda: last_roster(a.messages)
                        and next((p for p in last_roster(a.messages) if p["id"] == b_id), {}).get("gallery") == [])

    async def test_eight_players_can_fill_a_room_and_start_together(self):
        room = unique_room("eight-player-room")
        clients = [self.track(await self.polling_client()) for _ in range(9)]
        players, extra = clients[:8], clients[8]

        await asyncio.gather(*(
            c.send({"type": "join", "name": f"P{i + 1}", "room": room, "gallery": GALLERY})
            for i, c in enumerate(players)
        ))
        await wait_for(lambda: last_state(players[0].messages) and len(last_state(players[0].messages)["players"]) == 8, 3)
        await wait_for(lambda: last_roster(players[0].messages) and len(last_roster(players[0].messages)) == 8, 3)

        await extra.send({"type": "join", "name": "Extra", "room": room, "gallery": GALLERY})
        await wait_for(lambda: any(m["type"] == "error" and m["message"] == "Room is full" for m in extra.messages))

        await players[0].send({"type": "start"})
        await wait_for(lambda: last_state(players[7].messages) and last_state(players[7].messages)["status"] == "playing", 7)
        self.assertEqual(len(last_state(players[7].messages)["players"]), 8)

    async def test_a_held_poll_is_answered_as_soon_as_a_message_arrives(self):
        a = self.track(await self.polling_client())
        room = unique_room("latency")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await wait_for(lambda: len(a.messages) > 0)
        before = len(a.messages)

        b = self.track(await self.polling_client())
        loop = asyncio.get_event_loop()
        sent_at = loop.time()
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: len(a.messages) > before)
        self.assertLess(loop.time() - sent_at, 1.0, "update should arrive without waiting for the poll timeout")

    async def test_unknown_polling_sessions_are_told_to_reconnect(self):
        poll = await self.client.get("/api/poll", params={"token": "nope"})
        self.assertEqual(poll.status, 410)
        send = await self.client.post("/api/send", params={"token": "nope"}, json={})
        self.assertEqual(send.status, 410)

    async def test_posted_hit_damage_and_confirmation_travel_over_polling(self):
        # The real client never sends a session "shoot" message (see test_protocol module
        # docstring) - it posts /api/hit directly and the result reaches both players through
        # their own poll loops. This is that path, not the session message one.
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("shoot")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        a_id, b_id = a.welcome_id(), b.welcome_id()

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)
        hit_resp = await self.client.post("/api/hit", json={"room": room, "shooterId": a_id, "targetId": b_id, "zone": "body"})
        self.assertEqual(hit_resp.status, 200)

        await wait_for(lambda: any(m["type"] == "hitConfirmed" for m in a.messages))
        confirmed = next(m for m in a.messages if m["type"] == "hitConfirmed")
        self.assertEqual((confirmed["targetId"], confirmed["hp"]), (b_id, 80))
        await wait_for(lambda: any(m["type"] == "gotHit" for m in b.messages))
        await wait_for(lambda: next(p for p in last_state(b.messages)["players"] if p["id"] == b_id)["hp"] == 80)

    async def test_a_posted_miss_counts_as_a_shot_and_tells_nobody(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("miss")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        a_id, b_id = a.welcome_id(), b.welcome_id()
        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)

        miss = await self.client.post("/api/hit", json={"room": room, "shooterId": a_id, "targetId": None, "zone": None})
        self.assertEqual(miss.status, 200)
        self.assertEqual(await miss.json(), {"ok": True, "hit": False})
        await asyncio.sleep(0.38)
        await self.client.post("/api/hit", json={"room": room, "shooterId": a_id, "targetId": b_id, "zone": "head"})

        await wait_for(lambda: next(p for p in last_state(a.messages)["players"] if p["id"] == a_id)["stats"]["shots"] == 2)
        stats = next(p for p in last_state(a.messages)["players"] if p["id"] == a_id)["stats"]
        self.assertEqual((stats["hits"], stats["headshots"], stats["damage"]), (1, 1, 50))
        await wait_for(lambda: any(m["type"] == "gotHit" for m in b.messages))
        self.assertEqual(sum(m["type"] == "hitConfirmed" for m in a.messages), 1)
        self.assertEqual(sum(m["type"] == "gotHit" for m in b.messages), 1)

    async def test_three_players_can_play_a_free_for_all_to_one_winner(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        c = self.track(await self.polling_client())
        room = unique_room("free-for-all")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await c.send({"type": "join", "name": "C", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 3)
        await wait_for(lambda: last_roster(a.messages) and len(last_roster(a.messages)) == 3)
        a_id, b_id, c_id = a.welcome_id(), b.welcome_id(), c.welcome_id()

        async def hit(shooter_id, target_id):
            return await self.client.post("/api/hit", json={"room": room, "shooterId": shooter_id, "targetId": target_id, "zone": "head"})

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)
        await hit(a_id, b_id)
        await hit(c_id, b_id)
        await wait_for(lambda: last_state(a.messages)["status"] == "playing"
                        and next(p for p in last_state(a.messages)["players"] if p["id"] == b_id)["alive"] is False)

        await asyncio.sleep(0.38)
        await hit(a_id, c_id)
        await asyncio.sleep(0.38)
        await hit(a_id, c_id)

        await wait_for(lambda: last_state(a.messages)["status"] == "over")
        self.assertEqual(last_state(a.messages)["winner"], a_id)
        self.assertEqual(next(p for p in last_state(a.messages)["players"] if p["id"] == a_id)["wins"], 1)

    async def test_posted_hits_emit_health_updates_over_sse(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("posted-hit")
        await a.send({"type": "join", "name": "A", "room": room, "gallery": GALLERY})
        await b.send({"type": "join", "name": "B", "room": room, "gallery": GALLERY})
        await wait_for(lambda: last_state(a.messages) and len(last_state(a.messages)["players"]) == 2)
        a_id, b_id = a.welcome_id(), b.welcome_id()

        events_resp = await self.client.get(f"/events/{room}")
        self.assertEqual(events_resp.status, 200)

        await a.send({"type": "start"})
        await wait_for(lambda: last_state(a.messages) and last_state(a.messages)["status"] == "playing", 7)
        hit_resp = await self.client.post(
            "/api/hit",
            json={"room": room, "shooterId": a_id, "targetId": b_id, "zone": "body"},
        )
        self.assertEqual(hit_resp.status, 200)
        self.assertEqual((await hit_resp.json())["hp"], 80)

        event = await read_sse_event(events_resp, "health")
        self.assertEqual(event["shooterId"], a_id)
        self.assertEqual(event["targetId"], b_id)
        self.assertEqual(event["hp"], 80)
        await wait_for(lambda: any(m["type"] == "gotHit" for m in b.messages))

    async def test_debug_session_gets_a_targetable_clone_instead_of_self_hits(self):
        debug = self.track(await self.polling_client())
        room = unique_room("clone-hit")
        await debug.send({"type": "join", "name": "Debug", "room": room, "gallery": GALLERY, "debug": True})
        await wait_for(lambda: last_state(debug.messages) and len(last_state(debug.messages)["players"]) == 2)
        debug_id = debug.welcome_id()
        clone = next(p for p in last_state(debug.messages)["players"] if p["id"] != debug_id)
        self.assertEqual(clone["name"], "Debug clone")
        await wait_for(lambda: last_roster(debug.messages)
                        and next((p for p in last_roster(debug.messages) if p["id"] == clone["id"]), {}).get("gallery"))

        await debug.send({"type": "start"})
        await wait_for(lambda: last_state(debug.messages) and last_state(debug.messages)["status"] == "playing", 7)

        self_hit = await self.client.post("/api/hit", json={"room": room, "shooterId": debug_id, "targetId": debug_id, "zone": "body"})
        self.assertEqual(self_hit.status, 400)
        self.assertEqual(next(p for p in last_state(debug.messages)["players"] if p["id"] == debug_id)["hp"], 100)

        clone_hit = await self.client.post("/api/hit", json={"room": room, "shooterId": debug_id, "targetId": clone["id"], "zone": "body"})
        self.assertEqual(clone_hit.status, 200)
        await wait_for(lambda: next(p for p in last_state(debug.messages)["players"] if p["id"] == clone["id"])["hp"] == 80)

    async def roster_room(self, label, count, gallery=FULL_GALLERY):
        """``count`` enrolled players in a fresh room, settled and quiet.

        The fan-out tests all start from a steady state so that what they measure
        afterwards is the cost of one further change and nothing else.
        """
        room = unique_room(label)
        clients = [self.track(await self.polling_client()) for _ in range(count)]
        for i, client in enumerate(clients):
            await client.send({"type": "join", "name": f"P{i}", "room": room, "gallery": gallery})
        await wait_for(
            lambda: all(
                (last_roster(c.messages) or []) and len(last_roster(c.messages)) == count
                and all(p["gallery"] for p in last_roster(c.messages))
                for c in clients
            ),
            5,
        )
        await asyncio.sleep(0.2)  # let the poll loops come back round and go quiet
        return room, clients

    def held_gallery(self, client, player_id):
        """What this phone currently believes ``player_id`` looks like."""
        return next((p["gallery"] for p in last_roster(client.messages) or [] if p["id"] == player_id), None)

    async def test_a_scan_reaches_every_phone_without_re_sending_the_whole_room(self):
        # The fan-out regression guard. A scan changes exactly one player's gallery, so it should
        # cost the room one copy of that gallery per phone. Re-sending the whole roster to
        # everyone instead cost N x N copies - 16 here, and ~7.8 MB for six players.
        room, clients = await self.roster_room("fanout-scan", 4)
        ids = [c.welcome_id() for c in clients]
        before = [c.poll_bytes for c in clients]
        marks = [c.mark() for c in clients]

        await clients[0].send({"type": "scan", "targetId": ids[1], "gallery": RESCAN_GALLERY})
        await wait_for(lambda: all(self.held_gallery(c, ids[1]) == RESCAN_GALLERY for c in clients), 5)
        await asyncio.sleep(0.2)

        # The behaviour: every phone, the scanner included, now holds the new scan, and still
        # holds everyone else's.
        for i, client in enumerate(clients):
            held = last_roster(client.messages)
            self.assertEqual(len(held), 4, f"phone {i} lost track of the room")
            self.assertTrue(all(p["gallery"] for p in held), f"phone {i} lost a gallery it had")
            self.assertEqual(self.held_gallery(client, ids[1]), RESCAN_GALLERY)

        # The cost: one gallery per phone, not one per phone per player.
        copies = sum(gallery_copies(c.since(m)) for c, m in zip(clients, marks))
        self.assertEqual(copies, 4, "a scan should put one gallery on each phone's wire, no more")
        self.assertEqual(gallery_copies(clients[0].since(marks[0])), 1, "the scanner is not sent the room again")

        # And the same claim in bytes, which is what the phones actually wait for.
        spent = sum(c.poll_bytes - b for c, b in zip(clients, before))
        self.assertLess(spent, 6 * GALLERY_BYTES, f"a scan cost {spent / GALLERY_BYTES:.1f} galleries, expected ~4")
        scanner_spent = clients[0].poll_bytes - before[0]
        self.assertLess(scanner_spent, 2 * GALLERY_BYTES, "the scanning phone waits on its own scan only")

    async def test_an_unchanged_gallery_is_not_re_sent_when_the_room_changes(self):
        # Joins and leaves broadcast the roster too. They must update membership without
        # re-shipping scans every phone already has.
        room, clients = await self.roster_room("fanout-membership", 2)
        watcher = clients[0]
        before = watcher.poll_bytes
        mark = watcher.mark()

        joiner = self.track(await self.polling_client())
        await joiner.send({"type": "join", "name": "C", "room": room, "gallery": RESCAN_GALLERY})
        await wait_for(lambda: (last_roster(watcher.messages) or []) and len(last_roster(watcher.messages)) == 3, 5)
        await asyncio.sleep(0.2)
        self.assertEqual(gallery_copies(watcher.since(mark)), 1, "only the newcomer's gallery is new")
        self.assertTrue(all(p["gallery"] for p in last_roster(watcher.messages)))

        mark = watcher.mark()
        await joiner.disconnect()
        await wait_for(lambda: (last_roster(watcher.messages) or []) and len(last_roster(watcher.messages)) == 2, 5)
        await asyncio.sleep(0.2)
        self.assertEqual(gallery_copies(watcher.since(mark)), 0, "nobody's scan changed, so no gallery travels")
        self.assertTrue(all(p["gallery"] for p in last_roster(watcher.messages)))
        self.assertLess(watcher.poll_bytes - before, 3 * GALLERY_BYTES)

    async def test_a_reconnecting_phone_is_sent_the_whole_roster(self):
        # The convergence guarantee. A phone that drops its connection has no idea which
        # galleries it missed, so the reconnect has to arrive complete - and it does, because the
        # delta is remembered per session and a reconnect is a new session.
        room, clients = await self.roster_room("fanout-resume", 3)
        ids = [c.welcome_id() for c in clients]
        lost = clients[2]

        # While it is away, somebody rescans: the gallery it last held goes stale.
        lost.stop()
        await clients[0].send({"type": "scan", "targetId": ids[1], "gallery": RESCAN_GALLERY})
        await wait_for(lambda: self.held_gallery(clients[0], ids[1]) == RESCAN_GALLERY, 5)

        resumed = self.track(await self.polling_client())
        await resumed.send({"type": "join", "name": "P2", "room": room, "playerId": ids[2]})
        await wait_for(lambda: any(m["type"] == "welcome" and m["id"] == ids[2] for m in resumed.messages), 5)
        await wait_for(lambda: (last_roster(resumed.messages) or []) and len(last_roster(resumed.messages)) == 3, 5)

        held = last_roster(resumed.messages)
        self.assertTrue(all(p["gallery"] for p in held), "a reconnect must not land on a partial roster")
        self.assertEqual(self.held_gallery(resumed, ids[1]), RESCAN_GALLERY, "and not on a stale one")
        # It had nothing to start from, so it was sent all three in full.
        self.assertEqual(gallery_copies(resumed.messages), 3)

    async def test_a_rescan_replaces_the_gallery_every_phone_holds(self):
        # Two scans of the same player back to back. Per-connection bookkeeping means the second
        # cannot be mistaken for "they already have this", and the phones cannot settle on the
        # first one.
        room, clients = await self.roster_room("fanout-rescan", 3)
        ids = [c.welcome_id() for c in clients]

        await clients[0].send({"type": "scan", "targetId": ids[1], "gallery": full_gallery(3)})
        await clients[2].send({"type": "scan", "targetId": ids[1], "gallery": RESCAN_GALLERY})
        await wait_for(lambda: all(self.held_gallery(c, ids[1]) == RESCAN_GALLERY for c in clients), 5)
        for client in clients:
            self.assertEqual(len(last_roster(client.messages)), 3)
            self.assertTrue(all(p["gallery"] for p in last_roster(client.messages)))

    async def test_a_rescanned_owner_updates_the_clone_on_every_phone(self):
        # The debug clone borrows its owner's gallery, so its entry has to change when the
        # owner's scan does even though nothing was ever stored against the clone itself
        # (Room.mirrored_gallery_rev). Two devices, so this also covers the remote scanner.
        room = unique_room("fanout-clone")
        debug = self.track(await self.polling_client())
        scanner = self.track(await self.polling_client())
        await debug.send({"type": "join", "name": "Debug", "room": room, "gallery": FULL_GALLERY, "debug": True})
        await scanner.send({"type": "join", "name": "Scanner", "room": room, "gallery": FULL_GALLERY})
        await wait_for(lambda: all((last_roster(c.messages) or []) and len(last_roster(c.messages)) == 3
                                   for c in (debug, scanner)), 5)
        debug_id = debug.welcome_id()
        clone_id = f"{debug_id}:debug-clone"
        await asyncio.sleep(0.2)
        marks = {client: client.mark() for client in (debug, scanner)}

        await scanner.send({"type": "scan", "targetId": debug_id, "gallery": RESCAN_GALLERY})
        await wait_for(lambda: all(self.held_gallery(c, clone_id) == RESCAN_GALLERY for c in (debug, scanner)), 5)
        for client in (debug, scanner):
            self.assertEqual(self.held_gallery(client, debug_id), RESCAN_GALLERY)
            self.assertEqual(self.held_gallery(client, clone_id), RESCAN_GALLERY)
            self.assertTrue(all(p["gallery"] for p in last_roster(client.messages)))
        # Owner and clone each need their copy, and the clone has no connection of its own, so
        # two phones x two changed entries.
        self.assertEqual(sum(gallery_copies(c.since(marks[c])) for c in (debug, scanner)), 4)

    async def test_motion_samples_are_cleaned_and_relayed_to_others_only(self):
        a = self.track(await self.polling_client())
        b = self.track(await self.polling_client())
        room = unique_room("motion-relay")
        await a.send({"type": "join", "name": "A", "room": room})
        await b.send({"type": "join", "name": "B", "room": room})
        await wait_for(lambda: any(m["type"] == "welcome" for m in a.messages) and any(m["type"] == "welcome" for m in b.messages))
        a_id = a.welcome_id()

        await a.send({"type": "motion", "s": [[1000, 1.234], [1100, "x"], [1200, -1], "bad", [1300, 0.5]]})
        await wait_for(lambda: any(m["type"] == "motion" for m in b.messages))
        relay = next(m for m in b.messages if m["type"] == "motion")
        self.assertEqual(relay["from"], a_id)
        self.assertEqual(relay["s"], [[1000, 1.23], [1300, 0.5]])

        await asyncio.sleep(0.05)
        self.assertFalse(any(m["type"] == "motion" for m in a.messages))

    async def test_posted_hit_with_a_non_object_body_is_a_clean_400(self):
        # Valid JSON is not necessarily an object. Each of these used to reach
        # msg.get("shooterId") and answer 500 with an AttributeError traceback;
        # it is a one-byte request.
        for body in ("[]", '"x"', "5", "null", "true", '[{"shooterId":"a"}]'):
            with self.subTest(body=body):
                resp = await self.client.post("/api/hit", data=body,
                                              headers={"Content-Type": "application/json"})
                self.assertEqual(resp.status, 400, f"{body} should be a clean 400")
                self.assertEqual(resp.content_type, "application/json")
                self.assertFalse((await resp.json())["ok"])

    async def test_an_oversized_or_malformed_body_is_one_json_shape_either_way(self):
        # Two things used to disagree about the boundary: the explicit check used
        # `>` while aiohttp's client_max_size rejects at `>=`, so a body of
        # exactly MAX_BODY_BYTES fell through to aiohttp and got a plain-text 413
        # while one byte more got a JSON one. A chunked body has no
        # Content-Length at all and only aiohttp ever saw it.
        a = self.track(await self.polling_client())

        def padded(size):
            body = b'{"type":"x","pad":"' + b"a" * (size - 21) + b'"}'
            assert len(body) == size
            return body

        for size in (MAX_BODY_BYTES, MAX_BODY_BYTES + 1):
            with self.subTest(declared=size):
                resp = await self.client.post("/api/send", params={"token": a.token},
                                              data=padded(size),
                                              headers={"Content-Type": "application/json"})
                self.assertEqual(resp.status, 413)
                self.assertEqual(resp.content_type, "application/json")
                self.assertEqual((await resp.json())["error"], "Body too large")

        async def chunked():
            yield padded(MAX_BODY_BYTES + 100)

        resp = await self.client.post("/api/send", params={"token": a.token}, data=chunked(),
                                      headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 413, "a chunked oversized body is still a 413")
        self.assertEqual(resp.content_type, "application/json", "and the same shape as a declared one")

        # A body one byte under the limit is a perfectly ordinary message.
        resp = await self.client.post("/api/send", params={"token": a.token},
                                      data=padded(MAX_BODY_BYTES - 1),
                                      headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 204)

        # Malformed JSON is the only thing left that is a 400.
        resp = await self.client.post("/api/send", params={"token": a.token}, data=b"{nope",
                                      headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)
        self.assertEqual((await resp.json())["error"], "Invalid JSON body")

    async def test_an_sse_listener_is_forgotten_when_it_disconnects(self):
        # Room codes are client-chosen, so a {room_code: set()} entry that outlives
        # its listeners grows for the lifetime of the process, one request per key.
        room = unique_room("sse-leak")
        key = registry_code(room)
        self.assertNotIn(key, transport.sse_clients)

        resp = await self.client.get(f"/events/{room}")
        await resp.content.read(len(b": connected\n\n"))
        self.assertEqual(len(transport.sse_clients[key]), 1)

        resp.close()
        await wait_for(lambda: key not in transport.sse_clients, 5)

    async def test_the_server_never_withholds_a_gallery_it_has_not_sent(self):
        # The roster delta's one load-bearing assumption, checked against an
        # independent oracle: sent_gallery_revs is the server's belief about what
        # each phone holds, and client.messages is what that phone actually
        # received. Every id the server has stopped sending a gallery for must be
        # one the phone really has a gallery for.
        room, clients = await self.roster_room("delta-oracle", 3)
        ids = [c.welcome_id() for c in clients]

        await clients[0].send({"type": "scan", "targetId": ids[1], "gallery": RESCAN_GALLERY})
        await clients[2].send({"type": "scan", "targetId": ids[2], "gallery": full_gallery(4)})
        await wait_for(lambda: all(self.held_gallery(c, ids[1]) == RESCAN_GALLERY for c in clients), 5)
        await asyncio.sleep(0.3)

        for i, (client, player_id) in enumerate(zip(clients, ids)):
            believed = transport.connections[player_id].sent_gallery_revs
            held = {entry["id"]: entry["gallery"] for entry in last_roster(client.messages)}
            self.assertTrue(believed, f"phone {i}: the server should be withholding something by now")
            for claimed_id in believed:
                self.assertTrue(
                    held.get(claimed_id),
                    f"phone {i} holds no gallery for {claimed_id}, but the server believes it sent one",
                )

    async def test_a_phone_whose_mailbox_overflows_reconnects_complete(self):
        # The queue cap's overflow policy, and the half of it that matters: a
        # phone that has had messages dropped must end up *correct*, not subtly
        # stale. Overflow ends the conversation and clears the delivery record, so
        # the reconnect is sent every gallery again rather than being told to keep
        # what it never got.
        room, clients = await self.roster_room("overflow-resync", 3)
        ids = [c.welcome_id() for c in clients]
        victim, player_id = clients[2], ids[2]
        poller = transport.pollers[victim.token]
        session = transport.connections[player_id]
        self.assertTrue(session.sent_gallery_revs, "the delta should be active before we start")

        victim.stop()  # stop draining, the way a locked screen does
        await asyncio.sleep(0.1)
        for _ in range(transport.MAX_QUEUED_MESSAGES + 5):
            await poller.push({"type": "roster", "players": []})

        self.assertEqual(poller.evicted, "overflow")
        self.assertEqual(poller.queue, [], "an evicted mailbox is never drained, so it holds nothing")
        self.assertEqual(session.sent_gallery_revs, {},
                         "dropping queued rosters must invalidate what the server believes it sent")

        # The phone finds out by being told 410, and comes back to a full roster.
        resp = await self.client.get("/api/poll", params={"token": victim.token})
        self.assertEqual(resp.status, 410)
        self.assertEqual((await resp.json())["reason"], "overflow")
        # Nothing it sends is accepted either, so it cannot keep acting on a
        # conversation the server has stopped having.
        resp = await self.client.post("/api/send", params={"token": victim.token},
                                      json={"type": "start"})
        self.assertEqual(resp.status, 410)

        resumed = self.track(await self.polling_client())
        await resumed.send({"type": "join", "name": "P2", "room": room, "playerId": player_id})
        await wait_for(lambda: (last_roster(resumed.messages) or []) and len(last_roster(resumed.messages)) == 3, 5)
        self.assertTrue(all(p["gallery"] for p in last_roster(resumed.messages)),
                        "a phone that missed messages must not land on a partial roster")
        self.assertEqual(gallery_copies(resumed.messages), 3)


if __name__ == "__main__":
    unittest.main()
