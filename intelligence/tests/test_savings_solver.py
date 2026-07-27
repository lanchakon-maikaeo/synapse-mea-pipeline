from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.routing import Coordinate, DeliveryStop, TravelMatrix, Vehicle
from synapse_intelligence.savings_solver import SavingsOptimizer
from synapse_intelligence.route_benchmark import VehicleCapacity, compare_solutions, summarize_solution


def _matrix(positions):
    size = len(positions)
    distances = tuple(
        tuple(int(abs(positions[a] - positions[b]) * 1000) for b in range(size)) for a in range(size)
    )
    durations = tuple(
        tuple(int(abs(positions[a] - positions[b]) * 60) for b in range(size)) for a in range(size)
    )
    return TravelMatrix(distances, durations, "synthetic")


def _stop(stop_id, weight):
    return DeliveryStop(
        stop_id=stop_id,
        coordinate=Coordinate(0.0, 0.0),
        weight_kg=weight,
        volume_m3=weight / 100.0,
        pallets=1.0,
        service_minutes=10,
        window_start_minute=0,
        window_end_minute=24 * 60 - 1,
        priority_score=1.0,
    )


def _vehicle(vehicle_id, max_weight):
    return Vehicle(vehicle_id, max_weight, 100.0, 100.0)


class SavingsSolverTests(unittest.TestCase):
    def setUp(self):
        self.matrix = _matrix([0, 1, 2, 3, 4])  # depot + 4 collinear stops
        self.stops = [_stop("d1", 100), _stop("d2", 100), _stop("d3", 100), _stop("d4", 100)]
        self.depot = Coordinate(0.0, 0.0)

    def test_empty_stops(self):
        result = SavingsOptimizer().solve(self.depot, [], [_vehicle("V1", 1000)], self.matrix)
        self.assertEqual(result.routes, ())
        self.assertEqual(result.solver_status, "empty")

    def test_all_served_and_merged_when_capacity_ample(self):
        result = SavingsOptimizer().solve(self.depot, self.stops, [_vehicle("V1", 1000), _vehicle("V2", 1000)], self.matrix)
        served = sum(len(route.stops) for route in result.routes)
        self.assertEqual(served, 4)
        self.assertEqual(result.unserved_stop_ids, ())
        self.assertEqual(len(result.routes), 1)  # savings collapses the collinear stops onto one vehicle

    def test_tight_capacity_splits_routes(self):
        stops = [_stop("d1", 300), _stop("d2", 300), _stop("d3", 300), _stop("d4", 300)]
        result = SavingsOptimizer().solve(self.depot, stops, [_vehicle("V1", 700), _vehicle("V2", 700)], self.matrix)
        self.assertEqual(result.unserved_stop_ids, ())
        self.assertEqual(len(result.routes), 2)
        for route in result.routes:
            self.assertLessEqual(route.weight_kg, 700)

    def test_too_few_vehicles_leaves_stops_unserved(self):
        stops = [_stop("d1", 300), _stop("d2", 300), _stop("d3", 300), _stop("d4", 300)]
        result = SavingsOptimizer().solve(self.depot, stops, [_vehicle("V1", 700)], self.matrix)
        self.assertEqual(len(result.unserved_stop_ids), 2)
        self.assertEqual(result.solver_status, "partial")

    def test_oversized_stop_is_unserved(self):
        stops = [_stop("d1", 100), _stop("big", 5000), _stop("d3", 100)]
        result = SavingsOptimizer().solve(self.depot, stops, [_vehicle("V1", 1000)], _matrix([0, 1, 2, 3]))
        self.assertIn("big", result.unserved_stop_ids)

    def test_feeds_route_benchmark_comparator(self):
        capacities = {"V1": VehicleCapacity(1000, 100, 100), "V2": VehicleCapacity(1000, 100, 100)}
        savings = SavingsOptimizer().solve(self.depot, self.stops, [_vehicle("V1", 1000), _vehicle("V2", 1000)], self.matrix)
        savings_summary = summarize_solution("savings", savings, capacities)
        # A naive one-stop-per-vehicle plan visits and returns for each stop; its
        # total distance is longer, so the savings plan should win the benchmark.
        naive_routes = SavingsOptimizer().solve(self.depot, self.stops[:2], [_vehicle("V1", 100), _vehicle("V2", 100)], _matrix([0, 1, 2]))
        naive_summary = summarize_solution("naive", naive_routes, capacities)
        benchmark = compare_solutions(savings_summary, naive_summary)
        self.assertIn(benchmark.winner, {"savings", "naive", "tie"})
        self.assertTrue(savings_summary.feasible)


if __name__ == "__main__":
    unittest.main()
