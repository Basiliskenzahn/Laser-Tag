// A tap fires; a tap on a control does not (frontend/public/app.js, screens/game.js).
//
// The FIRE button is gone: the shot is now a `pointerdown` listener on #game-screen that bails out
// on `event.target.closest('button, dialog')` or an open leave dialog. That turns firing into a
// question about what is allowed to sit over the game screen, and every one of those overlays
// arrived with this merge: the leave button and its confirm dialog, the end-of-round results
// panel - and, from the other line, the ?debug readout, which moved out of #game-screen to be the
// last child of <body> so it is readable on the join, lobby and scan screens too.
//
// So these drive the real app.js wiring over a tree built from the real index.html, dispatch a
// pointerdown that bubbles the way a browser's does, and watch for the shot the server would see:
// fire() posts to /api/hit for every shot, hit or miss. Building the tree from the page rather
// than from a hand-written fixture is what makes the #debug test mean anything - moving that
// <pre> back inside #game-screen turns the overlay into a dead patch on the aiming surface, and
// nothing in the listener's guard would stop it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs();

// app.js is the wiring diagram under test: importing it registers every listener.
await import('../frontend/public/app.js');
const { state } = await import('../frontend/public/state.js');

const PAGE = readFileSync(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
// Void elements, plus the ones index.html uses that never have children.
const VOID = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'use', 'path', 'rect', 'circle', 'source']);

// The page's own element tree, as far as these listeners can tell: one node per tag, ids kept so
// $(id) and the test agree on the same object, tag names kept so `closest` sees real controls.
function buildPage() {
  const doc = globalThis.document;
  doc.body.replaceChildren();
  const stack = [doc.body];
  const tokens = PAGE.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g);
  for (const [, closing, name, attrs] of tokens) {
    if (!name || name === 'html' || name === 'head' || name === 'body') continue;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const id = attrs?.match(/\bid="([^"]+)"/)?.[1];
    const node = id ? dom.$(id) : doc.createElement(name);
    node.tagName = name.toUpperCase();
    if (id) node.replaceChildren();
    stack.at(-1).append(node);
    if (!VOID.has(name) && !attrs.trimEnd().endsWith('/')) stack.push(node);
  }
}

let shots;

beforeEach(() => {
  dom.reset();
  shots = [];
  globalThis.fetch = (path, options) => {
    shots.push({ path, body: JSON.parse(options.body) });
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
  };
  Object.assign(state, {
    myId: 'me',
    mode: 'game',
    room: 'demo',
    tracks: [],
    // Not 0: performance.now() under Node is milliseconds since the process started, which while
    // the suite is still booting is inside FIRE_COOLDOWN_MS of 0 - so every first tap would read
    // as a shot fired a moment ago and be swallowed.
    lastShotAt: performance.now() - 10_000,
    game: {
      status: 'playing',
      maxHp: 100,
      players: [
        { id: 'me', name: 'Ann', hp: 100, alive: true },
        { id: 'them', name: 'Bo', hp: 100, alive: true },
      ],
    },
  });
  buildPage();
});

const hits = () => shots.filter((shot) => shot.path === '/api/hit');

test('the page puts the aiming surface and the controls where the listener expects them', () => {
  // The preconditions the rest of this file rests on, read off index.html rather than assumed.
  assert.equal(dom.$('crosshair').closest('#game-screen'), dom.$('game-screen'));
  assert.equal(dom.$('leave-game-btn').tagName, 'BUTTON');
  assert.equal(dom.$('leave-dialog').tagName, 'DIALOG');
  assert.equal(dom.$('leave-dialog').closest('#game-screen'), dom.$('game-screen'));
  assert.equal(dom.$('results').closest('#game-screen'), dom.$('game-screen'));
  assert.equal(dom.$('fire-btn').parentElement, null, 'there is no FIRE button in the page any more');
});

test('a tap on the game screen fires', () => {
  const event = dom.fireAt(dom.$('crosshair'), 'pointerdown');

  assert.equal(hits().length, 1, 'the shot reached the server');
  assert.equal(hits()[0].body.shooterId, 'me');
  assert.equal(event.defaultPrevented, true, 'and the tap was not left to become a click as well');
});

