// The `?debug` input readout: why the FIRE button feels laggy, split into the two costs that have
// different fixes.
//
// The field complaint is "there is some kind of lag if i press the button since other stuff needs
// to be processed as well", and that is two completely separate delays added together:
//
//   delivery wait      the tap sat in the browser's input queue while the main thread was inside
//                      a detection. Browsers do not preempt running JavaScript, so a pointerdown
//                      that arrives mid-inference waits for that inference to return. Nothing in
//                      fire() can shorten this - it is already over before fire() is entered. The
//                      fix is upstream: do not start an inference when input is pending, or do not
//                      run inference on this thread at all.
//   shot resolve       the time fire() itself spends between being entered and handing the shot to
//                      the server. Feedback (the shot sound and the button flash) is already out
//                      by then, so this delays the *hit confirmation*, not the trigger feel.
//
// Those are indistinguishable from the sofa - both read as "the button is laggy" - and they have
// opposite fixes, so guessing which one dominates is how you end up optimising the wrong half.
// Hence the line. Plus the longest blocking chunk seen recently, because delivery wait is bounded
// above by one blocking chunk and an average hides the one that made the player complain.
//
// Pure and DOM-free on purpose, with no module-level mutable state: the stats object is owned by
// screens/game.js (next to `fps` and `inferenceMs`) and every call here sits inside its
// `if (DEBUG)` branch, so none of this runs without `?debug` and all of it can be unit-tested
// without a browser (test/input-latency.test.js).

// Shots kept for the tap/resolve figures. Firing is cooldown-limited to under three shots a
// second, so this is a few seconds of sustained firing - recent enough to reflect where you are
// standing now, long enough that the numbers do not vanish the moment you stop.
export const SHOT_SAMPLES = 8;

// The blocking-chunk maximum is kept over two half-windows of this length and reported as the
// larger of the two, so what you read always covers at least one of these and at most two. A
// single window would drop the worst chunk the instant it rolled over, which is exactly the
// reading you walked over to the phone to see.
export const BLOCK_WINDOW_MS = 2000;

// A frame gap longer than this is not a blocking chunk. requestAnimationFrame stops entirely when
// the tab is hidden or the phone sleeps, and counting that as "the main thread blocked for 40
// seconds" would make the worst case unreadable for the rest of the session.
export const MAX_PLAUSIBLE_BLOCK_MS = 1000;

// A delivery wait longer than this is not a delivery wait. It means `event.timeStamp` was not on
// the same time origin as performance.now() (see deliveryWait), and a wrong number here is worse
// than no number: the whole point of the line is to size one delay against another.
export const MAX_PLAUSIBLE_WAIT_MS = 10000;

// performance.now() and event timestamps can be coarsened for privacy, and a handler can run in
// the same tick the event was created in, so a delivery wait may come out very slightly negative.
// That is zero, not a bad reading.
const NEGATIVE_TOLERANCE_MS = 2;

export function emptyInputStats() {
  return { shots: [], blockCurrent: 0, blockPrevious: 0, blockWindowStart: 0 };
}

// How long the tap waited before our handler ran.
//
// `event.timeStamp` on a trusted pointer event is a DOMHighResTimeStamp on *this document's* time
// origin - the same origin performance.now() counts from - and it is set when the browser created
// the event from the platform input, not when a listener for it ran. So the difference between
// entering the handler and that stamp is precisely the queueing delay, including the part spent
// behind a synchronous inference that had already started. Reading the clock at the top of the
// handler instead would measure nothing: by then the wait is over.
//
// That reasoning is only as good as the timestamp, so it is not taken on trust. Everything that
// would make it false - a synthesized event stamped 0, a legacy event stamped in Unix epoch
// milliseconds, a stamp from a different time origin - comes out as a number that is impossible
// for a queueing delay, and each is returned as null rather than printed as a measurement.
export function deliveryWait(eventTimeStamp, entryAt) {
  if (!Number.isFinite(eventTimeStamp) || !Number.isFinite(entryAt)) return null;
  // A stamp of exactly 0 is the page's time origin. Some synthesized events carry it, and taken
  // literally it would report the entire lifetime of the page as input lag.
  if (eventTimeStamp === 0) return null;
  const wait = entryAt - eventTimeStamp;
  // Hugely negative is the epoch-milliseconds case: a stamp of ~1.7e12 against a page that has
  // been open for seconds. Slightly negative is clock coarsening.
  if (wait < -NEGATIVE_TOLERANCE_MS) return null;
  if (wait > MAX_PLAUSIBLE_WAIT_MS) return null;
  return Math.max(0, wait);
}

