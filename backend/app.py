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
    MAX_SSE_BACKLOG,
    Poller,
    Session,
    cancel_room_timers,
    drop_sse_client,
    pollers,
    process_hit,
    rooms,
    sse_clients,
    sweep_pollers,
)

#: Biggest body any handler here will read. aiohttp enforces the same number as
#: ``client_max_size`` below, and the two must agree on the boundary: it rejects a
#: body of *exactly* this size, so the explicit check uses ``>=`` as well.
MAX_BODY_BYTES = 1024 * 1024  # a 24-sample scan with re-identification embeddings is ~210 KB

#: Handle for the dead-session reaper, so cleanup can cancel the task startup made.
SWEEPER = web.AppKey("sweeper", asyncio.Task)


def compact_dumps(data):
    """Serialise without the whitespace ``json.dumps`` adds by default.

    A poll response can carry a player's whole appearance gallery - thousands of
    numbers - and the default ``", "``/``": "`` separators add about 13% to that
    for the benefit of nobody: no human reads these bodies. The SSE encoder in
    :func:`events` has always done this; this makes the polling path match.
    """
    return json.dumps(data, separators=(",", ":"))


def json_response(data, status=200):
    """JSON with caching off - every payload here is a point-in-time game state."""
    return web.json_response(data, status=status, dumps=compact_dumps, headers={"Cache-Control": "no-store"})


def gone(poller=None):
    """410 for a token we are not addressing any more.

    ``reason`` says which kind: ``replaced`` means another session took this
    player's seat and this phone should *not* come back as the same player, while
    anything else means the session is simply over and reconnecting is right. The
    reason is only known while the mailbox object is still to hand - a token the
    reaper has already unregistered is just ``unknown``.
    """
    reason = (poller.evicted if poller is not None else "") or "unknown"
    return json_response({"error": "Unknown session", "reason": reason}, 410)


async def api_connect(request):
    """Hand out a poll token and the session it addresses. No room is joined yet."""
    token = str(uuid.uuid4())
    poller = Poller(token=token)
    pollers[token] = poller
    poller.session = Session(poller.push)
    return json_response({"token": token})


async def api_send(request):
    """One client message (join / scan / start) for a session.

    Shots never arrive here: the client posts them to /api/hit directly (see
    api_hit), which is why that's not in the list above.
    """
    token = request.query.get("token")
    poller = pollers.get(token)
    if poller is None or not poller.is_live():
        return gone(poller)
    if request.content_length and request.content_length >= MAX_BODY_BYTES:
        return json_response({"error": "Body too large"}, 413)
    try:
        msg = await request.json()
    except web.HTTPRequestEntityTooLarge:
        # A chunked body has no Content-Length for the check above, so aiohttp's
        # own client_max_size is what catches it - and it answers a plain-text
        # 413. Caught so an oversized body gets one shape either way.
        return json_response({"error": "Body too large"}, 413)
    except ValueError:
        # Only malformed JSON reaches here: an oversized body is a 413 above, by
        # declared length or by the exception aiohttp raises while reading it.
        return json_response({"error": "Invalid JSON body"}, 400)
    poller.touch()
    await poller.session.receive(msg)
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_disconnect(request):
    """Voluntary goodbye (page unload), so the room drops the player at once."""
    token = request.query.get("token")
    poller = pollers.pop(token, None)
    if poller:
        poller.wake()
        await poller.session.close()
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def api_poll(request):
    """Long poll: return queued messages, or park until one arrives or we time out.

    The liveness check is repeated after the park, and that second check is what
    makes a dead session recoverable. A poll can be parked here for 20 seconds,
    and in that time its seat can be adopted by another tab, its phone can be
    reaped for going quiet, or its mailbox can overflow - all three evict it and
    wake this poll. Answering 200 to a woken-but-evicted poll is what froze the
    first tab: the client treats 200 as "nothing has happened" and only
    reconnects when a poll fails, so it has to see the 410.
    """
    token = request.query.get("token")
    poller = pollers.get(token)
    if poller is None or not poller.is_live():
        return gone(poller)
    poller.touch()
    messages = await poller.take()
    if not poller.is_live():
        return gone(poller)
    return json_response(messages)


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
    # Valid JSON is not necessarily an object: `[]`, `"x"` and `5` all parse, and
    # all used to reach .get() and answer 500 with a traceback. Session.receive
    # has always guarded this; this was the one handler that did not.
    if not isinstance(msg, dict):
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

    ``CancelledError`` is deliberately *not* caught: this handler parks forever on
    the queue, and swallowing the cancellation and returning normally told the
    server the stream had finished of its own accord, which defeated graceful
    shutdown. The ``finally`` still forgets the listener either way.
    """
    room_code = clean_room_code(request.match_info.get("room"))
    # Bounded: a spectator page that stops reading would otherwise grow a queue
    # nobody drains. broadcast_room_event drops the oldest events when it is full.
    queue = asyncio.Queue(maxsize=MAX_SSE_BACKLOG)
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
    except ConnectionResetError:
        pass
    finally:
        # Also removes the room's entry with its last listener: room codes are
        # client-chosen, so an empty set per code ever asked for is a leak.
        drop_sse_client(room_code, queue)
    return response


async def health(request):
    """Liveness probe for the container and the reverse proxy."""
    return web.Response(text="laser-tag python backend\n")


async def start_background_tasks(app):
    """Run the dead-session reaper for the lifetime of the app."""
    app[SWEEPER] = asyncio.create_task(sweep_pollers())


async def stop_background_tasks(app):
    """Cancel everything this process started, so shutdown leaves nothing pending.

    The reaper is not the only task: every countdown schedules one of its own in
    ``transport.broadcast_state``, and cancelling only the reaper left those to be
    garbage collected mid-sleep with "Task was destroyed but it is pending".
    """
    app[SWEEPER].cancel()
    try:
        await app[SWEEPER]
    except asyncio.CancelledError:
        pass
    await cancel_room_timers()


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
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(stop_background_tasks)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "4000")))
