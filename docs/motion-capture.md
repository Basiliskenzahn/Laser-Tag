# Recording and replaying a motion session

Every accuracy claim the [motion signal](client/identification.md#motion-confirmation-motion) has
ever made comes from a simulation: `test/motion.test.js` generates a seeded random walk/stand
schedule, an accelerometer series at 10 Hz and camera boxes at ~7 detections per second, and the
thresholds in `frontend/public/motion/matching.js` were tuned against exactly that. No real
accelerometer trace from a real phone watching a real person has ever been through the matcher.

That matters because of what the matcher is allowed to do. When a player's phone motion is judged
*inconsistent* with the person under the crosshair, `fuseMotion()` either throws away a correct,
confident appearance identification - the shot silently does not register - or retargets the shot
to a different candidate on motion correlation alone. Both verdicts come out of correlating
accelerometer streams from two phones over a network, and nobody can currently say what that looks
like in a real room.

This is the equipment for finding out: **record a real session once, then replay it into the real
matcher as many times as you like** - including after someone retunes a threshold.

| | |
| --- | --- |
| Record, on the phone | `?motion=on&record` → `frontend/public/motion/capture.js` |
| Replay, under Node | `node tools/motion-replay.js <recording.json>` |
| Worked example | `test/fixtures/motion-session-synthetic.json` (**synthetic**, see below) |
| Regression test | `test/motion-replay.test.js` |

## Recording a session

1. Open the game on the shooter's phone with **`?motion=on&record`** (or `?motion=strict&record`).
   `&record` does nothing without the motion flag, and the recorder module is only fetched when
   the flag is set, so a normal game pays nothing for any of this.
2. Join, scan and launch as usual. Grant the motion-sensor permission when asked - on iOS that
   prompt comes from the join-form tap.
3. Recording starts as soon as the sensor starts. A small panel appears bottom-left:

   ```
   REC 42s · 3 tracks · 84 motion msgs · 210 own samples
   Who is each box? (tap to label)
   #1 (Rex?)  [Rex] [Kai] [bystander] [?]
   #3         [Rex] [Kai] [bystander] [?]
   truth: #1=Rex #3=bystander
   [⬇ save] [copy]
   ```

4. **Label every box while you can still see who it is.** This is the one thing the software
   cannot work out for itself, and it is what turns a recording from a reproducibility fixture
   into an accuracy measurement. Each row is a person the camera is tracking right now; the
   `(Rex?)` in brackets is only what the appearance classifier currently *guesses*, so do not
   copy it - look at the person. Tap `bystander` for someone who is not in the game, and `?` when
   you genuinely cannot tell (those are excluded from scoring rather than counted as mistakes).
   Tapping the same button again clears the label.
5. Tap **⬇ save** to download the JSON, or **copy** to put it on the clipboard. The file lands in
   the phone's Downloads, from where it can be mailed or AirDropped to the machine that runs the
   replay. `window.motionRecording()` returns the same object if you have the phone attached to
   desktop devtools.

Save before the tab goes away: nothing is persisted on the phone and **nothing is sent to the
server**. The backend is deliberately stateless with no storage of its own
([Python backend](server/python-backend.md)), and giving it a place to put uploaded recordings is
a much bigger decision than this harness needs - so the export is entirely client-side.

Keep sessions short. A minute of three tracked people is a few hundred KB and plenty; the matcher
only ever looks at the last 6 seconds, so a long recording is just many independent samples of the
same question.

### What ends up in the file

Exactly the inputs the matcher consumed, on the `Date.now()` clock it compares phones on, plus the
context needed to interpret them later:

| Field | What it is |
| --- | --- |
| `own.activity` | `[[t, v], …]` this phone's own accelerometer activity, as shared with the room |
| `own.ego` | `[[t, v], …]` `1` where this phone was turning too fast to trust its camera image |
| `remote` | `[{at, from, s}, …]` every relayed `motion` message **as received** - `at` is arrival time, `s[][0]` is the sender's clock. Keeping both is what makes clock skew and network latency visible at all |
| `tracks[].observations` | `[[t, x, y, w, h], …]` where the camera saw that person, unrounded |
| `tracks[].classifier` | the appearance classifier's opinion, stored on change |
| `tracks[].liveChecks` | `{t, checks}` the verdict the live matcher actually reached at each check instant |
| `truth` | the operator's labels: track id → player id, `bystander` or `unsure` |
| `players`, `aliveChanges`, `self`, `room`, `userAgent` | who was in the room and which phone this was |

`liveChecks` is what keeps the harness honest - see [faithfulness](#faithfulness) below.

## Replaying it

```bash
node tools/motion-replay.js recording.json
node tools/motion-replay.js recording.json --consistentAt 0.8 --windowMs 4000
node tools/motion-replay.js recording.json --json          # the whole report as JSON
```

The harness rebuilds the client's state - the rolling box history, the remote series as they had
arrived, the panning flags - as of each recorded check instant, and drives the **real**
`resample`, `visualActivity`, `motionCheck` and `fuseMotion` from
`frontend/public/motion/matching.js` over it. Nothing is reimplemented: that file is deliberately
free of browser APIs, which is the whole reason this is possible.

It is deterministic. No clock, no randomness, no network: the same recording in gives the same
verdicts out, so two runs differ only because of what you changed in between.

Any of `motionCheck`'s thresholds can be overridden on the command line (`--windowMs`,
`--maxLagMs`, `--minValidFraction`, `--minVisualSpread`, `--minRemoteSpread`, `--consistentAt`,
`--inconsistentAt`), which is the point: retune a number in
[Configuration](development/configuration.md#motion) and re-score every session you have ever
recorded against it, instead of guessing.

Fusion replays under whichever motion mode the session was recorded in - a `?motion=strict`
recording replays strict, because that flag changes what `fuseMotion` does with an unknown check.
`--requireMotion` forces strict on a non-strict recording, which answers "would strict mode have
been better here" without re-recording anything.

### Reading the output

```
Track #2 - is Kai
  172 box observations, 60 checks over 23.9s
    player            verdict      corr(med)  corr(max)   consistent/inconsistent/unknown
  * Kai               consistent    0.92       0.97      51/0/7  [not enough data×7]
    Rex               inconsistent  0.33       0.63      0/24/34  [unclear×26 not enough data×8]
  → own phone CONFIRMS this person
  → fusion: classifier-only×36 corrected×24 · a shot here would hit the right player 24/60 (40%), …
```

- One block per tracked person, one row per (person, player) pair - the pair the matcher actually
  decides on. `*` marks the player the operator says this person *is*; `!` marks a phone that
  matched someone it provably is not.
- **verdict** is that pair's standing over the whole session: whichever of `consistent` /
  `inconsistent` it reached more often, or `unknown` if neither ever did. The raw
  `consistent/inconsistent/unknown` counts are next to it, and the bracketed reasons say why the
  undecided ones were undecided (`not enough data`, `person not moving`, `phone not moving`,
  `unclear`).
- **corr(med)** and **corr(max)** are the correlation behind the verdict. The gap between a
  player's own row and the next-best row is the margin the 0.75/0.3 thresholds are sitting in; if
  it is small, the thresholds are doing less work than they look like they are.
- **own phone CONFIRMS / VETOES** is the line that matters most. A `VETOES` on a correctly
  labelled person is the failure mode this whole harness exists to detect: the matcher throwing
  away a correct identification.
- **fusion** replays `fuseMotion()` over the recorded classifier opinion, so the last number is
  the decision-relevant one: of all the instants where a shot could have been taken at this
  person, how often it would have hit the right player, the wrong one, or nobody.
- The **summary** aggregates: how many labelled people their own phone confirmed, vetoed or had no
  verdict on; how many bystanders matched no phone at all; and the total false positives.

### Faithfulness

The report ends with a line like

```
faithfulness               348/348 live verdicts reproduced exactly
```

A recording stores the verdict the live matcher reached at each instant, and the replay has to
reproduce every one of them from the raw inputs alone. That is not decoration - it is the only
thing standing between "a harness" and "a harness that quietly measures something else". If the
count is short, `tools/motion-replay.js` no longer rebuilds the client's state the way
`frontend/public/motion-identity.js` keeps it (most likely one of them changed a rolling-buffer
rule), the harness exits non-zero, and **every number above that line should be distrusted** until
it is back to all-reproduced.

When you override a threshold, the replayed verdicts are *supposed* to differ from the recorded
ones, so that comparison moves to its own line and the faithfulness check is re-run at the
defaults alongside it:

```
faithfulness               348/348 live verdicts reproduced exactly
retune effect              67/348 verdicts differ from the live run (#1 unknown→consistent, …)
```

The first line still has to be all-reproduced. The second is the answer to "what did my change
do".

## The synthetic fixture

`test/fixtures/motion-session-synthetic.json` is a complete worked example and the regression
fixture for `test/motion-replay.test.js`. It is **not measured data** - no phone was involved -
and it says so in its own `synthetic` field, in its `note`, in the first line the replay prints,
and in the name of the generator that writes it:

```bash
node tools/make-synthetic-recording.js         # rewrites the committed fixture, byte-identically
```

It exists because a harness with no recording cannot be run, reviewed or regression-tested, and a
real recording needs three phones and three people in a room. It is grown from
`test/motion.test.js`'s generator, and goes further in the ways that specifically matter here:
three separate phone clocks with one 180 ms fast, motion arriving in 500 ms batches over a network
with varying latency rather than as a complete series, two camera pans that drag every box across
the frame, the client's own rolling buffers and 300 ms check throttle, and an appearance classifier
that is wrong about one of the two players so the fusion table's `corrected` branch shows up.

**Do not quote its numbers as accuracy figures.** They describe the simulation, not a phone.

## What this harness cannot tell you

Being blunt about this, because the gap it closes is narrower than it looks.

- **It cannot make synthetic data real.** Until someone records an actual session, the fixture is
  the only recording in the repository, and replaying a simulation tells you nothing about
  accelerometers you did not already know from `test/motion.test.js`. The harness makes a real
  measurement *possible*; it does not constitute one.
- **It cannot answer the open questions on its own.** What a phone in a pocket looks like versus
  one held to aim, whether the ±400 ms clock tolerance holds on a real network, what a
  backgrounded tab throttling `devicemotion` does to a stream - each of those needs a session
  recorded under that condition. The harness will score such a recording once you have one; it
  will not produce one.
- **A recording only knows one phone's point of view.** It is written by the shooter, so it
  contains the other phones' activity *as relayed to this one*. Whether a stream was already
  degraded before it was sent, and what the other phones made of the same people, needs a
  recording from each phone - and there is nothing lining several recordings up for you.
- **The ground truth is a human's answer, typed during a game.** A mislabelled track makes the
  report confidently wrong, in either direction. `unsure` exists for a reason; use it.
- **It cannot see clock error, only clock *offset*.** The matcher's lag search reports the offset
  it liked best, and the recording keeps both clocks, so skew is visible - but there is no
  independent time reference to say which phone was wrong, and nothing here detects a clock that
  jumped mid-session.
- **It does not replay the appearance pipeline.** Detection, signatures, re-identification and the
  tracker are not recorded; the classifier's *opinion* is, as an opaque snapshot. So the fusion
  figures answer "given what the classifier said, what did motion do with it", not "was the
  classifier right". Track identity itself is likewise taken as given: if the tracker swapped two
  people mid-session, the recording inherits the swap and so does the report.
- **It is not a live monitor.** Verdicts are replayed at the instants the live client happened to
  check, which depend on frame timing. A recording cannot tell you what the matcher would have
  said at a moment it never looked.

## Related

- [Identification → Motion confirmation](client/identification.md#motion-confirmation-motion) -
  what the signal is and how `fuseMotion` uses it
- [Configuration → Motion matching](development/configuration.md#motion) - every
  threshold the replay can override
- [Testing](development/testing.md) - both suites, and what they do and don't cover
- [Debug mode](development/debug-mode.md) - the `?debug` overlay's motion line, useful alongside
  `&record`
- [Streamlining candidates](streamlining.md) - the open risk this harness was built for
