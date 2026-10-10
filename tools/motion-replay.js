// Replay a recorded motion session through the real matcher.
//
//   node tools/motion-replay.js test/fixtures/motion-session-synthetic.json
//   node tools/motion-replay.js session.json --consistentAt 0.8 --windowMs 4000
//   node tools/motion-replay.js session.json --json
//
// A recording (frontend/public/motion/capture.js, written during a real game with
// ?motion=on&record) holds every input motion/matching.js consumed: each tracked person's box
// observations, the other phones' activity streams as they arrived, this phone's panning flags,
// and the operator's answer to the one question the software cannot answer - which tracked person
// was actually which player. This harness rebuilds the client's state at each of the recorded
// check instants and drives the *real* resample/visualActivity/motionCheck/fuseMotion over it, so
// a session can be measured once and then re-measured after any threshold change.
//
// Faithfulness is not assumed: a recording also stores the verdict the live matcher reached at
// each instant, and the report ends with how many of those the replay reproduced. A nonzero
// mismatch count means this file's reconstruction of the client's state has drifted from
// motion-identity.js, and every number above it should be distrusted until that is fixed.
//
// Deterministic by construction: no clock, no randomness, no I/O beyond reading the file.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fuseMotion, motionCheck, visualActivity } from '../frontend/public/motion/matching.js';

// Must stay in step with motion-identity.js, which is what these mirror.
const MOTION_HISTORY_MS = 12_000; // rolling history kept for boxes, remote samples and ego flags
export const TRUTH_BYSTANDER = 'bystander';
export const TRUTH_UNSURE = 'unsure';

export function parseRecording(text) {
  const recording = typeof text === 'string' ? JSON.parse(text) : text;
  if (recording?.format !== 'laser-tag-motion-session') {
    throw new Error(`not a motion session recording (format: ${JSON.stringify(recording?.format)})`);
  }
  if (recording.version !== 1) throw new Error(`unsupported recording version ${recording.version}`);
  for (const field of ['tracks', 'remote', 'players']) {
    if (!Array.isArray(recording[field])) throw new Error(`recording is missing "${field}"`);
  }
  return recording;
}

// --- rebuilding the client's state at a given instant -----------------------------------------
//
// Each of these mirrors one rolling buffer in motion-identity.js / motion/sensor.js. They take
// the whole recorded series and return the part that existed at time `t`, trimmed the way the
// live code trims it - which matters at the leading edge of the window, where whether a stale
// sample is still present changes how resample() interpolates.

function trimmed(series, t, timeOf) {
  const seen = series.filter((item) => timeOf(item) <= t);
  if (!seen.length) return [];
  const cutoff = timeOf(seen[seen.length - 1]) - MOTION_HISTORY_MS;
  return seen.filter((item) => timeOf(item) >= cutoff);
}

// state.trackMotion.get(track) as of `t`: [{ t, box }].
export function observationsAt(track, t) {
  const seen = trimmed(track.observations, t, (o) => o[0]);
  return seen.map(([at, x, y, w, h]) => ({ t: at, box: { x, y, w, h } }));
}

// state.motion.ego as of `t`: the sensor's rolling buffer of panning flags.
export function egoAt(recording, t) {
  return trimmed(recording.own?.ego ?? [], t, (e) => e[0]).map(([at, v]) => ({ t: at, v }));
}

// state.remoteMotion as of `t`, by replaying the relays that had arrived by then through the same
// merge/sort/trim onRemoteMotion() applies. The trim uses each message's *arrival* time, so this
// has to be a replay rather than a filter.
export function remoteAt(recording, t) {
  const byPlayer = new Map();
  for (const message of recording.remote) {
    if (message.at > t) continue;
    const list = byPlayer.get(message.from) ?? [];
    for (const [at, v] of message.s) if (Number.isFinite(at) && Number.isFinite(v)) list.push({ t: at, v });
    list.sort((a, b) => a.t - b.t);
    const cutoff = message.at - MOTION_HISTORY_MS;
    while (list.length && list[0].t < cutoff) list.shift();
    byPlayer.set(message.from, list);
  }
  return byPlayer;
}

