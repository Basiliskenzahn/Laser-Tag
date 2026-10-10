import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field

from aiohttp import web


MIN_PLAYERS = 2
MAX_PLAYERS = 8
MAX_HP = 100
DAMAGE = {"body": 20, "head": 50}
SHOT_COOLDOWN_MS = 350
COUNTDOWN_MS = 5000
POLL_WAIT_MS = 20_000
POLL_EXPIRY_MS = 30_000
MAX_BODY_BYTES = 256 * 1024


@dataclass
class Player:
    id: str
    name: str
    gallery: list
    hp: int = MAX_HP
    wins: int = 0
    alive: bool = True
    last_shot_at: float = float("-inf")


class Room:
    def __init__(self, code):
        self.code = code
        self.players = {}
        self.status = "waiting"
        self.starts_at = None
        self.winner = None
        self.start_timer = None

    @property
    def is_empty(self):
        return not self.players

    def now(self):
        return time.time() * 1000

    def join(self, player_id, name, gallery=None):
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Lobby is already running."}
        if len(self.players) >= MAX_PLAYERS:
            return {"ok": False, "error": "Room is full"}
        self.players[player_id] = Player(player_id, name, gallery or [])
        return {"ok": True}

    def clone_owner_id(self, player_id):
        suffix = ":debug-clone"
        return player_id[:-len(suffix)] if isinstance(player_id, str) and player_id.endswith(suffix) else None

    def mirrored_gallery(self, player):
        owner_id = self.clone_owner_id(player.id)
        if owner_id and owner_id in self.players:
            return self.players[owner_id].gallery
        return player.gallery

    def set_gallery(self, player_id, gallery):
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Round already running"}
        player = self.players.get(player_id)
        if not player:
            return {"ok": False, "error": "Unknown player"}
        if not gallery:
            return {"ok": False, "error": "Scan did not contain enough samples"}
        player.gallery = gallery
        owner_id = self.clone_owner_id(player_id)
        if owner_id and owner_id in self.players:
            self.players[owner_id].gallery = gallery
        clone_id = f"{player_id}:debug-clone"
        if clone_id in self.players:
            self.players[clone_id].gallery = gallery
        return {"ok": True}

    def unscanned_players(self):
        return [
            player
            for player in self.players.values()
            if not self.clone_owner_id(player.id) and not self.mirrored_gallery(player)
        ]

    def reset_round(self):
        self.status = "waiting"
        self.starts_at = None
        self.winner = None
        for player in self.players.values():
            player.hp = MAX_HP
            player.alive = True

    def finish_if_decided(self):
        survivors = [player for player in self.players.values() if player.alive]
        if len(survivors) > 1:
            return
        self.status = "over"
        self.winner = survivors[0].id if survivors else None
        if self.winner:
            self.players[self.winner].wins += 1

    def leave(self, player_id):
        if player_id not in self.players:
            return
        del self.players[player_id]
        if self.status == "playing":
            self.finish_if_decided()
        elif self.status == "countdown" and len(self.players) < MIN_PLAYERS:
            self.reset_round()
        elif self.status == "over" and (not self.winner or self.winner not in self.players):
            self.reset_round()

    def start(self):
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Round already running"}
        if len(self.players) < MIN_PLAYERS:
            return {"ok": False, "error": "Need at least two players"}
        missing = self.unscanned_players()
        if missing:
            names = ", ".join(player.name for player in missing[:3])
            if len(missing) > 3:
                names += f" +{len(missing) - 3}"
            return {"ok": False, "error": f"Scan everyone before launch: {names}"}
        for player in self.players.values():
            player.hp = MAX_HP
            player.alive = True
        self.winner = None
        self.status = "countdown"
        self.starts_at = self.now() + COUNTDOWN_MS
        return {"ok": True}

    def update(self):
        if self.status == "countdown" and self.starts_at is not None and self.now() >= self.starts_at:
            self.status = "playing"
            self.starts_at = None

    def shoot(self, shooter_id, target_id, zone):
        self.update()
        shooter = self.players.get(shooter_id)
        target = self.players.get(target_id)
        if not shooter or not target:
            return {"ok": False, "error": "Unknown player"}
        if target.id == shooter.id:
            return {"ok": False, "error": "Can't target yourself"}
        if self.status != "playing":
            return {"ok": False, "error": "Round not running"}
        if not shooter.alive or not target.alive:
            return {"ok": False, "error": "Target is down"}
        if zone not in DAMAGE:
            return {"ok": False, "error": "Unknown zone"}

        now = self.now()
        if now - shooter.last_shot_at < SHOT_COOLDOWN_MS:
            return {"ok": False, "error": "Cooldown"}
        shooter.last_shot_at = now

        damage = DAMAGE[zone]
        target.hp = max(0, target.hp - damage)
        ko = target.hp == 0
        if ko:
            target.alive = False
            self.finish_if_decided()
        return {
            "ok": True,
            "victimId": target.id,
            "damage": damage,
            "zone": zone,
            "ko": ko,
            "hp": target.hp,
            "alive": target.alive,
        }

    def snapshot(self):
        self.update()
        return {
            "code": self.code,
            "status": self.status,
            "startsInMs": None if self.starts_at is None else max(0, self.starts_at - self.now()),
            "winner": self.winner,
            "maxHp": MAX_HP,
            "minPlayers": MIN_PLAYERS,
            "maxPlayers": MAX_PLAYERS,
            "players": [
                {
                    "id": player.id,
                    "name": player.name,
                    "hp": player.hp,
                    "wins": player.wins,
                    "alive": player.alive,
                }
                for player in self.players.values()
            ],
        }

    def roster(self):
        return [
            {"id": player.id, "name": player.name, "gallery": self.mirrored_gallery(player)}
            for player in self.players.values()
        ]


