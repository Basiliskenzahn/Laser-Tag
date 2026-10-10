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

from aiohttp.test_utils import AioHTTPTestCase, TestClient, TestServer

from backend.app import create_app

GALLERY = [{"hist": [1, 0], "grid": [0, 1]}]


def unique_room(label):
    return f"{label}-{uuid.uuid4().hex[:8]}"


def last_state(messages):
    states = [m["state"] for m in messages if m.get("type") == "state"]
    return states[-1] if states else None


def last_roster(messages):
    rosters = [m for m in messages if m.get("type") == "roster"]
    return rosters[-1]["players"] if rosters else None


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
        self.token = None
        self._task = None

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
                    return
                self.messages.extend(await resp.json())
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

        await first.disconnect()
        await wait_for(lambda: last_state(second.messages) and len(last_state(second.messages)["players"]) == 1)

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


if __name__ == "__main__":
    unittest.main()
