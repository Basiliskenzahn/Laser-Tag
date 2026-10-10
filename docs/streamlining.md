# Streamlining candidates

Things noticed while restructuring the codebase (October 2026) that are worth revisiting, but
were deliberately **not** acted on now - either because they're a product/tuning decision, not
a code-quality one, or because fixing them would have meant changing behaviour in gameplay-
critical code with no automated test or real device to verify against. Each item says why it
wasn't just fixed on the spot.

If you resolve one of these, delete its entry here rather than leaving it to rot alongside a doc
claiming it's still open.

## Resolved in a later pass

### Two complete backend implementations - now one

Was: the game server existed twice, `backend/` (Python, actually deployed) and `server/` (Node,
used only for `npm start`/`npm run dev` and all of the automated tests), with every rule, message
format and validation limit hand-ported between two languages to stay in sync - which had already
drifted at least once (`COUNTDOWN_MS` was out of sync between the two for a while).

Now: `server/` has been archived to `deprecated/server/` (see `deprecated/README.md`) and removed
from `package.json`'s scripts/dependencies (`start`, `dev`, and the now-unneeded `selfsigned`).
`backend/` is the only backend.

**Follow-up, now also resolved:** archiving `server/` initially meant the only test suites that
ever existed for this game's rules/protocol were sitting unrun in `deprecated/`, testing a backend
that's no longer live. `backend/test_models.py` and `backend/test_protocol.py` port that coverage
to the Python backend (`unittest` + `aiohttp.test_utils`, no new dependency) - see
[Testing](development/testing.md). Run via `docker compose run --rm backend-tests` or
`python -m unittest discover -s backend`.

What's still open: the CI/CD pipeline doesn't run *either* test suite before deploying (next
item).

### The session-based `shoot` message - now removed

Was: `Session.receive()` handled a `{"type": "shoot"}` message over the polling session, as well
as `POST /api/hit`, two paths to the same `process_hit()`. Discovered while writing
`backend/test_protocol.py` that the real client (`screens/game.js`) has never sent the former -
git history shows `/api/hit` was introduced in the same commit that moved the client off
WebSockets, and the client was wired straight to it; the session message was only ever exercised
by the archived Node test suite.

Now: removed from `Session.receive()`, `backend/app.py`'s docstring, and the protocol docs. The 3
tests that had been driving shots through it (`test_protocol.py`) now use `POST /api/hit`, matching
the real client - including a sharper assertion the old version missed: shooting yourself now
explicitly checks for the `400` the server was already returning, not just that your own HP didn't
move.

### Dead frontend code - now archived

