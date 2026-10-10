// Recording a real game session so the motion matcher can be re-run on it offline.
//
// Everything the matcher's accuracy claims rest on today comes from the simulation in
// test/motion.test.js. This module is the other half: with ?motion=on&record it writes down the
// exact inputs motion/matching.js consumed during a real round - this phone's accelerometer
// activity and panning flags, every tracked person's box observations, and the other phones'
// activity streams as they arrived off the network - plus the live verdict the matcher reached at
// each check. tools/motion-replay.js then drives the same pure functions over that file and can
// prove it reproduces those verdicts, or show how they change after a threshold is retuned.
//
// The one thing the software cannot know is which tracked person was actually which player, so
// the on-screen panel asks the operator; without that ground truth a recording is only a
// reproducibility fixture, not an accuracy measurement.
//
// Timestamps are all Date.now(), the same clock the matcher compares phones on.
//
// Loaded only when the flag is set (motion-identity.js imports it dynamically), so a normal game
// never fetches this file and pays nothing for it.

export const FORMAT = 'laser-tag-motion-session';
export const FORMAT_VERSION = 1;

// Panel labels for a track whose ground truth is not one of the players.
export const TRUTH_BYSTANDER = 'bystander'; // a real person, but nobody in the game
export const TRUTH_UNSURE = 'unsure'; // the operator could not tell - excluded from scoring

export class MotionRecorder {
  constructor({ userAgent = '', startedAt = Date.now(), flags = {} } = {}) {
    this.startedAt = startedAt;
    this.userAgent = userAgent;
    // The matcher settings this session ran under. `requireMotion` (?motion=strict) changes what
    // fuseMotion does with an unknown check, so a replay has to know it to reach the same answer.
    this.flags = { requireMotion: false, ...flags };
    this.own = { activity: [], ego: [] };
    this.remote = []; // [{ at, from, s }] exactly as onRemoteMotion received it
    this.tracks = new Map(); // trackId -> { id, observations, classifier, liveChecks }
    this.players = new Map(); // playerId -> name, as seen at any point in the session
    this.alive = new Map(); // playerId -> last known aliveness
    this.aliveChanges = []; // [{ t, id, alive }] - fuseMotion only considers living opponents
    this.truth = new Map(); // trackId -> playerId | TRUTH_BYSTANDER | TRUTH_UNSURE
    this.self = { playerId: null, name: '' };
    this.room = '';
    this.egoSeen = 0; // highest ego timestamp already copied out of the sensor's rolling buffer
  }

  track(id) {
    let entry = this.tracks.get(id);
    if (!entry) {
      entry = { id, observations: [], classifier: [], liveChecks: [] };
      this.tracks.set(id, entry);
    }
    return entry;
  }

  // This phone's own activity, taken from the samples it is about to share (sensor.flush()
  // rounds them, so these are the numbers the other phones will actually correlate against).
  ownActivity(samples) {
    for (const [t, v] of samples) this.own.activity.push([t, v]);
  }

  // The sensor keeps only a rolling 12 s of ego flags, so copy whatever is new on every frame.
  ownEgo(ego) {
    for (const { t, v } of ego) {
      if (t > this.egoSeen) {
        this.own.ego.push([t, v]);
        this.egoSeen = t;
      }
    }
  }

  remoteMotion(from, samples, at = Date.now()) {
    if (!samples.length) return;
    this.remote.push({ at, from, s: samples.map(([t, v]) => [t, v]) });
  }

  boxes(tracks, at = Date.now()) {
    for (const { id, box } of tracks) {
      this.track(id).observations.push([at, box.x, box.y, box.w, box.h]);
    }
  }

  // The classifier's opinion, stored only when it changes - it is steady for seconds at a time.
  classifier(trackId, opinion, at = Date.now()) {
    const entry = this.track(trackId);
    const last = entry.classifier[entry.classifier.length - 1];
    const same =
      last &&
      last.playerId === (opinion.playerId ?? null) &&
      last.confident === Boolean(opinion.confident) &&
      last.self === Boolean(opinion.self) &&
      String(last.candidates) === String(opinion.candidates ?? []);
    if (same) return;
    entry.classifier.push({
      t: at,
      playerId: opinion.playerId ?? null,
      name: opinion.name ?? null,
      confident: Boolean(opinion.confident),
      self: Boolean(opinion.self),
      candidates: [...(opinion.candidates ?? [])],
    });
  }

  // What motionCheck() returned for this person against every sharing phone, at wall-clock `at`
  // - the `now` the replay has to use to reach the same answer.
  liveChecks(trackId, checks, at) {
    const compact = {};
    for (const [playerId, check] of Object.entries(checks)) {
      compact[playerId] = {
        status: check.status,
        ...(check.correlation == null ? {} : { correlation: check.correlation }),
        ...(check.lagMs == null ? {} : { lagMs: check.lagMs }),
        ...(check.reason ? { reason: check.reason } : {}),
      };
    }
    this.track(trackId).liveChecks.push({ t: at, checks: compact });
  }

  // The roster/snapshot as it stands now. Only `alive` is time-dependent, and only its
  // transitions are stored - a dead player is no longer a candidate for fuseMotion.
  seePlayers(players, at = Date.now()) {
    for (const player of players) {
      if (!player?.id) continue;
      this.players.set(player.id, player.name ?? '');
      if (player.alive === undefined) continue;
      const alive = player.alive !== false;
      if (this.alive.get(player.id) !== alive) {
        this.alive.set(player.id, alive);
        this.aliveChanges.push({ t: at, id: player.id, alive });
      }
    }
  }

