// Where a finished scan is remembered, and what counts as a scan worth remembering
// (frontend/public/scan-cache.js).
//
// Both bugs this guards were invisible with one player on one phone, which is why they survived:
//
//   1. The slot used to be `scan:<room>:<lower-cased name>`, validated by `cache.name`. Names are
//      not unique - the server's clean_name only trims and caps - so scanning another player who
//      happens to share your name wrote *their* gallery into *your* slot, and the next rejoin
//      published their appearance as yours. Every check passed on the way through.
//   2. The validator checked `Array.isArray` and nothing else, so a sample with `hist: []` was
//      accepted. An empty or all-zero vector scores 0 against everybody, so the player it was
//      enrolled for simply never matches again, out of a cache that looked fine.
//
// The thresholds here are the test's own (3 and 5 samples), not the screen's 12 and 24: asserting
// a bound against the constant that produces it asserts nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_CACHE_PREFIX,
  SCAN_CACHE_VERSION,
  cacheableScan,
  degenerateSignature,
  scanCacheKey,
  staleScanCacheKeys,
  validScanCache,
} from '../frontend/public/scan-cache.js';

const BOUNDS = { room: 'demo', minSamples: 3, maxSamples: 5 };

/** One plausible gallery sample; `overrides` replaces individual vectors. */
function sample(overrides = {}) {
  return { hist: [0.6, 0.8], lower: [1, 0], grid: [0.5, 0.5], shape: [2.4, 0.6], embed: [], ...overrides };
}

function cache(overrides = {}) {
  return {
    version: SCAN_CACHE_VERSION,
    room: 'demo',
    name: 'Sam',
    savedAt: 1,
    gallery: [sample(), sample(), sample()],
    ...overrides,
  };
}

test('the cache key is the room and nothing else - no name in it anywhere', () => {
  // Written out rather than rebuilt from the module, because the whole bug was a key that had one
  // more thing in it than it should have.
  assert.equal(scanCacheKey('demo'), 'laser-tag:scan:self:demo');
  assert.equal(scanCacheKey('other'), 'laser-tag:scan:self:other');
  assert.ok(scanCacheKey('demo').startsWith(SCAN_CACHE_PREFIX));
  assert.equal(scanCacheKey(''), null, 'no room, nothing to address');
  assert.equal(scanCacheKey(undefined), null);
});

test('a scan of another player is never cached - not even one with your own name', () => {
  // The trigger: you are Sam, and on your phone you scan the *other* Sam. Nothing about the two
  // of them differs except their ids, which is exactly why the id is the only thing consulted.
  assert.equal(cacheableScan({ targetId: 'sam-2', selfId: 'sam-1' }), false);
  assert.equal(cacheableScan({ targetId: 'sam-1', selfId: 'sam-1' }), true, 'your own scan still caches');
  assert.equal(cacheableScan({ targetId: '', selfId: '' }), false, 'no target is not a match');
  assert.equal(cacheableScan({ targetId: null, selfId: null }), false);
});

test('a valid cache is accepted', () => {
  assert.equal(validScanCache(cache(), BOUNDS), true);
  assert.equal(validScanCache(cache({ gallery: Array.from({ length: 5 }, () => sample()) }), BOUNDS), true);
});

test('a cache for another room, or an older format, is rejected', () => {
  assert.equal(validScanCache(cache({ room: 'elsewhere' }), BOUNDS), false);
  assert.equal(validScanCache(cache({ version: SCAN_CACHE_VERSION - 1 }), BOUNDS), false);
  assert.equal(validScanCache(null, BOUNDS), false);
  assert.equal(validScanCache({}, BOUNDS), false);
});

test('a cache is rejected on size, at both ends', () => {
  assert.equal(validScanCache(cache({ gallery: [sample(), sample()] }), BOUNDS), false, 'too few angles');
  assert.equal(
    validScanCache(cache({ gallery: Array.from({ length: 6 }, () => sample()) }), BOUNDS),
    false,
    'more samples than a scan can produce',
  );
  assert.equal(validScanCache(cache({ gallery: 'not a gallery' }), BOUNDS), false);
});