@dataclass
class Poller:
    queue: list = field(default_factory=list)
    last_seen: float = field(default_factory=lambda: time.time() * 1000)
    waiter: asyncio.Future | None = None
    session: object = None


rooms = {}
connections = {}
pollers = {}
sse_clients = {}
GALLERY_FIELDS = (
    ("hist", 64, True),
    ("grid", 256, True),
    ("lower", 64, False),
    ("shape", 8, False),
    ("embed", 512, False),
)


def clean_room_code(code):
    cleaned = "".join(ch for ch in str(code or "demo").lower() if ch.isalnum() or ch == "-")[:16]
    return cleaned or "demo"


def clean_name(name):
    return str(name or "").strip()[:20] or "Player"


def clean_player_id(player_id):
    value = str(player_id or "").strip()
    if 8 <= len(value) <= 80 and all(char.isalnum() or char in ":-" for char in value):
        return value
    return ""


def clean_vector(vector, max_len):
    if not isinstance(vector, list):
        return []
    clean = []
    for value in vector[:max_len]:
        try:
            clean.append(float(value))
        except (TypeError, ValueError):
            pass
    return clean


def clean_gallery(gallery):
    if not isinstance(gallery, list):
        return []
    clean = []
    for sample in gallery[:24]:
        if not isinstance(sample, dict):
            continue
        item = {}
        for field, max_len, required in GALLERY_FIELDS:
            vector = clean_vector(sample.get(field), max_len)
            if required or vector:
                item[field] = vector
        clean.append(item)
    return clean


def json_response(data, status=200):
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


async def send_to(player_id, msg):
    conn = connections.get(player_id)
    if conn is not None:
        await conn.send(msg)


async def broadcast_state(room):
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
    players = room.roster()
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "roster", "players": players})


async def broadcast_room_event(room, event):
    dead = []
    for queue in list(sse_clients.get(room.code, set())):
        try:
            await queue.put(event)
        except RuntimeError:
            dead.append(queue)
    for queue in dead:
        sse_clients.get(room.code, set()).discard(queue)


async def process_hit(room, shooter_id, target_id, zone):
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
    def __init__(self, sender):
        self.id = str(uuid.uuid4())
        self.clone_id = f"{self.id}:debug-clone"
        self.room = None
        self.sender = sender

    async def send(self, msg):
        await self.sender(msg)

    async def receive(self, msg):
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "join" and self.room is None:
            code = clean_room_code(msg.get("room"))
            room = rooms.get(code) or Room(code)
            name = clean_name(msg.get("name"))
            gallery = clean_gallery(msg.get("gallery"))
            requested_id = clean_player_id(msg.get("playerId"))
            if requested_id and requested_id in room.players:
                self.id = requested_id
                self.clone_id = f"{self.id}:debug-clone"
                rooms[code] = room
                connections[self.id] = self
                self.room = room
                await self.send({"type": "welcome", "id": self.id})
                await broadcast_state(room)
                await broadcast_roster(room)
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
            rooms[code] = room
            connections[self.id] = self
            self.room = room
            await self.send({"type": "welcome", "id": self.id})
            await broadcast_state(room)
            await broadcast_roster(room)
            return

        if self.room is None:
            return

        if msg.get("type") == "shoot":
            await process_hit(self.room, self.id, msg.get("targetId"), msg.get("zone"))
        elif msg.get("type") == "scan":
            target_id = msg.get("targetId")
            gallery = clean_gallery(msg.get("gallery"))
            result = self.room.set_gallery(target_id, gallery)
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            await self.send({"type": "scanSaved", "targetId": target_id})
            await broadcast_roster(self.room)
            await broadcast_state(self.room)
        elif msg.get("type") == "start":
            result = self.room.start()
            if not result["ok"]:
                await self.send({"type": "error", "message": result["error"]})
                return
            await broadcast_state(self.room)

    async def close(self):
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
            rooms.pop(room.code, None)
        else:
            await broadcast_state(room)
            await broadcast_roster(room)
        self.room = None


