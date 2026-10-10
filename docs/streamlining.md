# Streamlining candidates

Things noticed while restructuring the codebase (October 2026) that are worth revisiting, but
were deliberately **not** acted on now - either because they're a product/tuning decision, not
a code-quality one, or because fixing them would have meant changing behaviour in gameplay-
critical code with no automated test or real device to verify against. Each item says why it
wasn't just fixed on the spot.

If you resolve one of these, delete its entry here rather than leaving it to rot alongside a doc
claiming it's still open.

## Structural (highest impact)

### Two complete backend implementations

The game server exists twice: `backend/` (Python, actually deployed) and `server/` (Node,
used only for `npm start`/`npm run dev` and all of the automated tests). Every rule, message
format and validation limit has to be hand-ported between two languages to stay in sync - and it
already has drifted at least once (`COUNTDOWN_MS` was out of sync between the two until this
pass; see [Contributing → Keep both backends in sync](development/contributing.md#keep-both-backends-in-sync)).
Worse: the CI workflow (`.github/workflows/ci-cd-action.yml`) runs no tests at all before
deploying - it only runs `npm test`, which exercises the Node implementation, and even that isn't
wired into the actual deploy gate. **The backend that's live has zero automated verification.**

Not fixed because: picking one backend and deleting the other is a product decision (does local
dev without Docker matter enough to keep the Node path alive?), not a refactor. Flagging it is as
far as this pass goes.

### No CI test gate before deploy

`.github/workflows/ci-cd-action.yml` triggers on every PR merge to `main` and does exactly one
thing: SSH in and `docker compose up --build -d`. There's no step that runs `npm test`, let alone
anything for the Python backend, before that happens. `docker-compose.yml` has a `tests` profile
(`docker compose run --rm tests`) that would run the JS suite in a container, but nothing invokes
it automatically.

Not fixed because: editing the deploy pipeline itself felt like it needed a deliberate decision
from whoever owns the hackathon server credentials, not a drive-by change bundled into a
restructuring pass.

## Known bugs / risks, deferred on purpose

### `shape` similarity is silently broken in colour-only matching

Found while documenting `identify.js`. `shapeSignature()` returns a raw `[aspect,
heightRatio/widthRatio]` pair. Live signatures keep that raw; but every **gallery** entry is the
output of `averageSignatures()`, which runs everything (including `shape`) through
`averageVectors()` - which L2-**normalises**. So a live signature's `shape` vector and the
matching gallery sample's `shape` vector are on different scales, and `shapeSimilarity()` (the
one comparison in the file that isn't scale-invariant) compares them anyway. Measured for a
typical box: live `[2.25, 3.0]` vs. the same person's gallery entry `[0.6, 0.8]` - `shapeSimilarity`
returns 0 instead of ~1.

Practical effect: `MIN_SHAPE_SCORE` (0.36) always rejects on the colour-only path, and because
`EVIDENCE_MIN_PART` requires the same floor, **the evidence accumulator never fires in colour-only
mode** - identification there rests entirely on the closed-set forced-accept path and the
`INITIAL_STREAK` fast-lock, bypassing the slower, more careful evidence-based path the other three
signals get. `identify.test.js` doesn't catch this because its hand-built test galleries use raw
`shape` values on both sides, matching the bug's assumption.

Not fixed because: normalising consistently, or making `shapeSimilarity` scale-invariant, changes
real matching behaviour and would need re-tuning `MIN_SHAPE_SCORE`/`EVIDENCE_MIN_PART` afterward -
a product-quality tradeoff, not a mechanical fix.

### Motion fusion can veto or silently retarget a correct identification

Added by the motion-matching feature, separate from (and more behaviourally risky than) anything
pre-existing. `targetUnderCrosshair()` routes every shot's target through `fuseMotion()`
(`motion-identity.js` → `motion/matching.js`). When a player's phone-motion correlation comes back
"inconsistent," `fuseMotion` either discards a correct, confident classifier identification
entirely (the shot silently doesn't register) or retargets to a *different* candidate based on
motion correlation alone. Both verdicts come from correlating accelerometer streams across two
phones over a network, and the feature's test suite (`test/motion.test.js`) only covers simulated
motion - not real-world noise like inter-phone clock drift beyond the ±400 ms search window, a
phone in a pocket instead of held, or a backgrounded tab throttling `devicemotion` events. None of
that is reachable from this phone's own sensor permission either: other players' shared samples
still get correlated against what your camera sees, so denying local motion access doesn't opt you
out.

Separately: motion-confirmed identities skip `isStableTarget()`'s lock-time/score-floor gate
entirely (only `LIVE_TRACK_MS` liveness applies), while classifier-only identities still need it -
an asymmetry that may or may not be intentional.

What *was* done about this (this pass): isolated all motion-integration glue into
`public/motion-identity.js` behind one function, `resolveIdentity()`, and added a real opt-out,
`?motion=off`, which bypasses `fuseMotion` entirely and restores the exact pre-motion-matching
targeting gate - see [Configuration → Tuning tips](development/configuration.md#tuning-tips). That
makes it possible to A/B test whether motion fusion is actually the source of a given reported bug,
which wasn't possible before. The fusion logic/thresholds themselves were not touched - that's a
tuning decision, not a structural one.

One cosmetic side effect of adding the bypass: under `?motion=off`, the overlay now labels a track
only once its identity is stable (lock-time passed), where before the motion commit landed, a
track was labelled as soon as the classifier named it even though only the *shot* required
stability. If the old, looser labelling is wanted back, that's a one-line change in
`public/screens/game.js`'s draw call.

### A few small, currently-unreachable edges in `identify.js`

Found during the documentation pass, not fixed because none of them are reachable with how the
code calls them today - listed so they don't surprise someone who changes a caller later:

- `matchGallery`'s accept path (`{...best, accepted: true, candidates}`) omits `rankings`, while
  both rejection paths and the closed-set path include it. Unreachable today because
  `public/screens/game.js` always passes `closedSet: true`, which returns earlier. Would matter if
  open-set mode is ever used live.
- `averageMatches` doesn't carry a `reid` field through, while `similarityParts` produces one.
  Harmless today - only `agreement.score` is read from its result - but asymmetric.
- `fuseMotion({ classifier, opponents, checks, requireMotion })` has no defaults for `opponents`/
  `checks` (unlike `classifier`/`requireMotion`) and would throw on a partial call. Every current
  caller passes both.
- `visualActivity()` divides by box height with no guard against zero. `detectTrackedPeople`
  already filters boxes to `h > 8`, so unreachable in practice.

## Dead code (left in place, not deleted)

Found while splitting `public/app.js` - verbatim-moved rather than deleted, since nothing here was
asked to be cleaned up and deleting UI code without being able to run the app in a browser felt
like the wrong moment to guess:

- `hasScan()` in `public/roster.js` (or wherever it landed) - never called, before or after the
  split.
- A whole unreachable manual-capture scan path: `captureScanSignature`, `recordScanCapture`,
  `useSavedScan`, `clearScanCache`, `currentScanBoxes` in `public/screens/scan.js`. `index.html`
  has no buttons wired to any of them - the UI moved to the automatic rotation-scan flow and this
  is what's left of the manual one.
- `updateScanButtons()` and `renderSavedScan()` are empty no-op functions, still called from six
  places. Leftovers of removed UI elements.

## Smaller things

- **Circular imports in the new frontend module graph**: `net.js` ↔ `screens/game.js`, `net.js` ↔
  `screens/join.js`, `screens/join.js` ↔ `screens/lobby.js` ↔ `screens/scan.js` ↔ `screens/game.js`,
  and `motion-identity.js` ↔ `net.js`. Currently safe - nothing calls an imported function at
  module-evaluation time, only `app.js` makes top-level calls, after the whole graph has loaded -
  but it's the thing most likely to break if someone adds top-level work to a screen module later.
- **`package.json`'s `start`/`dev` scripts** still launch the Node dev server, which is itself the
  "two backends" streamlining candidate above - not wrong, just worth remembering they're not
  exercising what's actually deployed.
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
