// The `?debug` range readout: one line that says why the people on screen are, or are not, being
// identified.
//
// The field complaint is "players too far away aren't recognised", and that has two completely
// different causes with opposite fixes:
//
//   the detector never finds them     -> no box exists. A gate change buys nothing; it needs a
//                                        second region-of-interest detection pass, which costs up
//                                        to half the detection cadence on a slow phone.
//   it finds them and we refuse them  -> a box exists, and `boxQuality` throws it away for being
//                                        under MIN_MATCH_HEIGHT_RATIO before a single feature is
//                                        scored. Admitting that band is cheap.
//
// You cannot tell those apart by looking at the screen - both show nothing but "Person" - so the
// line puts the three numbers that separate them next to each other: how many boxes the detector
// returned, how tall each one is as a fraction of frame height, and the gate that fraction is
// being compared against. If boxes is 0 while someone is plainly standing there, it is the first
// case. If boxes is 1 and its height is under the gate, it is the second, and the refusal tallies
// say which gate did it.
//
// Pure and DOM-free on purpose. Everything here is called from exactly one place - inside the
// `if (DEBUG)` branch of the frame loop in screens/game.js - so none of it runs without `?debug`,
// and it can be unit-tested without a browser (test/range-readout.test.js).

// At most this many box heights, biggest first. A phone screen in sunlight has room for about
// this much, and the biggest box is the one you are most likely to be pointing at.
export const MAX_SHOWN_HEIGHTS = 4;

// `0.413` -> `.41`. Dropping the leading zero buys a character back on every number in the line,
// and two decimals is the whole precision anyone can act on.
export function ratio(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1) return value.toFixed(1);
  if (value <= 0) return '0';
  return value.toFixed(2).replace(/^0/, '');
}

// Which side of which threshold this box height falls on, which is the entire point of the line:
//
//   (none)  at or above the live gate: a box the matcher will score
//   *       between the far floor and the gate: the band a far-re-identification path could admit
//   -       below the far floor: too few pixels for any gate change to rescue
//
// With no far floor known, everything under the gate is `*` - still the useful distinction,
// because `*` always means "detected but refused".
export function heightMark(heightRatio, gate, floor = null) {
  if (!Number.isFinite(heightRatio) || !Number.isFinite(gate)) return '';
  if (heightRatio >= gate) return '';
  if (Number.isFinite(floor) && heightRatio < floor) return '-';
  return '*';
}

// Short labels for rangeDiagnostics(), in the order a box meets the gates. `ok` is always shown,
// even at zero - "ok0" is a result, and a loud one. The rest appear only when non-zero, so the
// reason that is actually firing is the thing your eye lands on instead of being lost in zeroes.
const REFUSAL_LABELS = [
  ['ok', 'ok'],
  ['tooFar', 'far'],
  ['farReid', 'reid'],
  ['belowFloor', 'low'],
  ['partialBody', 'part'],
  ['edgeClipped', 'clip'],
];

export function refusalTallies(diagnostics) {
  if (!diagnostics) return '';
  const parts = [];
  for (const [key, label] of REFUSAL_LABELS) {
    const count = diagnostics[key];
    if (!Number.isFinite(count)) continue;
    if (key === 'ok' || count > 0) parts.push(`${label}${count}`);
  }
  return parts.join(' ');
}

// One named track's identification score next to its box height - the pairing that tests the
// hypothesis that score degrades with distance. The score is the re-identification cosine when
// re-identification decided the match, and the colour blend (marked `c`) when it did not, because
// those two are on different scales and must never be read as one series.
function namedEntry(track, videoHeight) {
  const score = track.hasReid ? track.reid : track.score;
  const mark = track.hasReid ? '' : 'c';
  return `${track.name ?? '?'} ${mark}${ratio(score)}@${ratio((track.box?.h ?? 0) / videoHeight)}`;
}

// The readout: one line, plus a second only when somebody on screen has a name. '' when there is
// nothing meaningful to say yet (no video dimensions, so no ratio to report).
//
// `tracks` is the already-filtered list of live tracks. `boxes` is the raw detections from the
// latest pass - the count comes from there rather than from the tracks, because "the detector
// returned nothing" is the signal that distinguishes the two failure modes, and a track can coast
// for half a second after its box is gone.
export function rangeReadout({
  boxes = [],
  tracks = [],
  videoHeight = 0,
  selfId = null,
  diagnostics = null,
  gate = null,
  floor = null,
} = {}) {
  if (!(videoHeight > 0)) return '';

  // Prefer the tracks' boxes, because those are the ones the matcher actually measured, and fall
  // back to the raw detections on screens that detect without tracking (the scan preview).
  const measured = tracks.length ? tracks.map((t) => t.box) : boxes;
  const heights = measured
    .map((box) => (box?.h ?? 0) / videoHeight)
    .filter((h) => h > 0)
    .sort((a, b) => b - a)
    .slice(0, MAX_SHOWN_HEIGHTS);

  let line = `Range ${boxes.length}box`;
  if (heights.length) line += ` h ${heights.map((h) => ratio(h) + heightMark(h, gate, floor)).join(' ')}`;
  if (Number.isFinite(gate)) line += ` ≥${ratio(gate)}${Number.isFinite(floor) ? `/${ratio(floor)}` : ''}`;
  const tallies = refusalTallies(diagnostics);
  if (tallies) line += ` · ${tallies}`;

  const named = tracks.filter((t) => t.playerId && t.playerId !== selfId);
  if (!named.length) return line;
  return `${line}\nDist ${named.map((t) => namedEntry(t, videoHeight)).join(' ')}`;
}