async def api_connect(request):
    token = str(uuid.uuid4())
    poller = Poller()
    pollers[token] = poller

    async def sender(msg):
        poller.queue.append(msg)
        if poller.waiter and not poller.waiter.done():
            poller.waiter.set_result(True)

    poller.session = Session(sender)
    return json_response({"token": token})


async def api_send(request):
    token = request.query.get("token")
    poller = pollers.get(token)
    if poller is None:
        return json_response({"error": "Unknown session"}, 410)
    if request.content_length and request.content_length > MAX_BODY_BYTES:
        return json_response({"error": "Body too large"}, 413)
    try:
        msg = await request.json()
    except ValueError:
        return json_response({"error": "Invalid or oversized JSON body"}, 400)
    poller.last_seen = time.time() * 1000
    await poller.session.receive(msg)
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_disconnect(request):
    token = request.query.get("token")
    poller = pollers.pop(token, None)
    if poller:
        if poller.waiter and not poller.waiter.done():
            poller.waiter.set_result(True)
        await poller.session.close()
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_poll(request):
    token = request.query.get("token")
    poller = pollers.get(token)
    if poller is None:
        return json_response({"error": "Unknown session"}, 410)
    poller.last_seen = time.time() * 1000
    if not poller.queue:
        loop = asyncio.get_event_loop()
        poller.waiter = loop.create_future()
        try:
            await asyncio.wait_for(poller.waiter, POLL_WAIT_MS / 1000)
        except asyncio.TimeoutError:
            pass
        finally:
            poller.waiter = None
    queue = poller.queue
    poller.queue = []
    return json_response(queue)


async def api_hit(request):
    try:
        msg = await request.json()
    except ValueError:
        return json_response({"ok": False, "error": "Bad JSON"}, 400)
    shooter_id = msg.get("shooterId")
    target_id = msg.get("targetId")
    zone = msg.get("zone")
    room = None
    room_code = msg.get("room")
    if room_code:
        room = rooms.get(clean_room_code(room_code))
    if room is None:
        room = next((candidate for candidate in rooms.values() if shooter_id in candidate.players), None)
    if room is None:
        return json_response({"ok": False, "error": "Unknown player"}, 404)
    result = await process_hit(room, shooter_id, target_id, zone)
    return json_response(result, 200 if result.get("ok") else 400)


async def events(request):
    room_code = clean_room_code(request.match_info.get("room"))
    queue = asyncio.Queue()
    sse_clients.setdefault(room_code, set()).add(queue)
    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)
    try:
        await response.write(b": connected\n\n")
        while True:
            event = await queue.get()
            payload = json.dumps(event, separators=(",", ":"))
            await response.write(f"event: {event.get('type', 'message')}\ndata: {payload}\n\n".encode())
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    finally:
        sse_clients.get(room_code, set()).discard(queue)
    return response


async def health(request):
    return web.Response(text="laser-tag python backend\n")


async def sweep_pollers(app):
    while True:
        await asyncio.sleep(5)
        now = time.time() * 1000
        expired = [token for token, poller in pollers.items() if now - poller.last_seen > POLL_EXPIRY_MS]
        for token in expired:
            poller = pollers.pop(token, None)
            if poller:
                await poller.session.close()


async def start_sweeper(app):
    app["sweeper"] = asyncio.create_task(sweep_pollers(app))


async def stop_sweeper(app):
    app["sweeper"].cancel()
    try:
        await app["sweeper"]
    except asyncio.CancelledError:
        pass


def create_app():
    app = web.Application()
    app.router.add_post("/api/connect", api_connect)
    app.router.add_post("/api/send", api_send)
    app.router.add_post("/api/disconnect", api_disconnect)
    app.router.add_get("/api/poll", api_poll)
    app.router.add_post("/api/hit", api_hit)
    app.router.add_get("/events/{room}", events)
    app.router.add_get("/", health)
    app.on_startup.append(start_sweeper)
    app.on_cleanup.append(stop_sweeper)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "4000")))