function classifierAt(track, t) {
  let current = { playerId: null, name: null, confident: false, self: false, candidates: [] };
  for (const snapshot of track.classifier ?? []) {
    if (snapshot.t > t) break;
    current = snapshot;
  }
  return current;
}

function opponentsAt(recording, t, selfId) {
  const alive = new Map();
  for (const change of recording.aliveChanges ?? []) {
    if (change.t <= t) alive.set(change.id, change.alive);
  }
  return recording.players
    .filter((player) => player.id !== selfId)
    .map((player) => ({ id: player.id, name: player.name, alive: alive.get(player.id) !== false }));
}

// --- the replay -------------------------------------------------------------------------------

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A pair's standing over the whole session: whichever of the two decided verdicts it reached more
// often. Undecided ticks are counted but never decide, because in the live game a single
// "consistent" tick at the moment of the shot is what confirms a target.
function pairVerdict({ consistent, inconsistent }) {
  if (consistent > inconsistent) return 'consistent';
  if (inconsistent > consistent) return 'inconsistent';
  return consistent ? 'consistent' : 'unknown';
}

export function replay(recording, options = {}) {
  // With overridden thresholds the replayed verdicts are *supposed* to differ from the recorded
  // live ones, so `drift` stops being a faithfulness check. Run the defaults alongside, purely to
  // keep that check available: a retune you cannot trust the reconstruction behind is worthless.
  const baseline = Object.keys(options).length ? { drift: replay(recording).drift } : null;
  const selfId = recording.self?.playerId ?? null;
  const names = new Map(recording.players.map((p) => [p.id, p.name || p.id.slice(0, 6)]));
  const truth = recording.truth ?? {};
  const drift = { compared: 0, mismatches: [] };
  const tracks = [];

  // ?motion=strict changes what fuseMotion does with an unknown check, so the session's own
  // setting is the default; --requireMotion asks the opposite question of the same recording.
  const requireMotion = options.requireMotion ?? recording.flags?.requireMotion ?? false;

  for (const track of recording.tracks) {
    const ticks = (track.liveChecks ?? []).map((entry) => entry.t);
    const pairs = new Map(); // playerId -> tallies
    const fusion = new Map(); // reason -> count
    const outcomes = { right: 0, wrong: 0, none: 0, unscored: 0 };

    const expected = truth[String(track.id)] ?? null;
    // Three kinds of label, and they are scored differently: a player id says one phone must
    // match and the rest must not; "bystander" says none of them may; anything else (or no
    // label at all) means the operator could not say, so this person proves nothing.
    const expectsPlayer = Boolean(expected) && expected !== TRUTH_BYSTANDER && expected !== TRUTH_UNSURE;
    const scored = expectsPlayer || expected === TRUTH_BYSTANDER;

    for (const tick of track.liveChecks ?? []) {
      const observations = observationsAt(track, tick.t);
      // motionChecks() refuses to run on fewer than 5 observations; mirror that exactly.
      const visual = observations.length >= 5 ? visualActivity(observations) : null;
      const ego = egoAt(recording, tick.t);
      const remote = remoteAt(recording, tick.t);
      const checks = {};

      if (visual) {
        for (const [playerId, series] of remote) {
          if (playerId === selfId) continue;
          checks[playerId] = motionCheck({ visual, remote: series, ego, now: tick.t, ...options });
        }
      }

      for (const [playerId, check] of Object.entries(checks)) {
        const tally = pairs.get(playerId) ?? { consistent: 0, inconsistent: 0, unknown: 0, correlations: [], reasons: new Map() };
        tally[check.status]++;
        if (check.correlation != null) tally.correlations.push(check.correlation);
        if (check.reason) tally.reasons.set(check.reason, (tally.reasons.get(check.reason) ?? 0) + 1);
        pairs.set(playerId, tally);
      }

      // Did the live matcher reach the same verdicts from the same inputs?
      for (const [playerId, live] of Object.entries(tick.checks ?? {})) {
        drift.compared++;
        const replayed = checks[playerId];
        if (!replayed || replayed.status !== live.status) {
          drift.mismatches.push({ trackId: track.id, t: tick.t, playerId, live: live.status, replayed: replayed?.status ?? 'absent' });
        }
      }

      // The decision that actually gates a shot, over the recorded classifier opinion.
      const classifier = classifierAt(track, tick.t);
      const fused = fuseMotion({ classifier, opponents: opponentsAt(recording, tick.t, selfId), checks, requireMotion });
      fusion.set(fused.reason, (fusion.get(fused.reason) ?? 0) + 1);
      // A shot taken at this instant: the right player, the wrong one, nobody - or, on a person
      // the operator did not label, something we have no business calling right or wrong.
      // A bystander counts as "wrong" for any named player: nobody in the game is standing there.
      if (!fused.playerId) outcomes.none++;
      else if (!scored) outcomes.unscored++;
      else if (fused.playerId === expected) outcomes.right++;
      else outcomes.wrong++;
    }

    const pairList = [...pairs]
      .map(([playerId, tally]) => ({
        playerId,
        playerName: names.get(playerId) ?? playerId,
        isTruth: playerId === expected,
        verdict: pairVerdict(tally),
        consistent: tally.consistent,
        inconsistent: tally.inconsistent,
        unknown: tally.unknown,
        correlation: { median: median(tally.correlations), max: tally.correlations.length ? Math.max(...tally.correlations) : null },
        reasons: [...tally.reasons].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => Number(b.isTruth) - Number(a.isTruth) || (b.correlation.median ?? -2) - (a.correlation.median ?? -2));

    const own = pairList.find((pair) => pair.isTruth);
    tracks.push({
      id: track.id,
      truth: expected,
      truthName: expectsPlayer ? names.get(expected) ?? expected : expected ?? 'unlabelled',
      expectsPlayer,
      scored,
      observations: track.observations.length,
      seconds: ticks.length ? Math.round((ticks[ticks.length - 1] - ticks[0]) / 100) / 10 : 0,
      ticks: ticks.length,
      // The three ways a labelled person's own phone can come out, in order of how much it costs:
      // identified (shot lands), vetoed (a correct identification is thrown away), unknown.
      selfVerdict: own ? own.verdict : 'no-data',
      // A phone that matched someone it provably is not. Only meaningful where the operator said
      // who this person was; on an unlabelled track we have no idea which matches are wrong.
      falsePositives: scored ? pairList.filter((pair) => !pair.isTruth && pair.verdict === 'consistent') : [],
      pairs: pairList,
      fusion: [...fusion].sort((a, b) => b[1] - a[1]),
      outcomes,
    });
  }

  const labelled = tracks.filter((track) => track.expectsPlayer);
  return {
    meta: {
      synthetic: Boolean(recording.synthetic),
      note: recording.note ?? '',
      room: recording.room ?? '',
      userAgent: recording.userAgent ?? '',
      recordedAt: recording.recordedAt,
      seconds: recording.endedAt && recording.recordedAt ? Math.round((recording.endedAt - recording.recordedAt) / 1000) : null,
      self: recording.self ?? {},
      players: recording.players,
      remoteMessages: recording.remote.length,
      ownSamples: recording.own?.activity?.length ?? 0,
      egoSamples: recording.own?.ego?.length ?? 0,
      options,
    },
    tracks,
    // `drift` compares the replay against the verdicts the recording says the live matcher
    // reached. With default thresholds that is a faithfulness check; with overrides it is the
    // measure of what the retune changed, and `baseline.drift` holds the faithfulness check.
    drift,
    baseline,
    faithfulness: baseline ? baseline.drift : drift,
    totals: {
      tracks: tracks.length,
      labelled: labelled.length,
      identified: labelled.filter((track) => track.selfVerdict === 'consistent').length,
      vetoed: labelled.filter((track) => track.selfVerdict === 'inconsistent').length,
      undecided: labelled.filter((track) => track.selfVerdict !== 'consistent' && track.selfVerdict !== 'inconsistent').length,
      bystanders: tracks.filter((track) => track.truth === TRUTH_BYSTANDER).length,
      cleanBystanders: tracks.filter((track) => track.truth === TRUTH_BYSTANDER && !track.falsePositives.length).length,
      falsePositives: tracks.reduce((sum, track) => sum + track.falsePositives.length, 0),
      unlabelled: tracks.filter((track) => !track.scored).length,
    },
  };
}

// --- report ----------------------------------------------------------------------------------

const num = (value, digits = 2) => (value == null ? '  -  ' : value.toFixed(digits).padStart(5));

export function formatReport(report) {
  const { meta, totals, faithfulness } = report;
  const lines = [];
  const pct = (part, whole) => (whole ? ` (${Math.round((100 * part) / whole)}%)` : '');

  lines.push('Motion session replay');
  lines.push('='.repeat(72));
  if (meta.synthetic) {
    lines.push('!! SYNTHETIC RECORDING - generated data, not a measurement of real phones.');
    if (meta.note) lines.push(`   ${meta.note}`);
    lines.push('');
  }
  lines.push(
    `recorded ${meta.recordedAt ? new Date(meta.recordedAt).toISOString() : '?'}` +
      `${meta.seconds == null ? '' : ` · ${meta.seconds}s`}` +
      `${meta.room ? ` · room ${meta.room}` : ''}`,
  );
  lines.push(`shooter  ${meta.self.name || '?'} (${(meta.self.playerId ?? '?').slice(0, 8)})${meta.userAgent ? ` · ${meta.userAgent}` : ''}`);
  lines.push(`inputs   ${report.tracks.length} tracks · ${meta.players.length} players · ${meta.remoteMessages} relayed motion messages · ${meta.ownSamples} own samples · ${meta.egoSamples} ego flags`);
  const overrides = Object.entries(meta.options);
  lines.push(`matcher  ${overrides.length ? overrides.map(([k, v]) => `${k}=${v}`).join(' ') : 'default thresholds'}`);
  lines.push('');

  for (const track of report.tracks) {
    const label = track.expectsPlayer
      ? `is ${track.truthName}`
      : track.truth === TRUTH_BYSTANDER
        ? 'is a bystander (nobody in the game)'
        : track.truth === TRUTH_UNSURE
          ? 'operator was unsure - not scored'
          : 'UNLABELLED - not scored';
    lines.push(`Track #${track.id} - ${label}`);
    lines.push(`  ${track.observations} box observations, ${track.ticks} checks over ${track.seconds}s`);
    lines.push('    player            verdict      corr(med)  corr(max)   consistent/inconsistent/unknown');
    for (const pair of track.pairs) {
      const mark = pair.isTruth ? '*' : pair.verdict === 'consistent' ? '!' : ' ';
      lines.push(
        `  ${mark} ${pair.playerName.padEnd(16).slice(0, 16)}  ${pair.verdict.padEnd(12)} ` +
          `${num(pair.correlation.median)}      ${num(pair.correlation.max)}      ` +
          `${pair.consistent}/${pair.inconsistent}/${pair.unknown}` +
          `${pair.reasons.length ? `  [${pair.reasons.map(([r, n]) => `${r}×${n}`).join(' ')}]` : ''}`,
      );
    }
    if (track.expectsPlayer) {
      const verdict =
        track.selfVerdict === 'consistent'
          ? 'own phone CONFIRMS this person'
          : track.selfVerdict === 'inconsistent'
            ? 'own phone VETOES this person - a correct identification would be thrown away'
            : `own phone gives no verdict (${track.selfVerdict})`;
      lines.push(`  → ${verdict}`);
    }
    if (track.falsePositives.length) {
      lines.push(`  → FALSE POSITIVE: ${track.falsePositives.map((pair) => pair.playerName).join(', ')} matched someone who is not them`);
    } else if (track.truth === TRUTH_BYSTANDER) {
      lines.push('  → no phone matched this bystander');
    }
    const { right, wrong, none, unscored } = track.outcomes;
    const total = right + wrong + none + unscored;
    lines.push(
      `  → fusion: ${track.fusion.map(([reason, n]) => `${reason}×${n}`).join(' ')} · a shot here would hit ` +
        (track.scored
          ? `the right player ${right}/${total}${pct(right, total)}, the wrong one ${wrong}/${total}, nobody ${none}/${total}`
          : `somebody ${unscored}/${total}, nobody ${none}/${total} - unlabelled, so neither is right or wrong`),
    );
    lines.push('');
  }

  lines.push('Summary');
  lines.push('-'.repeat(72));
  lines.push(`people labelled as players ${totals.labelled}${totals.unlabelled ? ` (+${totals.unlabelled} unlabelled or unsure, not scored)` : ''}`);
  lines.push(`  confirmed by own phone   ${totals.identified}${pct(totals.identified, totals.labelled)}`);
  lines.push(`  vetoed by own phone      ${totals.vetoed}${pct(totals.vetoed, totals.labelled)}`);
  lines.push(`  no verdict               ${totals.undecided}${pct(totals.undecided, totals.labelled)}`);
  lines.push(`bystanders                 ${totals.bystanders}, of which ${totals.cleanBystanders} matched no phone at all`);
  lines.push(`false positives            ${totals.falsePositives} (a phone matched a person it provably is not)`);
  lines.push('');
  const kept = faithfulness.compared - faithfulness.mismatches.length;
  if (!faithfulness.compared) {
    lines.push('faithfulness               no live verdicts recorded - nothing to check the replay against');
  } else if (!faithfulness.mismatches.length) {
    lines.push(`faithfulness               ${kept}/${faithfulness.compared} live verdicts reproduced exactly`);
  } else {
    lines.push(`faithfulness               ${kept}/${faithfulness.compared} live verdicts reproduced`);
    lines.push('  MISMATCH - this harness no longer rebuilds the client state the way motion-identity.js does,');
    lines.push('  so nothing above can be trusted. Compare the rolling buffers in motion-identity.js with');
    lines.push('  observationsAt/egoAt/remoteAt in tools/motion-replay.js.');
    for (const miss of faithfulness.mismatches.slice(0, 10)) {
      lines.push(`    #${miss.trackId} t=${miss.t} ${miss.playerId.slice(0, 8)}: live ${miss.live}, replay ${miss.replayed}`);
    }
    if (faithfulness.mismatches.length > 10) lines.push(`    … ${faithfulness.mismatches.length - 10} more`);
  }

  // What the retune itself did, which is a different question from whether the replay is faithful.
  if (report.baseline) {
    const changed = report.drift.mismatches.length;
    lines.push(
      `retune effect              ${changed}/${report.drift.compared} verdicts differ from the live run` +
        `${changed ? ` (${report.drift.mismatches.slice(0, 3).map((m) => `#${m.trackId} ${m.live}→${m.replayed}`).join(', ')}${changed > 3 ? ', …' : ''})` : ''}`,
    );
  }
  return lines.join('\n');
}

// --- CLI ------------------------------------------------------------------------------------

const NUMERIC_OPTIONS = ['windowMs', 'maxLagMs', 'minValidFraction', 'minVisualSpread', 'minRemoteSpread', 'consistentAt', 'inconsistentAt'];

export function parseArgs(argv) {
  const files = [];
  const options = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--requireMotion') options.requireMotion = true;
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!NUMERIC_OPTIONS.includes(name)) throw new Error(`unknown option ${arg} (try: ${NUMERIC_OPTIONS.map((o) => `--${o}`).join(' ')} --requireMotion --json)`);
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number`);
      options[name] = value;
    } else files.push(arg);
  }
  return { files, options, json };
}

function main(argv) {
  const { files, options, json } = parseArgs(argv);
  if (files.length !== 1) {
    console.error('usage: node tools/motion-replay.js <recording.json> [--windowMs 6000] [--consistentAt 0.75] [--json]');
    process.exitCode = 2;
    return;
  }
  const report = replay(parseRecording(readFileSync(files[0], 'utf8')), options);
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  // A drifted harness is a broken harness; say so in the exit code too. A retune's own
  // divergence from the live verdicts is the expected outcome, not a failure.
  if (report.faithfulness.mismatches.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
