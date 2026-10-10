// The two ways a phone can talk to the game server, behind the same small interface:
//
//   const conn = openWebSocket(handlers) / openPolling(handlers)
//   conn.send(msg)   // queue a JSON message to the server
//   conn.close()     // stop; the server notices and drops the player
//   handlers: { onOpen(), onMessage(msg), onClose() }
//
// WebSocket is preferred. Polling is the fallback for networks whose proxies reject WebSocket
// upgrades: the hackathon's SSO gateway answers every upgrade with 502, and iPhone Safari
// refuses WebSockets to self-signed addresses even after the certificate warning was accepted.
// Ordinary fetch() requests get through both.

export function openWebSocket({ onOpen, onMessage, onClose }) {
  let closedByClient = false;
  let opened = false;
  let ws;

  const connectTimer = setTimeout(() => {
    if (!opened && ws?.readyState === WebSocket.CONNECTING) ws.close();
  }, 2500);

  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  } catch {
    clearTimeout(connectTimer);
    setTimeout(onClose, 0);
    return {
      send() {},
      close() {},
    };
  }

  ws.onopen = () => {
    opened = true;
    clearTimeout(connectTimer);
    onOpen();
  };
  ws.onerror = () => {
    if (!opened && ws.readyState === WebSocket.CONNECTING) ws.close();
  };
  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames; the next valid server update will resync the UI.
    }
  };
  ws.onclose = () => {
    clearTimeout(connectTimer);
    if (!closedByClient) onClose();
  };
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closedByClient = true;
      clearTimeout(connectTimer);
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

export function openPolling({ onOpen, onMessage, onClose }) {
  let token = null;
  let closed = false;
  let sending = Promise.resolve(); // sends go out one at a time, in order
  const aborter = new AbortController();

  function fail() {
    if (closed) return;
    closed = true;
    aborter.abort();
    onClose();
  }

  async function request(path, options = {}) {
    const res = await fetch(path, { cache: 'no-store', signal: aborter.signal, ...options });
    // A login redirect (expired SSO session) or a 410 (server forgot us) both mean: reconnect.
    if (!res.ok || res.redirected) throw new Error(`${path} answered ${res.status}`);
    return res;
  }

  (async () => {
    try {
      token = (await (await request('/api/connect', { method: 'POST' })).json()).token;
      onOpen();
      while (!closed) {
        const messages = await (await request(`/api/poll?token=${encodeURIComponent(token)}`)).json();
        for (const msg of messages) {
          if (closed) break;
          onMessage(msg);
        }
      }
    } catch {
      fail();
    }
  })();

  return {
    send(msg) {
      if (closed || !token) return;
      sending = sending
        .then(() =>
          request(`/api/send?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg),
          }),
        )
        .catch(fail);
    },
    close() {
      closed = true;
      aborter.abort();
    },
  };
}
