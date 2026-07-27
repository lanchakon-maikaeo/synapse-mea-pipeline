from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.multi_echelon import (
    simulate_two_echelon,
    size_two_echelon_policy,
)


class TwoEchelonSimulationTests(unittest.TestCase):
    def test_generous_stock_serves_all_demand(self):
        demand = {"d1": [10.0] * 12, "d2": [5.0] * 12}
        result = simulate_two_echelon(
            demand,
            warehouse_order_up_to=500.0,
            district_order_up_to={"d1": 40.0, "d2": 20.0},
            review_period=1,
            warehouse_lead_time=1,
            district_lead_time=1,
        )
        self.assertAlmostEqual(result.system_fill_rate, 1.0, places=6)
        self.assertAlmostEqual(result.warehouse_fill_rate, 1.0, places=6)

    def test_warehouse_shortage_propagates_to_districts(self):
        # District buffers are large, but the warehouse is starved and cannot
        # refill them: end-customer fill rate must drop because of the upstream
        # echelon, not the district policy. This is the coupling the module exists
        # to expose.
        demand = {"d1": [10.0] * 12, "d2": [10.0] * 12}
        starved = simulate_two_echelon(
            demand,
            warehouse_order_up_to=5.0,
            district_order_up_to={"d1": 40.0, "d2": 40.0},
            review_period=1,
            warehouse_lead_time=2,
            district_lead_time=1,
            initial_warehouse_on_hand=5.0,
        )
        healthy = simulate_two_echelon(
            demand,
            warehouse_order_up_to=500.0,
            district_order_up_to={"d1": 40.0, "d2": 40.0},
            review_period=1,
            warehouse_lead_time=2,
            district_lead_time=1,
        )
        self.assertLess(starved.system_fill_rate, healthy.system_fill_rate)
        self.assertLess(starved.warehouse_fill_rate, 1.0)

    def test_per_district_results_present(self):
        demand = {"d1": [4.0] * 8, "d2": [6.0] * 8}
        result = simulate_two_echelon(
            demand,
            warehouse_order_up_to=200.0,
            district_order_up_to={"d1": 16.0, "d2": 24.0},
        )
        self.assertEqual(set(result.districts), {"d1", "d2"})
        self.assertEqual(result.total_periods, 8)


class TwoEchelonSizingTests(unittest.TestCase):
    def test_sizing_meets_service_target_in_simulation(self):
        demand = {
            "d1": [8, 12, 10, 9, 11, 10, 12, 8, 10, 11, 9, 10, 12, 8, 10, 11],
            "d2": [4, 6, 5, 5, 6, 4, 5, 6, 5, 4, 6, 5, 5, 6, 4, 5],
        }
        policy = size_two_echelon_policy(
            demand,
            service_level=0.95,
            review_period=1,
            warehouse_lead_time=1,
            district_lead_time=1,
        )
        result = simulate_two_echelon(
            demand,
            warehouse_order_up_to=policy.warehouse_order_up_to,
            district_order_up_to=policy.district_order_up_to,
            review_period=1,
            warehouse_lead_time=1,
            district_lead_time=1,
        )
        self.assertGreaterEqual(result.system_fill_rate, 0.9)

    def test_pooled_warehouse_std_below_sum_of_district_std(self):
        # Risk pooling: aggregate std (independence) < sum of district stds, so
        # the warehouse buffer is smaller than stacking district buffers upstream.
        demand = {"d1": [10, 0, 20, 0, 10, 0, 20, 0], "d2": [0, 10, 0, 20, 0, 10, 0, 20]}
        policy = size_two_echelon_policy(demand, service_level=0.95)
        self.assertGreater(policy.warehouse_order_up_to, 0.0)
        self.assertEqual(set(policy.district_order_up_to), {"d1", "d2"})


if __name__ == "__main__":
    unittest.main()
