import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from './identify.js';

function trackedPerson(id, score, lastSeen = 1000) {
  return {
    id,
    box: { x: id * 20, y: 10, w: 80, h: 180, score: 0.9 },
    lastSeen,
    lastUpdated: lastSeen,
    seenThisFrame: true,
    vx: 0,
    vy: 0,
    checks: 3,
    lastCheck: lastSeen,
    playerId: 'player-a',
    name: 'Player A',
    score,
    upper: score,
    lower: score,
    grid: score,
    shape: score,
    embed: 0,
    rankings: [],
    debugMatch: null,
    evidence: new Map(),
    evidenceDetails: new Map(),
    streakId: undefined,
    streak: 0,
    misses: 0,
    missedFrames: 0,
    identifiedAt: lastSeen,
    identityHits: 2,
    lastEnrichedAt: 0,
    selfRejected: false,
  };
}

test('tracker keeps a player tag on only the highest-scoring visible track', () => {
  const tracker = new Tracker();
  tracker.tracks = [trackedPerson(1, 0.62), trackedPerson(2, 0.81)];

  const tracks = tracker.update([], { videoWidth: 640, videoHeight: 480 }, [], 'self', 1010, { closedSet: true });

  assert.equal(tracks.find((track) => track.id === 2).playerId, 'player-a');
  assert.equal(tracks.find((track) => track.id === 1).playerId, null);
});
