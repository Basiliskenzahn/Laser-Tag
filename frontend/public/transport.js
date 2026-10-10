// The phone talks to the game server through one small interface:
//
//   const conn = openPolling(handlers)
//   await conn.send(msg)   // queue a JSON message; resolves true once the server has it,
//                          // false if it could not be delivered
//   conn.close()           // stop; the server notices and drops the player
//   handlers: { onOpen(), onMessage(msg), onClose() }
//
// HTTP long-polling uses only ordinary fetch() requests, which keeps the game working through
// proxies and self-signed local HTTPS setups.
//
// Two things used to be able to take the connection down that have no business doing so, and both
// are now contained here rather than at the call sites:
//
//   a send that failed  - it closed the connection and dropped the message, and the caller could
//                         not tell. send() now retries a transient failure and, if it still can't
//                         get the message out, says so to its caller instead of tearing anything
//                         down. Deciding the connection is gone is the poll loop's job alone.
//   a handler that threw - the throw reached the poll loop's catch, which closed the connection,
//                         which reconnected, which re-joined, which received the same bad message
//                         again, for ever. Dispatch is now outside the loop's try.

const SEND_ATTEMPTS = 3; // the first try plus two retries
const SEND_RETRY_MS = 250;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openPolling({
  onOpen,
  onMessage,
  onClose,
  sendAttempts = SEND_ATTEMPTS,
  sendRetryMs = SEND_RETRY_MS,
}) {
  let token = null;
  let closed = false;
  let notified = false;
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

  // A message no handler can cope with is a bug in a handler, not a broken connection. Letting
  // the throw out of here would reach the poll loop's catch: close, reconnect, re-join, and the
  // server replays the same message - and `opened` is already true by then, so failedConnects
  // never rises and nothing ever stops the loop. One bad message would hammer the server for as
  // long as the page was open, under a banner that only ever said "Reconnecting…".
  function dispatch(msg) {
    try {
      onMessage(msg);
    } catch (err) {
      console.error('message handler failed', msg?.type, err);
    }
  }

  (async () => {
    try {
      token = (await (await request('/api/connect', { method: 'POST' })).json()).token;
      onOpen();
      while (!closed) {
        const messages = await (await request(`/api/poll?token=${encodeURIComponent(token)}`)).json();
        for (const msg of messages) {
          if (closed) break;
          dispatch(msg);
        }
      }
    } catch {
      fail();
    }
  })();

  // True once the server has the message. A single transient error on a big POST - the ~190 KB
  // scan gallery is the one that matters - is retried rather than thrown away.
  async function attemptSend(msg) {
    for (let attempt = 1; attempt <= sendAttempts; attempt++) {
      if (closed || !token) return false;
      try {
        await request(`/api/send?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        });
        return true;
      } catch {
        if (attempt === sendAttempts) return false;
        await delay(sendRetryMs);
      }
    }
    return false;
  }

  function notifyLeaving() {
    if (notified || !token) return;
    notified = true;
    const path = `/api/disconnect?token=${encodeURIComponent(token)}`;
    if (!navigator.sendBeacon?.(path, '')) {
      fetch(path, { method: 'POST', cache: 'no-store', keepalive: true }).catch(() => {});
    }
  }

  return {
    // Resolves true if the server has the message, false if it could not be delivered - including
    // when there is no connection at all. Never rejects, so a caller that does not care about the
    // answer (most of them) can keep ignoring it without leaving an unhandled rejection behind.
    send(msg) {
      const done = sending.then(() => attemptSend(msg));
      sending = done;
      return done;
    },
    close({ notify = false } = {}) {
      if (notify) notifyLeaving();
      closed = true;
      aborter.abort();
    },
  };
}