  setTruth(trackId, value) {
    if (value == null) this.truth.delete(trackId);
    else this.truth.set(trackId, value);
  }

  get seconds() {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  // The file tools/motion-replay.js reads. Tracks with no usable observations are dropped.
  toJSON() {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      synthetic: false,
      recordedAt: this.startedAt,
      endedAt: Date.now(),
      userAgent: this.userAgent,
      room: this.room,
      flags: this.flags,
      self: this.self,
      players: [...this.players].map(([id, name]) => ({ id, name })),
      aliveChanges: this.aliveChanges,
      own: this.own,
      remote: this.remote,
      tracks: [...this.tracks.values()].filter((t) => t.observations.length >= 2),
      truth: Object.fromEntries([...this.truth].map(([id, value]) => [String(id), value])),
    };
  }
}

// ---------------------------------------------------------------------------
// The operator's panel: the only way the ground truth gets into the recording.
// Self-contained DOM, so nothing in the game loop or the stylesheet has to know it exists.
// ---------------------------------------------------------------------------

const PANEL_CSS = {
  position: 'fixed',
  left: '8px',
  bottom: '8px',
  zIndex: '10',
  maxWidth: 'min(62vw, 360px)',
  maxHeight: '46vh',
  overflowY: 'auto',
  padding: '6px 8px',
  borderRadius: '8px',
  background: 'rgba(8, 12, 18, 0.82)',
  color: '#e6edf3',
  font: '11px/1.35 ui-monospace, monospace',
  pointerEvents: 'auto',
};

function button(label, onClick, { active = false } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  Object.assign(el.style, {
    font: 'inherit',
    margin: '1px 2px 1px 0',
    padding: '2px 5px',
    borderRadius: '5px',
    border: active ? '1px solid #7ee787' : '1px solid #30363d',
    background: active ? '#1b4721' : '#161b22',
    color: 'inherit',
  });
  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return el;
}

export class CapturePanel {
  constructor(recorder, { onExport, onCopy }) {
    this.recorder = recorder;
    this.onExport = onExport;
    this.onCopy = onCopy;
    this.visibleTracks = [];
    this.note = '';
    this.root = document.createElement('div');
    Object.assign(this.root.style, PANEL_CSS);
    // The game listens for taps anywhere to fire; keep the panel's own taps to itself.
    for (const type of ['pointerdown', 'touchstart', 'click']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.append(this.root);
    // Visible from the moment recording starts, not from the first detection: the save button has
    // to be reachable even in a session where the camera never saw anybody.
    this.render();
  }

  // `tracks` is the loop's live list: [{ id, name, playerId }].
  show(tracks) {
    this.visibleTracks = tracks;
    this.render();
  }

  flash(message) {
    this.note = message;
    this.render();
    setTimeout(() => {
      if (this.note === message) {
        this.note = '';
        this.render();
      }
    }, 2500);
  }

  render() {
    const rec = this.recorder;
    this.root.textContent = '';

    const head = document.createElement('div');
    head.textContent = `REC ${rec.seconds}s · ${rec.tracks.size} tracks · ${rec.remote.length} motion msgs · ${rec.own.activity.length} own samples`;
    head.style.marginBottom = '3px';
    this.root.append(head);

    const players = [...rec.players].filter(([id]) => id !== rec.self.playerId);
    const hint = document.createElement('div');
    hint.textContent = players.length ? 'Who is each box? (tap to label)' : 'waiting for other players…';
    hint.style.opacity = '0.65';
    this.root.append(hint);

    for (const track of this.visibleTracks) {
      const row = document.createElement('div');
      const label = document.createElement('span');
      const truth = rec.truth.get(track.id);
      label.textContent = `#${track.id}${track.name ? ` (${track.name}?)` : ''} `;
      row.append(label);
      for (const [id, name] of players) {
        row.append(button(name || id.slice(0, 4), () => this.set(track.id, id), { active: truth === id }));
      }
      row.append(button('bystander', () => this.set(track.id, TRUTH_BYSTANDER), { active: truth === TRUTH_BYSTANDER }));
      row.append(button('?', () => this.set(track.id, TRUTH_UNSURE), { active: truth === TRUTH_UNSURE }));
      this.root.append(row);
    }

    const labelled = [...rec.truth].map(([id, value]) => `#${id}=${rec.players.get(value)?.trim() || value}`);
    const summary = document.createElement('div');
    summary.textContent = labelled.length ? `truth: ${labelled.join(' ')}` : 'truth: nothing labelled yet';
    summary.style.cssText = 'margin-top:3px;opacity:0.65';
    this.root.append(summary);

    const actions = document.createElement('div');
    actions.style.marginTop = '3px';
    actions.append(button('⬇ save', () => this.onExport()), button('copy', () => this.onCopy()));
    this.root.append(actions);

    if (this.note) {
      const note = document.createElement('div');
      note.textContent = this.note;
      note.style.color = '#7ee787';
      this.root.append(note);
    }
  }

  set(trackId, value) {
    this.recorder.setTruth(trackId, this.recorder.truth.get(trackId) === value ? null : value);
    this.render();
  }
}

// A download is the one export that works on a phone with no devtools and no pairing: the file
// lands in Downloads, where it can be mailed or AirDropped to the machine running the replay.
export function downloadRecording(recording, name = recordingFilename(recording)) {
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export function recordingFilename(recording) {
  const stamp = new Date(recording.recordedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `motion-session-${recording.room || 'room'}-${stamp}.json`;
}

export async function copyRecording(recording) {
  await navigator.clipboard.writeText(JSON.stringify(recording));
}
