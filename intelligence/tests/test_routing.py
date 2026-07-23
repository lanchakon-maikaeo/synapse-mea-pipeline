from __future__ import annotations

import sys
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.routing import (
    Coordinate,
    DeliveryStop,
    HaversineMatrixAdapter,
    OrToolsOptimizer,
    ValhallaMatrixAdapter,
    Vehicle,
    legacy_nearest_neighbor,
)


class RoutingTests(unittest.TestCase):
    def test_haversine_matrix_is_square_and_zero_diagonal(self):
        points = [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
        matrix = HaversineMatrixAdapter().build(points)
        self.assertEqual(len(matrix.distances_m), 2)
        self.assertEqual(matrix.distances_m[0][0], 0)
        self.assertGreater(matrix.distances_m[0][1], 0)

    def test_native_valhalla_matrix_response(self):
        response = {
            "sources_to_targets": [
                [{"distance": 0, "time": 0}, {"distance": 1.25, "time": 180}],
                [{"distance": 1.30, "time": 190}, {"distance": 0, "time": 0}],
            ],
            "units": "kilometers",
        }
        with patch("synapse_intelligence.routing.urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            matrix = ValhallaMatrixAdapter("http://valhalla.local").build(
                [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
            )
        self.assertEqual(matrix.distances_m[0][1], 1250)
        self.assertEqual(matrix.durations_s[1][0], 190)
        self.assertEqual(matrix.source, "valhalla")

    def test_capacity_and_time_windows(self):
        depot = Coordinate(13.72, 100.56)
        stops = [
            DeliveryStop("5501", Coordinate(13.75, 100.60), 1000, 4, 2, 10, 0, 600, 9),
            DeliveryStop("5502", Coordinate(13.78, 100.52), 1200, 5, 2, 10, 0, 600, 7),
        ]
        vehicles = [Vehicle("707", 10000, 40, 10)]
        matrix = HaversineMatrixAdapter().build([depot, *(stop.coordinate for stop in stops)])
        result = OrToolsOptimizer(time_limit_seconds=2).solve(depot, stops, vehicles, matrix)
        self.assertEqual(result.solver_status, "succeeded")
        self.assertEqual(result.unserved_stop_ids, ())
        self.assertEqual({stop.stop_id for route in result.routes for stop in route.stops}, {"5501", "5502"})
        self.assertLessEqual(result.routes[0].weight_kg, vehicles[0].max_weight_kg)

    def test_oversized_stop_is_unserved(self):
        depot = Coordinate(13.72, 100.56)
        stop = DeliveryStop("oversized", Coordinate(13.75, 100.60), 11000, 4, 2, 10, 0, 600, 1)
        vehicle = Vehicle("707", 10000, 40, 10)
        matrix = HaversineMatrixAdapter().build([depot, stop.coordinate])
        result = OrToolsOptimizer(time_limit_seconds=2).solve(depot, [stop], [vehicle], matrix)
        self.assertEqual(result.unserved_stop_ids, ("oversized",))

    def test_optimizer_is_compared_with_legacy_nearest_neighbor(self):
        depot = Coordinate(13.72, 100.56)
        stops = [
            DeliveryStop("5501", Coordinate(13.75, 100.60), 100, 1, 1, 0, 0, 600, 5),
            DeliveryStop("5502", Coordinate(13.78, 100.52), 100, 1, 1, 0, 0, 600, 5),
            DeliveryStop("5503", Coordinate(13.69, 100.48), 100, 1, 1, 0, 0, 600, 5),
        ]
        matrix = HaversineMatrixAdapter().build([depot, *(stop.coordinate for stop in stops)])
        legacy = legacy_nearest_neighbor(matrix)
        result = OrToolsOptimizer(time_limit_seconds=2).solve(
            depot, stops, [Vehicle("707", 10000, 40, 10)], matrix
        )
        self.assertEqual(result.unserved_stop_ids, ())
        self.assertLessEqual(result.routes[0].distance_m, legacy.distance_m)


if __name__ == "__main__":
    unittest.main()
