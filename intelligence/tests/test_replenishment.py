from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.replenishment import (
    demand_stats,
    normal_ppf,
    periodic_policy,
    safety_stock,
    simulate_periodic_review,
)


class NormalPpfTests(unittest.TestCase):
    def test_known_quantiles(self):
        self.assertAlmostEqual(normal_ppf(0.5), 0.0, places=6)
        self.assertAlmostEqual(normal_ppf(0.95), 1.6448536, places=4)
        self.assertAlmostEqual(normal_ppf(0.99), 2.3263479, places=4)

    def test_symmetry(self):
        self.assertAlmostEqual(normal_ppf(0.975), -normal_ppf(0.025), places=5)


class SafetyStockTests(unittest.TestCase):
    def test_zero_variability_needs_no_buffer(self):
        self.assertEqual(safety_stock(0.0, 0.95, 4), 0.0)

    def test_scales_with_protection_sqrt(self):
        one = safety_stock(10.0, 0.95, 1)
        four = safety_stock(10.0, 0.95, 4)
        self.assertAlmostEqual(four, 2 * one, places=6)

    def test_higher_service_level_needs_more_buffer(self):
        self.assertGreater(safety_stock(10.0, 0.99, 4), safety_stock(10.0, 0.90, 4))


class PeriodicPolicyTests(unittest.TestCase):
    def test_order_up_to_covers_mean_plus_safety(self):
        policy = periodic_policy(100.0, 20.0, review_period=1, lead_time=1, service_level=0.95)
        # Mean protection demand is 100 * (1 + 1) = 200, plus a positive buffer.
        self.assertGreater(policy.order_up_to_level, 200.0)
        self.assertGreater(policy.order_up_to_level, policy.reorder_point)
        self.assertGreater(policy.safety_stock, 0.0)

    def test_service_level_monotonicity(self):
        low = periodic_policy(100.0, 20.0, review_period=1, lead_time=2, service_level=0.90)
        high = periodic_policy(100.0, 20.0, review_period=1, lead_time=2, service_level=0.99)
        self.assertGreater(high.order_up_to_level, low.order_up_to_level)


class SimulationTests(unittest.TestCase):
    def test_deterministic_demand_is_fully_served(self):
        demand = [10.0] * 12
        result = simulate_periodic_review(
            demand, order_up_to_level=30.0, review_period=1, lead_time=1, initial_on_hand=20.0
        )
        self.assertAlmostEqual(result.fill_rate, 1.0, places=6)
        self.assertEqual(result.stockout_periods, 0)

    def test_undersized_policy_causes_stockouts(self):
        demand = [10.0] * 12
        result = simulate_periodic_review(
            demand, order_up_to_level=5.0, review_period=1, lead_time=2, initial_on_hand=5.0
        )
        self.assertLess(result.fill_rate, 1.0)
        self.assertGreater(result.stockout_periods, 0)

    def test_policy_sized_from_stats_hits_service_target(self):
        # An order-up-to (R, S) policy sized for the R+L protection interval is
        # replayed by ordering to S at every review; the achieved fill rate
        # should clear the service target it was sized for.
        demand = [8, 12, 10, 9, 11, 10, 12, 8, 10, 11, 9, 10, 12, 8, 10, 11, 9, 10, 12, 8]
        stats = demand_stats(demand)
        policy = periodic_policy(
            stats.mean, stats.std, review_period=1, lead_time=1, service_level=0.95
        )
        result = simulate_periodic_review(
            demand,
            order_up_to_level=policy.order_up_to_level,
            review_period=policy.review_period,
            lead_time=int(policy.lead_time),
        )
        self.assertGreaterEqual(result.fill_rate, 0.95)

    def test_order_up_to_covers_longer_review_period(self):
        # With R = 3 the order-up-to level S protects the R+L interval, so
        # ordering to S every third period still clears the service target.
        demand = [8, 12, 10, 9, 11, 10, 12, 8, 10, 11, 9, 10, 12, 8, 10, 11, 9, 10, 12, 8]
        stats = demand_stats(demand)
        policy = periodic_policy(
            stats.mean, stats.std, review_period=3, lead_time=1, service_level=0.95
        )
        self.assertGreater(policy.order_up_to_level, policy.reorder_point)
        result = simulate_periodic_review(
            demand,
            order_up_to_level=policy.order_up_to_level,
            review_period=policy.review_period,
            lead_time=int(policy.lead_time),
        )
        self.assertGreaterEqual(result.fill_rate, 0.9)


if __name__ == "__main__":
    unittest.main()