test('a cache carrying a sample with no vectors in it is rejected', () => {
  // `hist: []` used to pass: the validator asked whether it was an array, not whether there was
  // anything in it. matchGallery then returned null for that player for the whole round.
  for (const field of ['hist', 'lower', 'grid', 'shape']) {
    assert.equal(
      validScanCache(cache({ gallery: [sample(), sample({ [field]: [] }), sample()] }), BOUNDS),
      false,
      `an empty ${field} must not validate`,
    );
    assert.equal(
      validScanCache(cache({ gallery: [sample(), sample({ [field]: undefined }), sample()] }), BOUNDS),
      false,
      `a missing ${field} must not validate`,
    );
  }
});

test('a cache carrying an all-zero vector is rejected', () => {
  // The reachable version of the same hole: a recorded frame whose backing store the browser
  // discarded reads back as transparent black, and bodyGrid normalises that to all zeros - which
  // every check downstream accepts and cosine() scores 0 against.
  assert.equal(validScanCache(cache({ gallery: [sample(), sample({ grid: [0, 0, 0] }), sample()] }), BOUNDS), false);
  assert.equal(validScanCache(cache({ gallery: [sample({ hist: [0, -0] }), sample(), sample()] }), BOUNDS), false);
  assert.equal(
    validScanCache(cache({ gallery: [sample(), sample(), sample({ lower: [0, 0.0001] })] }), BOUNDS),
    true,
    'a very dark but real sample is not all-zero and must still be accepted',
  );
});

test('a cache carrying a non-finite number is rejected', () => {
  assert.equal(validScanCache(cache({ gallery: [sample({ grid: [1, Number.NaN] }), sample(), sample()] }), BOUNDS), false);
  assert.equal(
    validScanCache(cache({ gallery: [sample({ shape: [Number.POSITIVE_INFINITY, 1] }), sample(), sample()] }), BOUNDS),
    false,
  );
});

test('an empty embed or a missing reid is still a usable sample', () => {
  // A phone where an optional model failed to load enrols a weaker gallery, not a broken one -
  // the same graceful degradation the live path has.
  assert.equal(degenerateSignature(sample({ embed: [], reid: undefined })), null);
  assert.equal(degenerateSignature(sample({ embed: [0, 0, 0] })), null);
});

test('degenerateSignature names the vector that is blank', () => {
  // The name is what the scan puts in front of the player when it refuses to enrol, so it has to
  // be the actual field rather than a boolean.
  assert.equal(degenerateSignature(sample()), null);
  assert.equal(degenerateSignature(sample({ lower: [] })), 'lower');
  assert.equal(degenerateSignature(sample({ grid: [0, 0] })), 'grid');
  assert.equal(degenerateSignature(sample({ shape: [Number.NaN, 1] })), 'shape');
  assert.equal(degenerateSignature(undefined), 'hist');
  // Reported in a fixed order, so the message does not depend on object key order.
  assert.equal(degenerateSignature(sample({ hist: [], grid: [] })), 'hist');
});

test('every scan key but the current one is stale, and nothing else is touched', () => {
  const keys = [
    'laser-tag:scan:self:demo',
    'laser-tag:scan:self:other-room',
    'laser-tag:scan:demo:sam', // a version-12 name-keyed entry: possibly the wrong person entirely
    'laser-tag:scan:demo:alex',
    'laser-tag:name',
    'laser-tag:activeLobby',
    'something-else',
  ];
  assert.deepEqual(staleScanCacheKeys(keys, 'laser-tag:scan:self:demo'), [
    'laser-tag:scan:self:other-room',
    'laser-tag:scan:demo:sam',
    'laser-tag:scan:demo:alex',
  ]);
  assert.deepEqual(staleScanCacheKeys([], 'laser-tag:scan:self:demo'), []);
});
