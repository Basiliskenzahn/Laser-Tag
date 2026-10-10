# `luxkaiwalker-dev` — integration branch

**Owner: LuxKaiwalker.** A staging branch, not a feature branch and not a deploy target.

## Purpose

Collect the work from one working session, verify it together, and open **one** pull request into
`dev` rather than several competing ones. Several of the changes below touch the same files
(`identify.js`, `motion-identity.js`, `env.js`, `screens/game.js`), so merging them here first is
what makes the conflicts resolvable in one pass instead of three.

Nothing lands on `dev` from here until the whole set passes both test suites together:

```bash
npm test                                              # 19 JS tests
python -m unittest discover -s backend -p "test_*.py" # 28 backend tests
```

## What merges here

| Branch | Status | What it does |
| --- | --- | --- |
| `luxkaiwalker/tracking-smoothing` | **merged** | Position and velocity now have separate exponential time constants instead of one shared per-detection blend factor. Trailing 22.6 px → 7.5 px *and* velocity noise 18 → 12 px/s; the old coupling meant you could only trade one for the other. Interval-independent, which matters because the detection interval isn't fixed |
| `luxkaiwalker/motion-isolation` | **merged** | Motion is now behind one seam, `identity.js`, which installs a single provider at load. `screens/game.js`, `net.js`, `state.js` and `app.js` contain zero occurrences of the word "motion" |
| `luxkaiwalker/scan-optimisation` | **merged** | Select-then-embed: OSNet now runs on the frames backing chosen samples rather than every usable frame, pose becomes a rescue-only pass, detection moves to 512 px, thumbnails deferred. **240 → 150 model inferences per scan.** Plus rewritten scanning/detection/identification docs |

### Breaking change to be aware of

`motion-identity.js` now exports **only** `motionIdentity`. `startMotion`, `onRemoteMotion`,
`recordTrackMotion`, `resolveIdentity` and `motionDebugLine` are no longer exported, and
`state.motion` / `state.remoteMotion` / `state.trackMotion` are gone (the provider keeps its own
module-private state and a `WeakMap` keyed on tracks).

That is the point — it's what makes the feature removable — but it means any branch that imported
those names needs rework before it can rebase onto this. `luxkaiwalker/motion-only-tracking` is
the known case: it imports four of them and adds a `track.motionBreakdown` field, which now has
to become another entry in the provider's `WeakMap` rather than a property on the track.

## What deliberately does *not* merge here

Experiment and test-harness branches stay separate — they are instruments, not product:

| Branch | Why it stays out |
| --- | --- |
| `luxkaiwalker/motion-only-tracking` | Disables appearance identification entirely and stubs the scan gate. A measuring rig for the motion signal; see [the motion-only experiment](docs/motion-only-experiment.md) |
| `luxkaiwalker/motion-capture-harness` | Capture/replay tooling for real accelerometer data. Test infrastructure, so it stays out — but its `backend/sanitize.py` fix **has** been taken here (motion samples were truncated from the oldest end, discarding exactly the recent samples the 6 s correlation window needs), along with `backend/test_sanitize.py`. **Note it is now stale against this branch:** it hooks `motion-identity.js`, which `motion-isolation` has since rewritten |

## Also on this branch

[`docs/detection-pipeline-audit.md`](docs/detection-pipeline-audit.md) — the per-feature audit of
the identification pipeline: what each signal costs, how accurate it is, and which of those
numbers are measured versus simulated. It carries its own "partly superseded" note, since motion
has since become opt-in and `detection-tuning` has improved several of the costs it quotes.

## Related work not from this session

`detection-tuning` (Basiliskenzahn) is the larger performance change in this area — colour
features skipped when re-identification covers the room, OSNet in a Web Worker, raised cadence,
re-id thresholds actually enforced. It is **not** merged into `dev` yet and is not merged here.
Anything in this branch that touches the same ground is written to compose with it rather than
collide; `luxkaiwalker/tracking-smoothing` in particular deliberately avoids reimplementing its
`liveBox()`.
