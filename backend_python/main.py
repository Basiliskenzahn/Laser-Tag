import asyncio
import uuid
from fastapi import FastAPI, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from typing import AsyncIterable

app = FastAPI()

# Registry: client_id → queue
_subscribers: dict[str, asyncio.Queue] = {}

@app.get("/backend/connect/{client_id}", response_class=EventSourceResponse)
async def sse_stream(client_id: str, request: Request) -> AsyncIterable[ServerSentEvent]:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[client_id] = q
    try:
        while True:
            if await request.is_disconnected():
                break
            payload = await q.get()
            yield ServerSentEvent(data=payload)
    finally:
        _subscribers.pop(client_id, None)

@app.post("/backend/hit")
async def receive_from_a(client_a: str, message: str):
    """Client A sends data → route to client B."""
    target = client_a  # or compute from message
    if target in _subscribers:
        await _subscribers[target].put(f"From A: {message}")
    return {"ok": True}

