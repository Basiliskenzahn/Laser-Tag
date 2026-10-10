# The motion-only experiment

**This file documents a branch, not the shipped game.** On `motion-only-tracking` the appearance
pipeline is switched off and identity comes purely from phone motion. On `main`/`dev`, motion is
opt-in and appearance does the work.

## Why

Every accuracy number the motion signal has ever had comes from a simulation: a seeded
random-walk/stand schedule with synthetic detector jitter, in `test/motion.test.js`. Nothing has
measured it against a real accelerometer on a real phone watching a real person — see
[Streamlining](streamlining.md). This branch exists to collect that measurement, by removing
every other signal so there is nothing else to credit or blame.

## What changes

| | `dev` | this branch |
| --- | --- | --- |
| Colour signature, MobileNet embedding, OSNet re-id | on | **off** |
| Person detection and frame-to-frame tracking | on | on (unchanged) |
| Phone motion | opt-in (`?motion=on`) | **on, and the only signal** |
| Scanning | required before launch | stubbed — see below |

`?appearance=on` puts the normal pipeline back, on the same build, so the two can be compared
without rebuilding or switching branches.

Nothing in `backend/` changed.

## Running it

1. `docker compose up --build`, open the HTTPS address on every phone.
2. Join the same room code. **Allow the motion prompt** — iOS only asks once, inside the tap that
   enters the lobby, and without it that phone contributes nothing to identify its owner by.
3. Launch. No scanning needed (see below).
4. Walk around. Motion needs people to actually move: two players standing still produce nothing
   to correlate, and will correctly read as "nobody".

### Scanning is stubbed

The backend still refuses to start a round until every player has a gallery. Rather than sit
through a 15-second rotation scan per player to produce data nothing reads, each phone sends a
one-sample stub gallery on join (`MOTION_TEST_STUB_GALLERY` in `net.js`). It satisfies the
launch gate and is never matched against.

It is deliberately obvious — `[{ hist: [1], grid: [1] }]`. If you ever see a *real* gallery in
the roster on this branch, appearance matching is running on garbage and the experiment is
invalid.

## Reading the screen

Every tracked person gets a box as usual, and underneath it a line per player:

```
>  58%  Alice  r+0.88
    0%  Bob    r+0.11
   42%  nobody
```

| Column | Meaning |
| --- | --- |
| `>` | the player this person was actually identified as (absent if nobody was) |
| `58%` | that player's **match share** — see the caveat below |
| `Alice` | the player, `down` appended if they are knocked out |
| `r+0.88` | the raw Pearson correlation between this person's on-screen motion and that player's accelerometer, or the reason there isn't one (`no data`, `person not moving`, `phone not moving`, `unclear`) |

Colours: **green** the chosen player, **amber** a player whose motion is consistent but who was
not chosen, **red** a player whose motion actively contradicts this person, **grey** no usable
data. When nobody is identified, a final line says why:

| Reason | Meaning |
| --- | --- |
| `no data` / `person not moving` / `phone not moving` | Not enough signal to judge — the most common reading, and not a failure |
| `unclear` | Correlation landed between the thresholds |
| `weak` | Best player did not beat the "nobody" share |
| `ambiguous` | Two players both confirmed — a tie, deliberately not a guess |
| `contradicted` | The leading player's motion actively disagrees |
| `no players` | Nobody else in the room |

### The match share is not a probability

It is a normalised affinity derived from the two thresholds `motion/matching.js` was already
tuned to, and it is **not calibrated against real play** — collecting the data that would let
anyone calibrate it is the point of this branch. It is monotonic in the correlation, which is all
the readout needs. The raw `r` is always shown next to it for exactly this reason.

One consequence that looks like a bug and isn't: a single player's share **caps at about 71%**,
because the share reserved for "nobody" is pinned to a correlation sitting exactly on the confirm
threshold. A near-perfect correlation reads as `65%, r+0.92`, never `99%`. That ceiling is the
honest statement that a stranger could always have moved the same way.

The scoring rules are pure functions in `motion/matching.js` (`motionShares`, `motionOnlyMatch`)
and tested in `test/motion-only.test.js` — including the case that matters most, a lone bystander
going to 100% "nobody" rather than being assigned to whichever player correlated least badly.

## What to record

The questions this branch can actually answer:

- **Does a moving player get identified at all, and how long does it take?** The 6-second
  correlation window means motion cannot identify anyone faster than that.
- **How often does a bystander get a name?** Should be near never; the share design makes
  "nobody" the default.
- **How often is the right player beaten by `ambiguous`** when two people move at once — likely
  the dominant failure, since players in the same game tend to move at the same times.
- **Does the ±400 ms clock tolerance hold** between real phones on real networks.
- **What happens with a phone in a pocket**, or a backgrounded tab throttling `devicemotion` —
  both can produce `inconsistent` from noise alone, and on `dev` that is what vetoes a shot.

`?debug` still works and adds the per-phone sensor state (`on` / `no data` / `off`) and who is
sharing samples, which is the first thing to check if everything reads `no data`.
