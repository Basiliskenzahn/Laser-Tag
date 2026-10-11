// Coming back from the background restarts the camera - but not over the top of the first start
// (frontend/public/app.js, frontend/public/camera.js).
//
// resumeCamera() exists because hiding the browser pauses the <video> and phones often end the
// camera track outright, so the picture froze until a reload. It gives a live stream a moment to
// produce a new frame and, if none arrives, stops it and asks for a fresh one.
//
// That last part is why the wiring needs a guard. `video.srcObject` is set partway through
// starting the lobby, while the models are still loading and the main thread is compiling shaders
// and WASM kernels - a window where a frame can easily miss the deadline for reasons that have
// nothing to do with the stream being dead. A resume landing there would stop the stream the join
// is waiting on and ask the phone for camera permission a second time.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs();

await import('../frontend/public/app.js');
const { state } = await import('../frontend/public/state.js');

let played;
let realSetTimeout;

// resumeCamera() de-duplicates itself with a module-level promise, so each resume has to be let
// finish or the next test would be skipped rather than guarded. Its one wait is the frame
// deadline, which this runs out immediately.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  dom.reset();
  played = 0;
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  const video = dom.$('video');
  // A stream the OS still calls live, which is what the resume asks to play again.
  video.srcObject = { getVideoTracks: () => [{ readyState: 'live', stop() {} }], getTracks: () => [] };
  video.currentTime = 0;
  video.play = () => {
    played++;
    video.currentTime += 1; // the frames move again, so the stream is not written off
    return Promise.resolve();
  };
  state.startingLobby = false;
  state.detector = null;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

test('coming back to a running lobby resumes the camera', async () => {
  dom.fireDocument('visibilitychange');
  await settle();
  assert.equal(played, 1, 'the paused video was asked to play again');
});

test('coming back while the lobby is still starting leaves the camera alone', async () => {
  state.startingLobby = true;
  dom.fireDocument('visibilitychange');
  await settle();
  assert.equal(played, 0, 'the start owns the camera until it is done with it');

  state.startingLobby = false;
  dom.fireDocument('visibilitychange');
  await settle();
  assert.equal(played, 1, 'and the resume works again once it is');
});

test('a back/forward-cache restore is guarded the same way', async () => {
  state.startingLobby = true;
  dom.fireWindow('pageshow', { persisted: true });
  await settle();
  assert.equal(played, 0);

  state.startingLobby = false;
  dom.fireWindow('pageshow', { persisted: true });
  await settle();
  assert.equal(played, 1);
});

test('a page shown without being restored from the cache is not a resume', async () => {
  dom.fireWindow('pageshow', { persisted: false });
  await settle();
  assert.equal(played, 0, 'an ordinary load already started the camera itself');
});
