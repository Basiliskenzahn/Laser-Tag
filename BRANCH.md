# `luxkaiwalker-dev` — integration branch

**Owner: LuxKaiwalker.** A staging branch, not a feature branch and not a deploy target.

## Purpose

Collect the work from one working session, verify it together, and open **one** pull request into
`dev` rather than several competing ones. Several of the changes below touch the same files
(`identify.js`, `motion-identity.js`, `env.js`, `screens/game.js`), so merging them here first is
what makes the conflicts resolvable in one pass instead of three.

Nothing lands on `dev` from here until the whole set passes both test suites together:

```bash
npm test                                              # 22 JS tests
python -m unittest discover -s backend -p "test_*.py" # 28 backend tests
```

## What merges here

| Branch | What it does |
| --- | --- |
| `luxkaiwalker/tracking-smoothing` | Reduce overlay lag from box smoothing without making the velocity estimate noisier — which matters because association quality depends on it, and `detection-tuning`'s `liveBox()` extrapolates along it |
| `luxkaiwalker/motion-isolation` | Close the leaks in the motion seam so the feature is a module you could delete or swap at one place, rather than one referenced from the game loop, the transport layer and the shared state object |

## What deliberately does *not* merge here

Experiment and test-harness branches stay separate — they are instruments, not product:

| Branch | Why it stays out |
| --- | --- |
| `luxkaiwalker/motion-only-tracking` | Disables appearance identification entirely and stubs the scan gate. A measuring rig for the motion signal; see [the motion-only experiment](docs/motion-only-experiment.md) |
| `luxkaiwalker/motion-capture-harness` | Capture/replay tooling for real accelerometer data, plus a `backend/sanitize.py` truncation fix. The fix is worth cherry-picking on its own; the harness is test infrastructure |

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
