"""Unit: the adblock staleness decision is a pure function of two timestamps.

`config/config.py` cannot be imported (qutebrowser execs it with `c` and `config` injected),
so the module is executed by the loader that lives with the config integration tests; this
file keeps one copy of that machinery rather than a second set of stubs that could drift.

What is asserted here is the decision alone — no browser, no network, no file, no clock:
the 7-day threshold, the boundary itself, clock skew, and an absent cache (which is not
"fresh": with no parsed lists nothing is blocked yet).
"""
import unittest

try:                                        # `python3 -m unittest discover -s tests`
    from test_integration_config_blocking import load_config_ns
except ImportError:                         # `python3 -m unittest tests.test_unit_...`
    from tests.test_integration_config_blocking import load_config_ns


class AdblockCacheStateCase(unittest.TestCase):
    def setUp(self):
        _c, ns = load_config_ns()
        self.state = ns["adblock_cache_state"]
        self.now = 1_800_000_000
        self.week = 7 * 86400

    def test_fresh_up_to_and_including_seven_days(self):
        self.assertEqual(self.state(self.now, self.now), "fresh")
        self.assertEqual(self.state(self.now - self.week, self.now), "fresh",
                         "exactly seven days old is the last fresh moment")

    def test_stale_one_second_past_seven_days(self):
        self.assertEqual(self.state(self.now - self.week - 1, self.now), "stale")

    def test_absent_cache_is_not_fresh(self):
        self.assertEqual(self.state(None, self.now), "missing")
        self.assertNotEqual(self.state(None, self.now), "fresh")

    def test_clock_skew_does_not_look_stale(self):
        self.assertEqual(self.state(self.now + self.week, self.now), "fresh")

    def test_the_threshold_is_a_parameter(self):
        old = self.now - 2 * 86400
        self.assertEqual(self.state(old, self.now, max_age_days=1), "stale")
        self.assertEqual(self.state(old, self.now, max_age_days=30), "fresh")


if __name__ == "__main__":
    unittest.main()