// One shot's two costs. `stats` is mutated and returned: this runs at most a few times a second
// and only under ?debug, but allocating a fresh stats object per shot would be pure waste.
export function recordShot(stats, { eventTimeStamp = null, entryAt, resolvedAt } = {}) {
  if (!stats) return stats;
  const tap = deliveryWait(eventTimeStamp, entryAt);
  const resolve = Number.isFinite(entryAt) && Number.isFinite(resolvedAt) && resolvedAt >= entryAt ? resolvedAt - entryAt : null;
  stats.shots.push({ tap, resolve });
  if (stats.shots.length > SHOT_SAMPLES) stats.shots.splice(0, stats.shots.length - SHOT_SAMPLES);
  return stats;
}

// One frame-to-frame gap, which is how long the main thread was unavailable to anything -
// including a tap. This is the ceiling on delivery wait, and the number that says whether the
// ceiling is one inference or several things in a row.
export function recordBlock(stats, gap, now) {
  if (!stats || !Number.isFinite(gap) || !Number.isFinite(now)) return stats;
  if (gap <= 0 || gap > MAX_PLAUSIBLE_BLOCK_MS) return stats;
  const elapsed = now - stats.blockWindowStart;
  if (elapsed >= BLOCK_WINDOW_MS) {
    // Two or more windows with nothing recorded means the previous half-window is stale too.
    stats.blockPrevious = elapsed >= BLOCK_WINDOW_MS * 2 ? 0 : stats.blockCurrent;
    stats.blockCurrent = 0;
    stats.blockWindowStart = now;
  }
  if (gap > stats.blockCurrent) stats.blockCurrent = gap;
  return stats;
}

export function longestBlock(stats) {
  if (!stats) return 0;
  return Math.max(stats.blockCurrent, stats.blockPrevious);
}

function ms(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '-';
}

// Mean and worst of one field across the kept shots, as `mean/worst`. Both, because the mean is
// what the round feels like on average and the worst is what the player actually complained
// about, and one without the other has sent people optimising the wrong thing before.
function spread(shots, field) {
  const values = shots.map((shot) => shot[field]).filter((value) => Number.isFinite(value));
  if (!values.length) return '-/-';
  const total = values.reduce((sum, value) => sum + value, 0);
  return `${ms(total / values.length)}/${ms(Math.max(...values))}`;
}

// The readout: one line, all figures in milliseconds. '' when there is nothing to say yet - no
// shots fired and no frame gap measured - because a line of dashes reads like a measurement.
//
//   Input tap 12/104 shot 2/3 n4 · block 96
//
// `tap` is the delivery wait, `shot` is fire() entry to the shot leaving for the server, `n` is
// how many shots those are over, `block` is the longest single frame gap in the last few seconds.
// A large `tap` next to a `block` of about the same size is the reported bug: the tap is sitting
// behind one inference. A large `shot` is a different bug, in what fire() does before it sends.
export function inputLatencyLine(stats) {
  if (!stats) return '';
  const block = longestBlock(stats);
  const shots = stats.shots ?? [];
  if (!shots.length) return block > 0 ? `Input block ${ms(block)}` : '';
  let line = `Input tap ${spread(shots, 'tap')} shot ${spread(shots, 'resolve')} n${shots.length}`;
  if (block > 0) line += ` · block ${ms(block)}`;
  return line;
}
