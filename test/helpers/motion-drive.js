// Drives the real motion path for a simulated 12 seconds, for the two target-motion test files.
//
// Those two cannot be one file: env.js reads the query string at import time and ESM evaluates it
// once per process, so `?motion=on` and `?motion=strict` need a process each. This holds the
// shared rig so the only difference between them stays the mode under test.
//
// The modules are passed in rather than imported here, because they must not be imported before
// the caller has installed its browser stubs.
//
// SIMULATION, like test/motion.test.js: a scripted stand/walk pattern becomes both a clean phone
// activity series and a box sliding across the frame. It pins the plumbing, and says nothing about
// a real accelerometer - see the header of frontend/public/motion/matching.js.

export const OPPONENT = 'rex-uuid';
const BOX_H = 300;
const STEP_MS = 100;
const STEPS = 120; // 12 s, twice the correlation window

// One second moving, one second standing, repeating - the pattern the correlation is built for.
export const alternating = (step) => Math.floor(step / 10) % 2 === 0;
export const still = () => false;

// A track the appearance gate is happy to shoot: see isStableTarget in target.js.
export function namedTrack() {
  return {
    id: 7,
    playerId: OPPONENT,
    name: 'Rex',
    identifiedAt: 0,
    lastSeen: 0,
    score: 0.8,
    upper: 0.5,
    lower: 0.5,
    grid: 0.5,
    hasReid: false,
    selfRejected: false,
    box: { x: 200, y: 100, w: BOX_H / 3, h: BOX_H },
  };
}

export function makeDriver({ targetPlayerId, targetConfirmedBy, motionConfirmation, onMotionMessage }) {
  // Step a fake Date.now; move the track's box the way `personMoving(step)` says; relay a phone's
  // activity the way `phoneMoving(step)` says; and call targetPlayerId() each step the way the
  // frame loop does, which is what feeds noteTrackBox().
  //
  // `from` is who the shared activity belongs to - pass somebody other than the track's player to
  // check that a matching phone cannot capture a shot aimed at a different one.
  return function drive({ personMoving, phoneMoving, track = namedTrack(), beforeStep = null, from = OPPONENT }) {
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
      let perfNow = 1000; // past TARGET_LOCK_MS, so appearance alone already names this track
      let id = null;
      for (let step = 0; step < STEPS; step++) {
        beforeStep?.(track, perfNow);
        // That phone: 1.8 m/s^2 while its owner moves, 0.15 while they stand.
        onMotionMessage({ type: 'motion', from, s: [[clock, phoneMoving(step) ? 1.8 : 0.15]] });
        // The camera: 0.6 box heights per second while the person on screen moves.
        if (personMoving(step)) track.box = { ...track.box, x: track.box.x + 0.6 * BOX_H * (STEP_MS / 1000) };
        track.lastSeen = perfNow; // only a changed lastSeen records a box - one per detection
        id = targetPlayerId(track, perfNow);
        clock += STEP_MS;
        perfNow += STEP_MS;
      }
      // `probe` is what the correlation actually measured, so an assertion that motion changed
      // nothing can also show that motion had a real opinion to change it with.
      return {
        id,
        confirmedBy: targetConfirmedBy(track, perfNow),
        probe: motionConfirmation(track, OPPONENT, perfNow),
        track,
      };
    } finally {
      Date.now = realNow;
    }
  };
}
