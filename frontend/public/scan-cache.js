// Where a finished scan is remembered between page loads, and what counts as a cache worth
// trusting. `screens/scan.js` owns the localStorage calls; everything here is pure, so it can be
// tested directly (test/scan-cache.test.js) instead of only through a screen that needs a camera -
// which matters because both bugs this module exists for were invisible until a *second* player
// turned up.
//
// Two rules, and they are the whole module:
//
//   1. A cache slot is addressed by the player's **id**, never by their name. Names are not
//      unique: `clean_name` on the server only trims and caps, nothing rejects a second "Sam",
//      and the key used to be `scan:<room>:<lower-cased name>`. So scanning another player who
//      happens to share your name wrote *their* gallery into *your* slot, and the next rejoin
//      published their appearance as yours - every phone in the room then matched that body to
//      your name, and your own phone rejected any track that looked like them. Nothing about that
//      failure was visible: the version, name and room checks all passed.
//
//   2. A sample whose required vectors are missing, empty, non-finite or **all zero** is not a
//      weak sample. It is a sample whose pixels were never read (see frameLost in screens/scan.js
//      for how that happens), and an all-zero vector scores 0 against everybody - so the player
//      silently never matches, for the rest of the round, out of a cache that validated fine.
//      The old validator checked `Array.isArray` and nothing else, so `hist: []` passed.
//
// Only the phone owner's own scan is cached. A scan of somebody else is the server's to keep and
// is re-sent in the roster; no code has ever read a non-self entry back, so writing one only ever
// risked rule 1 and filled the origin's localStorage quota with ~190 KB per player scanned.

// 13: the cache key no longer contains the player's name, and samples with empty or all-zero
// vectors are rejected. A version-12 entry is name-keyed, so it could have been written by a scan
// of a *different* player with the same name - exactly the silently-wrong case the version exists
// for, and the reason the old entries are discarded rather than migrated.
export const SCAN_CACHE_VERSION = 13;

// Every scan cache this origin holds starts with this, so stale entries can be found and dropped.
export const SCAN_CACHE_PREFIX = 'laser-tag:scan:';

// The vectors a gallery sample is useless without, in the order a blank one is reported in - so
// the message a failed scan shows does not depend on object key order. `embed` and `reid` are
// deliberately absent: either can legitimately be empty on a phone where the optional model
// failed to load, which is graceful degradation rather than a broken sample.
//
// Not exported: nothing outside needs the list, only the verdict, and an export nobody imports is
// the beginning of two copies of a contract.
const REQUIRED_SAMPLE_VECTORS = ['hist', 'lower', 'grid', 'shape'];

// The storage key for this phone owner's scan in one room, or null when there is nothing to
// address. Note what is *not* in it: the player's name, and the player's id. The name is not an
// identity (rule 1 above); the id is not stable, because the room hands out a fresh one whenever
// the resume id has gone - which is precisely the reload this cache exists to survive. "The owner
// of this phone, in this room" is the honest identity for the only entry anybody reads.
export function scanCacheKey(room) {
  return room ? `${SCAN_CACHE_PREFIX}self:${room}` : null;
}

// Whether a finished scan belongs in the cache at all: only this phone owner's own scan does.
export function cacheableScan({ targetId, selfId }) {
  return Boolean(targetId) && targetId === selfId;
}

// The name of the first required vector that is missing, empty, non-finite or all zero, or null
// when the signature is enrollable. Returning the field name rather than a boolean is what lets
// the scan say *which* vector came back blank when it refuses to enrol one.
export function degenerateSignature(signature) {
  for (const field of REQUIRED_SAMPLE_VECTORS) {
    const vector = signature?.[field];
    if (!Array.isArray(vector)) return field;
    // Empty and all-zero are one failure, not two: there is no information in either, and an
    // empty array has no non-zero value in it, so the loop below rejects it without a length
    // check. (An explicit `|| !vector.length` here was unreachable - found by mutating it away
    // and watching the suite stay green.)
    let nonZero = false;
    for (const value of vector) {
      if (!Number.isFinite(value)) return field;
      if (value !== 0) nonZero = true;
    }
    if (!nonZero) return field;
  }
  return null;
}

// A cache is used for the rest of the round once it is accepted, so every check is a check on
// something that would otherwise fail silently rather than loudly.
export function validScanCache(cache, { room, minSamples, maxSamples }) {
  return (
    cache?.version === SCAN_CACHE_VERSION &&
    cache.room === room &&
    Array.isArray(cache.gallery) &&
    cache.gallery.length >= minSamples &&
    cache.gallery.length <= maxSamples &&
    cache.gallery.every((sample) => degenerateSignature(sample) === null)
  );
}

// Scan caches are the largest thing this app puts in localStorage (~190 KB a gallery) and nothing
// ever removed one, so they accumulated per room and per name until `setItem` started throwing
// QuotaExceededError - which saveScanCache swallows, leaving a phone that silently stops
// remembering its scan. Only the current room's own entry is ever read, so every other scan key is
// dead weight; this is also what clears out the version-12 name-keyed entries.
export function staleScanCacheKeys(keys, currentKey) {
  return keys.filter((key) => key?.startsWith(SCAN_CACHE_PREFIX) && key !== currentKey);
}