Was: several frontend functions were defined but provably unreachable - no button, no caller,
nothing wired them up (`captureScanSignature`, `recordScanCapture`, `useSavedScan`,
`clearScanCache`, `currentScanBoxes`, `hasScan`, the no-op `updateScanButtons`/`renderSavedScan`,
and `detector.js`'s `hitTest`). Left over from an earlier manual single-capture scan UI, and from
before `targetUnderCrosshair`'s equivalent started calling `contains()`/`headBox()`/`bodyBox()`
directly instead of through `hitTest()`.

Now: moved to `deprecated/public-dead-code.js` and deleted from the live files. See that file's
header for exactly what each piece used to do.

### `shape` similarity was silently broken - now fixed, with the tuning call still deferred

Was: found while documenting `identify.js`. `shapeSignature()` returns a raw `[aspect,
heightRatio/widthRatio]` pair. Live signatures kept that raw; but every **gallery** entry is the
output of `averageSignatures()`, which ran everything (including `shape`) through
`averageVectors()` - which L2-**normalises**. So a live signature's `shape` vector and the
matching gallery sample's were on different scales, and `shapeSimilarity()` (the one comparison in
the file that isn't scale-invariant) compared them anyway: live `[2.25, 3.0]` vs. the same
person's gallery entry `[0.6, 0.8]` returned 0 instead of ~1. Worse than it first looked, because
the two components are collinear - normalising cancelled the aspect out and gave *every* enrolled
person the same gallery value, 0.600 in a 4:3 frame.

Practical effect: `MIN_SHAPE_SCORE` (0.36) always rejected, and because `EVIDENCE_MIN_PART`
requires the same floor of every colour part, **the evidence accumulator never fired at all** -
identification rested entirely on the closed-set forced-accept path and the `INITIAL_STREAK`
fast-lock, bypassing the slower, more careful evidence-based path. This applied to the
MobileNet-embedding path as well as the colour-only one, since the per-part floors are skipped only
for `hasReid`; the original write-up said colour-only and was too narrow.
`frontend/public/identify.test.js` and `test/reid-matching.test.js` didn't catch it because their
hand-built galleries use raw `shape` values on both sides, matching the bug's assumption.

Now (`luxkaiwalker/shape-normalisation`): `shape` is averaged raw (`meanVector`) while every
cosine-compared field keeps the normalised path, `SCAN_CACHE_VERSION` is bumped to 12, and
`test/shape-signature.test.js` covers the seam through the real extraction path.

What's still open, deliberately: `MIN_SHAPE_SCORE` and `EVIDENCE_MIN_PART` are **unchanged**. The
fix makes them reachable rather than retuned, and choosing new values needs a real colour-only
score distribution off a phone - the only ones that exist are synthetic
([the evaluation](shape-normalisation-evaluation.md), [the report](shape-feature-bug.md)). That is
the product/tuning decision this document exists to flag, and it is now the *only* part of this
item left.

## Structural (highest impact)

### No CI test gate before deploy

`.github/workflows/ci-cd-action.yml` triggers on every PR merge to `main` and does exactly one
thing: SSH in and `docker compose up --build -d`. There's no step that runs either test suite
first. `docker-compose.yml`'s `test` profile now has both `tests` (JS, `docker compose run --rm
tests`) and `backend-tests` (Python, `docker compose run --rm backend-tests`) ready to run in a
container - but nothing in CI invokes either automatically, so a broken change in either the
client or the backend deploys straight to the live server with nothing catching it first.

Not fixed because: editing the deploy pipeline itself felt like it needed a deliberate decision
from whoever owns the hackathon server credentials, not a drive-by change bundled into a
restructuring pass.

## Known bugs / risks, deferred on purpose

### Motion fusion can veto or silently retarget a correct identification

Added by the motion-matching feature, separate from (and more behaviourally risky than) anything
pre-existing. When motion is enabled, `targetUnderCrosshair()` routes every shot's target through `fuseMotion()`
(`motion-identity.js` → `motion/matching.js`). When a player's phone-motion correlation comes back
"inconsistent," `fuseMotion` either discards a correct, confident classifier identification
entirely (the shot silently doesn't register) or retargets to a *different* candidate based on
motion correlation alone. Both verdicts come from correlating accelerometer streams across two
phones over a network, and the feature's test suite (`test/motion.test.js`) only covers simulated
motion - not real-world noise like inter-phone clock drift beyond the ±400 ms search window, a
phone in a pocket instead of held, or a backgrounded tab throttling `devicemotion` events.

Separately: motion-confirmed identities skip `isStableTarget()`'s lock-time/score-floor gate
entirely (only `LIVE_TRACK_MS` liveness applies), while classifier-only identities still need it -
an asymmetry that may or may not be intentional.

What *was* done about this: isolated all motion-integration glue into
`frontend/public/motion-identity.js` and made motion an opt-in (`?motion=on` or `?motion=strict`).
Without that flag, the client skips sensor permission, sample sharing, remote motion history and
`fuseMotion`, restoring the exact pre-motion-matching targeting gate - see
[Configuration → Tuning tips](development/configuration.md#tuning-tips). The fusion
logic/thresholds themselves were not touched - that's a tuning decision, not a structural one.

That isolation then leaked in four places, all since closed: `screens/game.js` imported
motion-specific functions, the shared `state` object carried motion fields whether or not the
feature was on, `net.js` had a `case 'motion':`, and motion state was stamped onto the tracker's
own track objects. `frontend/public/identity.js` is now the single seam: it installs one identity
provider at load - `appearance-identity.js` by default, `motion-identity.js` under the flag - and
nothing else in the app names a signal.

One cosmetic side effect of the bypass: with motion off, the overlay now labels a track
only once its identity is stable (lock-time passed), where before the motion commit landed, a
track was labelled as soon as the classifier named it even though only the *shot* required
stability. If the old, looser labelling is wanted back, that's a one-line change in
`frontend/public/screens/game.js`'s draw call.

### A few small, currently-unreachable edges in `identify.js`

Found during the documentation pass, not fixed because none of them are reachable with how the
code calls them today - listed so they don't surprise someone who changes a caller later:

- `matchGallery`'s accept path (`{...best, accepted: true, candidates}`) omits `rankings`, while
  both rejection paths and the closed-set path include it. Unreachable today because
  `frontend/public/screens/game.js` always passes `closedSet: true`, which returns earlier. Would matter if
  open-set mode is ever used live.
- `averageMatches` doesn't carry a `reid` field through, while `similarityParts` produces one.
  Harmless today - only `agreement.score` is read from its result - but asymmetric.
- `fuseMotion({ classifier, opponents, checks, requireMotion })` has no defaults for `opponents`/
  `checks` (unlike `classifier`/`requireMotion`) and would throw on a partial call. Every current
  caller passes both.
- `visualActivity()` divides by box height with no guard against zero. `detectTrackedPeople`
  already filters boxes to `h > 8`, so unreachable in practice.

## Smaller things

- **Circular imports in the new frontend module graph**: `net.js` ↔ `screens/game.js`, `net.js` ↔
  `screens/join.js`, `screens/join.js` ↔ `screens/lobby.js` ↔ `screens/scan.js` ↔ `screens/game.js`,
  and `motion-identity.js` ↔ `net.js`. Currently safe - nothing calls an imported function at
  module-evaluation time, only `app.js` makes top-level calls, after the whole graph has loaded -
  but it's the thing most likely to break if someone adds top-level work to a screen module later.
- **`isStableTarget()` and the `TARGET_*` constants live in `motion-identity.js`**, because
  `classifierOpinion()` is their only caller - but they read like targeting constants that
  conceptually belong next to the rest of the game loop in `screens/game.js`. Moving them would
  create a `game.js` ↔ `motion-identity.js` import cycle, which is why they're there instead.
## Already fixed in this pass (recorded so nobody re-discovers them as open)

- `COUNTDOWN_MS` was `5000` in the Python backend (`backend/models.py`) and `3000` everywhere else
  (`server/game.js`, the client's `GAME_LAUNCH_COUNTDOWN_MS`) - now `3000` everywhere, verified
  live against the running Python backend.
- The Python `clean_vector` sanitizer accepted `NaN`/`Infinity` (only `TypeError`/`ValueError` were
  caught, and `float("nan")` raises neither) - worse than it sounds, since a stored `NaN` comes
  back out through `json_response` as a bare, non-standard JSON token that strict parsers reject,
  breaking the `roster` payload for *every* phone in the room, not just the matching math for one.
  Now filtered with `math.isfinite`, matching the JS sanitizer's `Number.isFinite` check.
- A malformed `zone`, `targetId` or `shooterId` (a JSON list/object instead of a string) crashed
  `Room.shoot`/`api_hit` with an unhandled `TypeError` (HTTP 500) instead of a clean error response.
  Guarded with `isinstance` checks.
- `clearIdentity()` reset every score field except `reid`/`hasReid`, so a track that lost its name
  could keep a stale `hasReid: true` and the debug overlay would print "reid" for an unidentified
  track. Display-only (the gameplay-relevant reader also checks `playerId`, which is cleared) but
  fixed for consistency.
- A duplicated, redundant score check in `detectTrackedPeople`'s pose-fallback filter.
- `server/` archived to `deprecated/server/`, `public/` merged into `frontend/public/` (so the
  frontend's app code lives alongside its Dockerfile, mirroring `backend/`'s shape), and the dead
  frontend code listed above moved to `deprecated/public-dead-code.js`. `package.json`'s `start`/
  `dev` scripts and its now-unused `selfsigned` dependency were removed along with `server/`.
