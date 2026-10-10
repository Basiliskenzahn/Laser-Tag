"""HTTP entrypoint for the laser-tag backend: how a request becomes a game action.

This module is only wiring. Phones cannot rely on WebSockets through every
captive-portal wifi, so the realtime channel is HTTP long polling: a phone POSTs
``/api/connect`` once for a token, then POSTs its messages to ``/api/send`` and
keeps a ``GET /api/poll`` parked to receive. Scoreboards and overlays get a
read-only ``GET /events/{room}`` SSE stream instead.

Everything behind these handlers lives elsewhere:

* ``backend.models`` - the game rules (:class:`~backend.models.Room`).
* ``backend.transport`` - sessions, mailboxes and broadcasting.
* ``backend.sanitize`` - turning untrusted JSON into trusted values.

Launched as ``python -m backend.app`` (see ``backend/Dockerfile``). nginx in
``frontend/`` terminates TLS and reverse-proxies ``/api/*`` and ``/events/*``
here, so no static files are served from this process.
"""

import asyncio
import json
import os
import uuid

from aiohttp import web

from .sanitize import clean_room_code
from .transport import (
    Poller,
    Session,
    pollers,
    process_hit,
    rooms,
    sse_clients,
    sweep_pollers,
)

MAX_BODY_BYTES = 1024 * 1024  # a 24-sample scan with re-identification embeddings is ~210 KB


def json_response(data, status=200):
    """JSON with caching off - every payload here is a point-in-time game state."""
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


async def api_connect(request):
    """Hand out a poll token and the session it addresses. No room is joined yet."""
    token = str(uuid.uuid4())
    poller = Poller()
    pollers[token] = poller
    poller.session = Session(poller.push)
    return json_response({"token": token})


async def api_send(request):
    """One client message (join / scan / motion / start) for a session.

    Shots never arrive here: the client posts them to /api/hit directly (see
    api_hit), which is why that's not in the list above.
    """
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
    poller.touch()
    await poller.session.receive(msg)
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_disconnect(request):
    """Voluntary goodbye, so the room drops the player at once.

    ``?forfeit=1`` marks it as the player quitting on purpose, which mid-round
    counts as being knocked out (see :meth:`backend.transport.Session.close`).
    """
    token = request.query.get("token")
    poller = pollers.pop(token, None)
    if poller:
        poller.wake()
        await poller.session.close(forfeit=request.query.get("forfeit") == "1")
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_poll(request):
    """Long poll: return queued messages, or park until one arrives or we time out."""
    token = request.query.get("token")
    poller = pollers.get(token)
    if poller is None:
        return json_response({"error": "Unknown session"}, 410)
    poller.touch()
    return json_response(await poller.take())


async def api_hit(request):
    """Register a hit without a session - the stateless shortcut for a shot.

    Used by clients that resolve aiming locally and only need the server to
    arbitrate. The room is taken from the body when given, otherwise it is found
    by looking for whichever room the shooter is sitting in.
    """
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
    # isinstance guard: an unhashable shooter id (a JSON list or object) would
    # otherwise raise TypeError out of the `in` lookup instead of 404-ing.
    if room is None and isinstance(shooter_id, str):
        room = next((candidate for candidate in rooms.values() if shooter_id in candidate.players), None)
    if room is None:
        return json_response({"ok": False, "error": "Unknown player"}, 404)
    result = await process_hit(room, shooter_id, target_id, zone)
    return json_response(result, 200 if result.get("ok") else 400)


async def events(request):
    """Server-sent events for one room: a read-only feed of health/death events.

    For spectator surfaces rather than players - no token, no session, and
    nothing a listener sends can affect the round. ``X-Accel-Buffering: no``
    stops the nginx in front of this process from buffering the stream.
    """
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
    """Liveness probe for the container and the reverse proxy."""
    return web.Response(text="laser-tag python backend\n")


async def start_sweeper(app):
    """Run the dead-session reaper for the lifetime of the app."""
    app["sweeper"] = asyncio.create_task(sweep_pollers())


async def stop_sweeper(app):
    """Cancel the reaper and wait for it, so shutdown leaves no pending task."""
    app["sweeper"].cancel()
    try:
        await app["sweeper"]
    except asyncio.CancelledError:
        pass


def create_app():
    """Build the aiohttp app. Kept separate from ``run_app`` so it can be driven
    in-process by a test or an embedding script."""
    app = web.Application(client_max_size=MAX_BODY_BYTES)
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
