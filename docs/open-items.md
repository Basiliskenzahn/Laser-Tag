# Open items

Decisions and risks that are still open on purpose. Each one is here because it needs a human, a
real phone, or a number nobody has yet - not because nobody got round to it.

If you resolve one, delete its entry rather than leaving it next to a doc claiming it is open.

## Nothing past the colour signature has been measured on a real phone

This is the item most of the others reduce to.

- **OSNet's accuracy is a research dataset**, not game footage. The numbers in
  [Identification](client/identification.md#the-re-identification-embedding-reidjs) come from
  Market-1501 - people the model never saw, but also real lighting, motion blur and lens
  characteristics it never saw either.
- **The frame budget is architecture, not a profile.** The detection cadences in
  [Configuration](development/configuration.md) are source constants calibrated by feel during
  development. No stage has a measured wall-clock cost on a device.

The fix is the same for all of it: a short structured session on real phones with
[`?debug`](development/debug-mode.md), which already prints per-stage timings and per-part scores.

## `MIN_SHAPE_SCORE` / `EVIDENCE_MIN_PART` recalibration

**Owner: LuxKaiwalker. Open deliberately - the state it is in is the safe one.**

`shape` used to be L2-normalised on the gallery side and raw on the live side, so
`shapeSimilarity()` - the one comparison in `identify.js` that is not scale-invariant - scored
**0 for the correct person**. Worse than it looks: `shape`'s two components are collinear
(`[a, a·r]` for a frame of aspect `r`), so normalising cancelled the aspect out and gave every
enrolled player the same gallery value, 0.600 in a 4:3 frame. `MIN_SHAPE_SCORE` therefore always
rejected, and because `EVIDENCE_MIN_PART` requires the same floor of every colour part, the
evidence accumulator never fired at all on either model-free path.

It is fixed: `shape` is averaged with a plain component-wise mean while every cosine-compared
field keeps the normalised path. `test/shape-signature.test.js` holds it there through the real
extraction path, which is where the bug lived - every test that hand-builds a gallery misses it by
construction.

**What is still open is the tuning, not the correctness.** 0.36 and 0.24 are **unchanged on
purpose**: the fix makes them reachable rather than retuned, and 0.36 was originally chosen
against a feature that returned 0 for everyone, so it has never gated anything. Picking new
numbers needs a real colour-only score distribution, which does not exist - only synthetic ones,
and those give the same person the same body aspect by construction and are far too tight to read
a threshold off. Collect real `s` values with `?debug` on a device where OSNet does not load, then
decide.

Treat `shape` as the guard it was built to be - partial bodies and odd framing - not as a way of
telling people apart. Body aspect overlaps heavily between adults.

## CI runs no tests before deploying

`.github/workflows/ci-cd-action.yml` triggers on a pull request **closed** into `dev` and does one
thing: SSH in, `git checkout dev && git pull && docker compose up --build -d`. Neither suite runs
first, though both are containerised and ready (`docker compose run --rm tests` and
`backend-tests`). A broken change in the client or the backend reaches the live server with
nothing catching it.

Two further hazards in the trigger itself: a PR closed **unmerged** deploys too, and `git pull`
deploys whatever `dev`'s tip is at that moment rather than the reviewed commit. A worked
replacement exists on `luxkaiwalker/deploy-robustness` and is worth its own pull request - see
[Deployment](operations/deployment.md), which documents today's behaviour including the
unmerged-close hazard.

Not fixed here because deploy behaviour is shared infrastructure that affects everyone, and
bundling it with a session of game fixes would mean one review covering both.

## Whether MobileNet's 4 MB stays

The MobileNetV3 embedder was never trained to tell people apart; it is a generic image embedding
that beats raw colour. OSNet overrides it entirely whenever it loads, which is nearly every real
game, so in the normal case 4 MB downloads, gets warmed up and never decides anything. Its only
remaining job is graceful degradation on a phone where OSNet fails to load.

Whether that is worth 22% of the payload turns on one number nobody has: **how often does OSNet
actually fail to load on a real phone?** `?debug` already shows it - a missing `+ReID` on the
first overlay line - so a few phones' worth of field testing settles it. Dropping it is not a
free win, which is why it is recorded rather than done.

## Cross-origin isolation is unverified on a device

`reid.js` asks for `crossOriginIsolated ? min(4, hardwareConcurrency) : 1` WASM threads, and for a
long time nothing served the `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers
that `crossOriginIsolated` requires, so the ternary had only ever taken its `1` branch - the image
shipped a threaded WASM build and used it to do the non-threaded build's job.
`frontend/cross-origin-isolation.conf` now serves both headers from every static location, and
failure is one-directional: if isolation does not take effect, `crossOriginIsolated` is false and
the fallback is exactly the old behaviour.

**Still unmeasured on a phone.** The thread count is visible in `?debug`.

## Starting the model fetch earlier

The static-delivery work deliberately added **no** `<link rel="preload">` hints and left
`frontend/public/index.html` untouched, for two reasons worth not rediscovering:

- the WASM path is chosen at runtime after a SIMD probe, so a static hint would have to guess
  among four variants, and a wrong guess costs an unused 11 MB on a phone;
- an `as="fetch"` hint for a model has to match the eventual request's CORS and credentials mode
  or the browser fetches it twice, which on the 7.25 MB detector would be worse than the bug.

The right mechanism is an explicit `fetch()` warm-up where load order is already being decided -
in the startup sequencing, not in the delivery layer. **Deferred to whoever owns the startup
path.**

## Circular imports in the frontend module graph

`net.js` ↔ `screens/game.js`, `net.js` ↔ `screens/join.js`, and
`screens/join.js` ↔ `screens/lobby.js` ↔ `screens/scan.js` ↔ `screens/game.js`.

Safe today: nothing calls an imported function at module-evaluation time, and only `app.js` makes
top-level calls, after the whole graph has loaded. It is the thing most likely to break if someone
adds top-level work to a screen module later.
