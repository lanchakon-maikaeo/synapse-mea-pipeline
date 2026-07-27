from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.route_benchmark import (
    VehicleCapacity,
    compare_solutions,
    summarize_solution,
)


def _route(vehicle_id, n_stops, distance_m, duration_s, weight, volume, pallets):
    return SimpleNamespace(
        vehicle_id=vehicle_id,
        stops=[object()] * n_stops,
        distance_m=distance_m,
        duration_s=duration_s,
        weight_kg=weight,
        volume_m3=volume,
        pallets=pallets,
    )


def _solution(routes, unserved=(), status="optimal"):
    return SimpleNamespace(routes=routes, unserved_stop_ids=tuple(unserved), solver_status=status)


CAPS = {
    "V1": VehicleCapacity(1000.0, 10.0, 8.0),
    "V2": VehicleCapacity(1000.0, 10.0, 8.0),
}


class SummaryTests(unittest.TestCase):
    def test_totals_and_utilization(self):
        solution = _solution([
            _route("V1", 2, 12000, 3600, 500.0, 5.0, 4.0),
            _route("V2", 1, 8000, 2400, 250.0, 2.5, 2.0),
        ])
        summary = summarize_solution("or-tools", solution, CAPS)
        self.assertEqual(summary.served_stops, 3)
        self.assertEqual(summary.total_distance_m, 20000)
        self.assertEqual(summary.vehicles_used, 2)
        # V1 weight util 0.5, V2 0.25 -> mean 0.375
        self.assertAlmostEqual(summary.mean_weight_utilization, 0.375, places=6)
        self.assertTrue(summary.feasible)

    def test_empty_routes_are_not_counted_as_used(self):
        solution = _solution([_route("V1", 0, 0, 0, 0.0, 0.0, 0.0)])
        summary = summarize_solution("empty", solution, CAPS)
        self.assertEqual(summary.vehicles_used, 0)
        self.assertEqual(summary.served_stops, 0)

    def test_capacity_violation_is_flagged(self):
        solution = _solution([_route("V1", 1, 5000, 1200, 1500.0, 5.0, 4.0)])  # 1500 > 1000
        summary = summarize_solution("over", solution, CAPS)
        self.assertFalse(summary.feasible)

    def test_missing_capacity_raises(self):
        solution = _solution([_route("VX", 1, 1000, 100, 10.0, 1.0, 1.0)])
        with self.assertRaises(ValueError):
            summarize_solution("bad", solution, CAPS)


class CompareTests(unittest.TestCase):
    def test_fewer_unserved_wins(self):
        a = summarize_solution("A", _solution([_route("V1", 2, 20000, 3600, 400.0, 4.0, 3.0)], unserved=["d9"]), CAPS)
        b = summarize_solution("B", _solution([_route("V1", 3, 30000, 5400, 600.0, 6.0, 5.0)]), CAPS)
        benchmark = compare_solutions(a, b)
        self.assertEqual(benchmark.winner, "B")
        self.assertIn("unserved", benchmark.rationale)

    def test_distance_breaks_tie_on_unserved(self):
        a = summarize_solution("A", _solution([_route("V1", 3, 25000, 4000, 500.0, 5.0, 4.0)]), CAPS)
        b = summarize_solution("B", _solution([_route("V1", 3, 30000, 5000, 500.0, 5.0, 4.0)]), CAPS)
        benchmark = compare_solutions(a, b)
        self.assertEqual(benchmark.winner, "A")
        self.assertEqual(benchmark.distance_delta_m, 5000)

    def test_feasible_beats_infeasible(self):
        feasible = summarize_solution("feasible", _solution([_route("V1", 3, 40000, 6000, 900.0, 9.0, 7.0)]), CAPS)
        infeasible = summarize_solution("infeasible", _solution([_route("V1", 3, 10000, 2000, 1500.0, 5.0, 4.0)]), CAPS)
        benchmark = compare_solutions(feasible, infeasible)
        self.assertEqual(benchmark.winner, "feasible")

    def test_identical_solutions_tie(self):
        a = summarize_solution("A", _solution([_route("V1", 3, 25000, 4000, 500.0, 5.0, 4.0)]), CAPS)
        b = summarize_solution("B", _solution([_route("V1", 3, 25000, 4000, 500.0, 5.0, 4.0)]), CAPS)
        self.assertEqual(compare_solutions(a, b).winner, "tie")


if __name__ == "__main__":
    unittest.main()
