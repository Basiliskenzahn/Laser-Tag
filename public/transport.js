// The phone talks to the game server through one small interface:
//
//   const conn = openPolling(handlers)
//   conn.send(msg)   // queue a JSON message to the server
//   conn.close()     // stop; the server notices and drops the player
//   handlers: { onOpen(), onMessage(msg), onClose() }
//
// HTTP long-polling uses only ordinary fetch() requests, which keeps the game working through
// proxies and self-signed local HTTPS setups.

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
