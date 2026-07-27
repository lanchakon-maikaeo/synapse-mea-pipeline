from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.obsolescence import (
    months_of_cover,
    obsolescence_signal,
    zero_demand_streak,
)


class HelperTests(unittest.TestCase):
    def test_zero_streak_counts_trailing_zeros_only(self):
        self.assertEqual(zero_demand_streak([5, 0, 3, 0, 0, 0]), 3)
        self.assertEqual(zero_demand_streak([0, 0, 5]), 0)

    def test_months_of_cover_guards_zero_demand(self):
        self.assertIsNone(months_of_cover(100.0, 0.0))
        self.assertAlmostEqual(months_of_cover(100.0, 20.0), 5.0)


class ObsolescenceScoreTests(unittest.TestCase):
    def test_steady_mover_is_low_risk(self):
        signal = obsolescence_signal([10, 11, 9, 10, 12, 10, 11, 10, 9, 11, 10, 12], on_hand=20)
        self.assertEqual(signal.risk_level, "none")
        self.assertLess(signal.risk_score, 0.2)

    def test_stopped_item_is_flagged(self):
        # Demand stopped nine months ago -> low probability + long zero streak.
        signal = obsolescence_signal([6, 5, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        self.assertIn(signal.risk_level, {"warning", "critical"})
        self.assertLess(signal.demand_probability, 0.5)
        self.assertGreaterEqual(signal.zero_streak, 9)

    def test_overstock_raises_score_via_months_of_cover(self):
        history = [2, 0, 3, 0, 2, 0, 1, 0, 2, 0, 3, 0]
        low_cover = obsolescence_signal(history, on_hand=5)
        high_cover = obsolescence_signal(history, on_hand=200)  # many months of cover
        self.assertGreater(high_cover.risk_score, low_cover.risk_score)
        self.assertTrue(any("months of cover" in reason for reason in high_cover.reasons))

    def test_longer_zero_streak_is_monotonic(self):
        short = obsolescence_signal([5, 5, 5, 5, 0, 0, 0])
        long = obsolescence_signal([5, 5, 5, 5, 0, 0, 0, 0, 0, 0, 0])
        self.assertGreaterEqual(long.risk_score, short.risk_score)

    def test_score_is_bounded(self):
        signal = obsolescence_signal([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], on_hand=10_000)
        self.assertLessEqual(signal.risk_score, 1.0)
        self.assertGreaterEqual(signal.risk_score, 0.0)


if __name__ == "__main__":
    unittest.main()
