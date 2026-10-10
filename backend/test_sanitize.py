"""Unit tests for :mod:`backend.sanitize`, the untrusted-JSON boundary.

``test_protocol.py`` covers the motion sanitiser incidentally, through the relay
path: non-finite, negative and malformed samples being dropped. What it cannot
see is *which* samples survive the length cap, because it never sends more than
the cap allows - so that direction gets its own test here. See
``docs/development/testing.md``.
"""

import unittest

from backend.sanitize import MAX_MOTION_SAMPLES, clean_motion_samples


class CleanMotionSamplesTests(unittest.TestCase):
    def test_keeps_the_newest_samples_when_over_the_cap(self):
        """A backlog flush must relay its recent tail, not its stale head.

        ``motion/matching.js`` only correlates the last 6 seconds, so keeping the
        oldest 32 of a long flush would throw away every sample the receiving
        phones can actually use.
        """
        backlog = [[1000 + 100 * i, 1.0] for i in range(100)]
        clean = clean_motion_samples(backlog)

        self.assertEqual(len(clean), MAX_MOTION_SAMPLES)
        self.assertEqual(clean, [[t, v] for t, v in backlog[-MAX_MOTION_SAMPLES:]])
        self.assertEqual(clean[-1][0], backlog[-1][0])  # the newest sample survives

    def test_short_flushes_are_untouched_and_stay_in_order(self):
        samples = [[1000, 0.5], [1100, 1.25], [1200, 0.0]]
        self.assertEqual(clean_motion_samples(samples), [[1000, 0.5], [1100, 1.25], [1200, 0.0]])

    def test_junk_is_dropped_without_widening_the_cap(self):
        """Filtering happens inside the newest-N window, so junk cannot smuggle in older data."""
        samples = [[1000 + 100 * i, 1.0] for i in range(40)]
        samples[-5:] = [["x", 1.0], [1, None], "bad", [], [9999, 2.0]]
        clean = clean_motion_samples(samples)

        self.assertLessEqual(len(clean), MAX_MOTION_SAMPLES)
        self.assertEqual(clean[-1], [9999, 2.0])
        self.assertTrue(all(isinstance(t, int) and isinstance(v, float) for t, v in clean))

    def test_non_lists_are_ignored(self):
        for junk in (None, "nope", 7, {"s": []}):
            self.assertEqual(clean_motion_samples(junk), [])


if __name__ == "__main__":
    unittest.main()
