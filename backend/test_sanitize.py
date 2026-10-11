"""Unit tests for :mod:`backend.sanitize`, the untrusted-JSON boundary.

``test_protocol.py`` covers the motion sanitiser incidentally, through the relay
path: non-finite, negative and malformed samples being dropped. What it cannot
see is *which* samples survive the length cap, because it never sends more than
the cap allows - so that direction gets its own test here. See
``docs/development/testing.md``.
"""

import unittest

from backend.sanitize import MAX_MOTION_ACTIVITY, MAX_MOTION_SAMPLES, clean_motion_samples


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

    def test_an_absurd_activity_value_is_dropped_rather_than_relayed(self):
        """Finite is not the same as possible, and the difference is exploitable.

        ``1e300`` is finite and non-negative, so the finiteness check passed it
        through. Squared inside the receiving phone's correlation it overflows to
        infinity and the correlation falls out as 0 - at or below
        ``inconsistentAt`` - so the sender reads as contradicted against
        everybody and, under ``?motion=strict``, becomes unshootable. See
        :data:`MAX_MOTION_ACTIVITY`.
        """
        clean = clean_motion_samples([[1000, 1.0], [1100, 1e300], [1200, 2.0]])
        self.assertEqual(clean, [[1000, 1.0], [1200, 2.0]])

    def test_the_ceiling_keeps_a_hard_shake_and_drops_what_no_phone_can_feel(self):
        # The bound has to sit above anything a carried phone produces, or it
        # would silently delete the fast movement the whole signal is built on.
        at_ceiling = clean_motion_samples([[1000, MAX_MOTION_ACTIVITY]])
        self.assertEqual(len(at_ceiling), 1, "the ceiling itself is allowed through")
        self.assertEqual(clean_motion_samples([[1000, 40.0]]), [[1000, 40.0]], "a hard shake survives")
        self.assertEqual(clean_motion_samples([[1000, MAX_MOTION_ACTIVITY + 1]]), [])


if __name__ == "__main__":
    unittest.main()
