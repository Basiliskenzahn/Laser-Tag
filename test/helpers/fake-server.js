// A stand-in for backend/app.py's four polling endpoints, driven from a test.
//
// It answers /api/connect, parks /api/poll the way a long poll does until the test pushes a
// message or drops the connection, records /api/send bodies (and can fail them), and records
// /api/disconnect. `server.fetch` goes on globalThis so transport.js reaches it unchanged.

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

export function createFakeServer() {
  const server = {
    connects: 0, // /api/connect requests, i.e. how many times the client dialled in
    polls: 0,
    sends: [], // delivered message bodies, parsed
    refusedSends: 0, // /api/send requests answered with an error
    disconnects: [], // tokens told to go away
    sendFailures: 0, // fail this many of the next sends, then start accepting them
    connectFailures: 0,
    queue: [],
    parked: null, // the poll currently waiting for something to happen
  };

  const reply = (data) => ({ ok: true, redirected: false, status: 200, json: async () => data });

  server.fetch = async (path, options = {}) => {
    const { signal } = options;
    if (signal?.aborted) throw abortError();

    if (path === '/api/connect') {
      server.connects++;
      if (server.connectFailures > 0) {
        server.connectFailures--;
        throw new Error('connect refused');
      }
      return reply({ token: `token-${server.connects}` });
    }

    if (path.startsWith('/api/poll')) {
      server.polls++;
      if (server.queue.length) return reply(server.queue.splice(0));
      return new Promise((resolve, reject) => {
        const parked = { resolve: (msgs) => resolve(reply(msgs)), reject };
        server.parked = parked;
        signal?.addEventListener(
          'abort',
          () => {
            if (server.parked === parked) server.parked = null;
            reject(abortError());
          },
          { once: true },
        );
      });
    }

    if (path.startsWith('/api/send')) {
      if (server.sendFailures > 0) {
        server.sendFailures--;
        server.refusedSends++;
        throw new Error('send refused');
      }
      server.sends.push(JSON.parse(options.body));
      return reply(null);
    }

    if (path.startsWith('/api/disconnect')) {
      server.disconnects.push(path);
      return reply(null);
    }

    throw new Error(`fake server got an unexpected path: ${path}`);
  };

  // Deliver messages on the parked poll, or queue them for the next one.
  server.push = (...msgs) => {
    const parked = server.parked;
    if (!parked) {
      server.queue.push(...msgs);
      return;
    }
    server.parked = null;
    parked.resolve(msgs);
  };

  // The connection fails the way a phone network fails it: the poll in flight errors out.
  server.drop = () => {
    const parked = server.parked;
    if (!parked) throw new Error('nothing is polling, so there is nothing to drop');
    server.parked = null;
    parked.reject(new Error('poll failed'));
  };

  // Let the client's promise chain run until it is parked on the poll again.
  server.settle = async ({ turns = 60 } = {}) => {
    for (let i = 0; i < turns; i++) {
      await flush();
      if (server.parked) return;
    }
  };

  return server;
}

export { flush };