test('a tap on a button on the game screen does not fire', () => {
  dom.fireAt(dom.$('leave-game-btn'), 'pointerdown');
  dom.fireAt(dom.$('start-btn'), 'pointerdown');
  assert.deepEqual(hits(), [], 'Leave and Start are controls, not somewhere to aim');
});

test('a tap on something inside a button does not fire either', () => {
  // The Leave button is an icon and a label, so this is where a real finger lands. `closest`
  // rather than a look at event.target.tagName is the whole reason it holds.
  const [label] = dom.$('leave-game-btn').querySelectorAll('span');
  assert.ok(label, 'precondition: the button has something inside it to tap');
  dom.fireAt(label, 'pointerdown');
  assert.deepEqual(hits(), [], 'the tap was on the button, whatever it landed on');
});

test('a tap while the leave dialog is open does not fire', () => {
  dom.$('leave-dialog').open = true;
  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  assert.deepEqual(hits(), [], 'the game screen is behind a modal');

  dom.$('leave-dialog').open = false;
  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  assert.equal(hits().length, 1, 'and firing comes back when it closes');
});

test('a tap on the leave dialog itself does not fire', () => {
  // The backdrop of an open modal targets the <dialog>, which is how "tap outside the box to
  // cancel" works; `closest('dialog')` is what stops that tap also being a shot.
  dom.fireAt(dom.$('leave-dialog'), 'pointerdown');
  assert.deepEqual(hits(), [], 'a tap on the dialog is not a shot');
});

test('a tap on the results panel does not fire', () => {
  // The results panel covers the whole game screen once the round is over for you, and it is a
  // <section>, not a button - so nothing in the listener's guard excludes it. What does is the
  // mode: detection and firing both stop while the results are up.
  state.mode = 'results';
  dom.fireAt(dom.$('results-stats'), 'pointerdown');
  dom.fireAt(dom.$('results-rank'), 'pointerdown');
  assert.deepEqual(hits(), [], 'the round is over for this player');
});

test('a tap on the debug overlay fires the game screen below it', () => {
  // #debug is a direct child of <body> in index.html, not of #game-screen, so a pointerdown on it
  // never reaches the game screen's listener - and it is `pointer-events: none`, so in a browser
  // the tap lands on the screen below instead. Nested back inside #game-screen it would bubble
  // into the fire listener, where `closest('button, dialog')` would not stop it either.
  assert.equal(dom.$('debug').parentElement, globalThis.document.body, 'the overlay is not in a screen');
  dom.fireAt(dom.$('debug'), 'pointerdown');
  assert.deepEqual(hits(), [], 'nothing fired from outside the game screen');

  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  assert.equal(hits().length, 1, 'and the screen below it still fires');
});

test('a dead player tapping the screen does not fire', () => {
  state.game.players[0].alive = false;
  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  assert.deepEqual(hits(), [], 'being down is not being able to shoot');
});

test('the fire cooldown still applies to taps', () => {
  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  dom.fireAt(dom.$('crosshair'), 'pointerdown');
  assert.equal(hits().length, 1, 'a second tap inside the cooldown is swallowed');
});

test('Space still fires, and not while the leave dialog is open', () => {
  dom.$('game-screen').hidden = false;
  dom.fireDocument('keydown', { code: 'Space' });
  assert.equal(hits().length, 1);

  state.lastShotAt = performance.now() - 10_000;
  dom.$('leave-dialog').open = true;
  dom.fireDocument('keydown', { code: 'Space' });
  assert.equal(hits().length, 1, 'the key is for the game screen, not for a modal');
});

test('a tap on the game screen cancels the touchend that would zoom the page', () => {
  // Fast taps read as a double-tap zoom on iOS whatever the viewport says, so the game and scan
  // screens cancel the touchend a tap would otherwise finish with. Controls keep theirs: the click
  // it makes is how Leave, Start and the results buttons work at all.
  assert.equal(dom.fireAt(dom.$('crosshair'), 'touchend').defaultPrevented, true);
  assert.equal(dom.fireAt(dom.$('leave-game-btn'), 'touchend').defaultPrevented, false);
  assert.equal(dom.fireAt(dom.$('scan-instruction'), 'touchend').defaultPrevented, true, 'the scan screen too');
});
