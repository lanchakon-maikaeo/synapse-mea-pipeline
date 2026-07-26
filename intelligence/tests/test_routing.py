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
    MatrixResponseError,
    OrToolsOptimizer,
    TravelMatrix,
    ValhallaMatrixAdapter,
    Vehicle,
    legacy_nearest_neighbor,
)


TILESET_VERSION = (
    "thailand-2026-07-25-sha256-"
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)


class RoutingTests(unittest.TestCase):
    @staticmethod
    def _valhalla_status(*, tileset_last_modified=1_783_968_000):
        return {
            "version": "3.7.0",
            "tileset_last_modified": tileset_last_modified,
            "osm_changeset": 168_245_001,
            "has_tiles": True,
        }

    @staticmethod
    def _json_response(payload):
        return io.BytesIO(json.dumps(payload).encode())

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
            matrix = ValhallaMatrixAdapter("https://valhalla.local").build(
                [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
            )
        self.assertEqual(matrix.distances_m[0][1], 1250)
        self.assertEqual(matrix.durations_s[1][0], 190)
        self.assertEqual(matrix.source, "valhalla")

    def test_unreachable_native_valhalla_cell_fails_closed(self):
        response = {
            "sources_to_targets": [
                [{"distance": 0, "time": 0}, {"distance": None, "time": None}],
                [{"distance": 1.30, "time": 190}, {"distance": 0, "time": 0}],
            ],
            "units": "kilometers",
        }
        with patch("synapse_intelligence.routing.urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaisesRegex(MatrixResponseError, r"unreachable matrix cell \[0\]\[1\]"):
                ValhallaMatrixAdapter("https://valhalla.local").build(
                    [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
                )

    def test_unreachable_normalized_valhalla_cell_fails_closed(self):
        response = {
            "sources_to_targets": {
                "distances": [[0, None], [1.30, 0]],
                "durations": [[0, None], [190, 0]],
            }
        }
        with patch("synapse_intelligence.routing.urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaisesRegex(MatrixResponseError, r"unreachable matrix cell \[0\]\[1\]"):
                ValhallaMatrixAdapter("https://valhalla.local").build(
                    [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
                )

    def test_valhalla_matrix_must_match_requested_coordinate_count(self):
        response = {"sources_to_targets": [[{"distance": 0, "time": 0}]]}
        with patch("synapse_intelligence.routing.urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaisesRegex(MatrixResponseError, "must be 2x2"):
                ValhallaMatrixAdapter("https://valhalla.local").build(
                    [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
                )

    def test_valhalla_rejects_duplicate_coordinates_and_embedded_credentials(self):
        with self.assertRaisesRegex(ValueError, "without credentials"):
            ValhallaMatrixAdapter("https://user:secret@valhalla.local")
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            ValhallaMatrixAdapter("http://valhalla.example")
        for host in (
            "https://valhalla.openstreetmap.de",
            "https://valhalla1.openstreetmap.de",
            "https://valhalla12.openstreetmap.de",
        ):
            with self.subTest(host=host):
                with self.assertRaisesRegex(ValueError, "public community"):
                    ValhallaMatrixAdapter(host)
        with self.assertRaisesRegex(ValueError, "auth token is invalid"):
            ValhallaMatrixAdapter(
                "https://valhalla.local",
                auth_token="gateway-token\ninjected",
            )
        with self.assertRaisesRegex(ValueError, "coordinates must be unique"):
            ValhallaMatrixAdapter("https://valhalla.local").build(
                [Coordinate(13.72, 100.56), Coordinate(13.72, 100.56)]
            )

    def test_valhalla_sends_configured_gateway_token(self):
        response = {
            "sources_to_targets": [[{"distance": 0, "time": 0}]],
            "units": "kilometers",
        }
        with patch(
            "synapse_intelligence.routing.urlopen",
            return_value=io.BytesIO(json.dumps(response).encode()),
        ) as mocked_open:
            ValhallaMatrixAdapter(
                "https://valhalla.local",
                auth_token="gateway-token",
            ).build([Coordinate(13.72, 100.56)])
        request = mocked_open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer gateway-token")

    def test_stock_status_uses_controlled_dataset_id_and_rejects_mismatch(self):
        stock_status = {
            "version": "3.7.0",
            "tileset_last_modified": 1_783_968_000,
        }
        with patch(
            "synapse_intelligence.routing.urlopen",
            return_value=self._json_response(stock_status),
        ) as mocked_open:
            status = ValhallaMatrixAdapter(
                "https://valhalla.local",
                expected_osm_changeset=168_245_001,
            ).status()
        self.assertEqual(status.osm_changeset, 168_245_001)
        self.assertEqual(
            mocked_open.call_args.args[0].full_url,
            "https://valhalla.local/status",
        )

        mismatched = dict(stock_status, osm_changeset=168_245_002)
        with patch(
            "synapse_intelligence.routing.urlopen",
            return_value=self._json_response(mismatched),
        ):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "does not match the controlled dataset id",
            ):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    expected_osm_changeset=168_245_001,
                ).status()

    def test_valhalla_response_cannot_cross_configured_origin(self):
        class RedirectedResponse(io.BytesIO):
            headers = {}

            def geturl(self):
                return "https://attacker.example/sources_to_targets"

        response = RedirectedResponse(
            json.dumps(
                {"sources_to_targets": [[{"distance": 0, "time": 0}]]}
            ).encode()
        )
        with patch(
            "synapse_intelligence.routing.urlopen",
            return_value=response,
        ):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "crossed the configured routing origin",
            ):
                ValhallaMatrixAdapter("https://valhalla.local").build(
                    [Coordinate(13.72, 100.56)]
                )

    def test_valhalla_route_evidence_has_ordered_geojson_and_engine_snapshot(self):
        depot = Coordinate(13.55760333, 100.77072260)
        stop = Coordinate(13.81895000, 100.64410000)
        route_response = {
            "code": "Ok",
            "osm_changeset": 168_245_001,
            "waypoints": [
                {"location": [depot.longitude, depot.latitude], "name": "Depot"},
                {"location": [stop.longitude, stop.latitude], "name": "District"},
                {"location": [depot.longitude, depot.latitude], "name": "Depot"},
            ],
            "routes": [
                {
                    "distance": 73_250.4,
                    "duration": 5_280.2,
                    "legs": [{}, {}],
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [depot.longitude, depot.latitude],
                            [100.70000000, 13.68000000],
                            [stop.longitude, stop.latitude],
                            [100.71000000, 13.69000000],
                            [depot.longitude, depot.latitude],
                        ],
                    },
                }
            ],
        }
        responses = [
            self._json_response(self._valhalla_status()),
            self._json_response(route_response),
            self._json_response(self._valhalla_status()),
        ]
        with patch(
            "synapse_intelligence.routing.urlopen",
            side_effect=responses,
        ) as mocked_open:
            evidence = ValhallaMatrixAdapter(
                "https://valhalla.local",
                auth_token="gateway-token",
                tileset_version=TILESET_VERSION,
                expected_osm_changeset=168_245_001,
            ).build_route([depot, stop, depot])

        self.assertEqual(evidence.geometry_geojson["type"], "LineString")
        self.assertEqual(evidence.distance_m, 73_250)
        self.assertEqual(evidence.duration_s, 5_280)
        self.assertIsNone(evidence.has_toll)
        self.assertEqual(evidence.engine_name, "valhalla")
        self.assertEqual(evidence.engine_version, "3.7.0")
        self.assertEqual(evidence.routing_profile, "truck")
        self.assertEqual(
            evidence.tileset_version,
            TILESET_VERSION,
        )
        self.assertEqual(evidence.tileset_last_modified, 1_783_968_000)
        self.assertEqual(evidence.osm_changeset, 168_245_001)
        self.assertEqual(evidence.ordered_waypoint_count, 3)
        self.assertRegex(evidence.request_hash, r"^[0-9a-f]{64}$")
        self.assertRegex(evidence.response_hash, r"^[0-9a-f]{64}$")
        self.assertRegex(
            evidence.engine_status_response_hash,
            r"^[0-9a-f]{64}$",
        )

        status_before_request, route_request, status_after_request = [
            call.args[0] for call in mocked_open.call_args_list
        ]
        self.assertEqual(status_before_request.full_url, "https://valhalla.local/status")
        self.assertEqual(status_before_request.method, "GET")
        self.assertEqual(route_request.full_url, "https://valhalla.local/route")
        self.assertEqual(route_request.method, "POST")
        self.assertEqual(status_after_request.full_url, "https://valhalla.local/status")
        route_payload = json.loads(route_request.data)
        self.assertEqual(route_payload["costing"], "truck")
        self.assertEqual(route_payload["format"], "osrm")
        self.assertEqual(route_payload["shape_format"], "geojson")
        self.assertEqual(route_payload["overview"], "full")
        self.assertEqual(
            route_payload["locations"],
            [
                {"lat": depot.latitude, "lon": depot.longitude},
                {"lat": stop.latitude, "lon": stop.longitude},
                {"lat": depot.latitude, "lon": depot.longitude},
            ],
        )
        self.assertEqual(
            route_request.get_header("Authorization"),
            "Bearer gateway-token",
        )

    def test_valhalla_route_evidence_requires_immutable_tileset_label(self):
        adapter = ValhallaMatrixAdapter("https://valhalla.local")
        with self.assertRaisesRegex(ValueError, "tileset version is required"):
            adapter.build_route(
                [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
            )
        for value in (
            "unconfigured",
            "thailand-sha256-REPLACE",
            "thailand-sha256-abc123",
            "Thailand-sha256-" + "a" * 64,
            "bad\nlabel-sha256-" + "a" * 64,
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "tileset version is invalid"):
                    ValhallaMatrixAdapter(
                        "https://valhalla.local",
                        tileset_version=value,
                    )

    def test_valhalla_route_evidence_requires_response_dataset_provenance(self):
        points = [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
        route_response = {
            "code": "Ok",
            "waypoints": [
                {"location": [100.56, 13.72]},
                {"location": [100.60, 13.75]},
            ],
            "routes": [
                {
                    "distance": 1_000,
                    "duration": 120,
                    "legs": [{}],
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[100.56, 13.72], [100.60, 13.75]],
                    },
                }
            ],
        }
        stable_status = self._valhalla_status()
        with patch(
            "synapse_intelligence.routing.urlopen",
            side_effect=[
                self._json_response(stable_status),
                self._json_response(route_response),
                self._json_response(stable_status),
            ],
        ):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "missing osm_changeset provenance",
            ):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    tileset_version=TILESET_VERSION,
                    expected_osm_changeset=168_245_001,
                ).build_route(points)

        route_response["osm_changeset"] = 168_245_002
        with patch(
            "synapse_intelligence.routing.urlopen",
            side_effect=[
                self._json_response(stable_status),
                self._json_response(route_response),
                self._json_response(stable_status),
            ],
        ):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "does not match the controlled dataset id",
            ):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    tileset_version=TILESET_VERSION,
                    expected_osm_changeset=168_245_001,
                ).build_route(points)

    def test_valhalla_route_evidence_rejects_engine_tileset_change(self):
        points = [Coordinate(13.72, 100.56), Coordinate(13.75, 100.60)]
        route_response = {
            "code": "Ok",
            "osm_changeset": 168_245_001,
            "waypoints": [
                {"location": [100.56, 13.72]},
                {"location": [100.60, 13.75]},
            ],
            "routes": [
                {
                    "distance": 1_000,
                    "duration": 120,
                    "legs": [{}],
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[100.56, 13.72], [100.60, 13.75]],
                    },
                }
            ],
        }
        responses = [
            self._json_response(self._valhalla_status()),
            self._json_response(route_response),
            self._json_response(
                self._valhalla_status(tileset_last_modified=1_783_968_001)
            ),
        ]
        with patch("synapse_intelligence.routing.urlopen", side_effect=responses):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "changed while building route evidence",
            ):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    tileset_version=TILESET_VERSION,
                    expected_osm_changeset=168_245_001,
                ).build_route(points)

    def test_valhalla_route_evidence_rejects_far_snap_and_wrong_geometry_order(self):
        points = [
            Coordinate(13.72, 100.56),
            Coordinate(13.75, 100.60),
            Coordinate(13.78, 100.64),
        ]
        far_snap_response = {
            "code": "Ok",
            "osm_changeset": 168_245_001,
            "waypoints": [
                {"location": [100.56, 13.72]},
                {"location": [101.60, 14.75]},
                {"location": [100.64, 13.78]},
            ],
            "routes": [
                {
                    "distance": 1_000,
                    "duration": 120,
                    "legs": [{}, {}],
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [100.56, 13.72],
                            [101.60, 14.75],
                            [100.64, 13.78],
                        ],
                    },
                }
            ],
        }
        stable_status = self._valhalla_status()
        with patch(
            "synapse_intelligence.routing.urlopen",
            side_effect=[
                self._json_response(stable_status),
                self._json_response(far_snap_response),
                self._json_response(stable_status),
            ],
        ):
            with self.assertRaisesRegex(MatrixResponseError, "snapped too far"):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    tileset_version=TILESET_VERSION,
                    expected_osm_changeset=168_245_001,
                ).build_route(points)

        wrong_order_response = {
            "code": "Ok",
            "osm_changeset": 168_245_001,
            "waypoints": [
                {"location": [point.longitude, point.latitude]}
                for point in points
            ],
            "routes": [
                {
                    "distance": 1_000,
                    "duration": 120,
                    "legs": [{}, {}],
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [points[0].longitude, points[0].latitude],
                            [points[2].longitude, points[2].latitude],
                            [points[1].longitude, points[1].latitude],
                        ],
                    },
                }
            ],
        }
        with patch(
            "synapse_intelligence.routing.urlopen",
            side_effect=[
                self._json_response(stable_status),
                self._json_response(wrong_order_response),
                self._json_response(stable_status),
            ],
        ):
            with self.assertRaisesRegex(
                MatrixResponseError,
                "ends before ordered waypoint",
            ):
                ValhallaMatrixAdapter(
                    "https://valhalla.local",
                    tileset_version=TILESET_VERSION,
                    expected_osm_changeset=168_245_001,
                ).build_route(points)

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

    def test_route_duration_includes_time_window_waiting(self):
        depot = Coordinate(13.72, 100.56)
        stop = DeliveryStop(
            "windowed",
            Coordinate(13.75, 100.60),
            100,
            1,
            1,
            0,
            60,
            120,
            5,
        )
        matrix = TravelMatrix(
            ((0, 1000), (1000, 0)),
            ((0, 60), (60, 0)),
            "test",
        )
        result = OrToolsOptimizer(time_limit_seconds=2).solve(
            depot,
            [stop],
            [Vehicle("707", 1000, 10, 10)],
            matrix,
        )
        self.assertEqual(result.unserved_stop_ids, ())
        self.assertEqual(result.routes[0].stops[0].arrival_minute, 60)
        self.assertEqual(result.routes[0].duration_s, 3660)

    def test_solver_rejects_invalid_timeout_and_capacity_inputs(self):
        for timeout in (0, 301, 1.5, True):
            with self.subTest(timeout=timeout):
                with self.assertRaisesRegex(ValueError, "solver time limit"):
                    OrToolsOptimizer(time_limit_seconds=timeout)

        depot = Coordinate(13.72, 100.56)
        stop = DeliveryStop("5501", Coordinate(13.75, 100.60), 100, 1, 1, 0, 0, 600, 5)
        matrix = HaversineMatrixAdapter().build([depot, stop.coordinate])
        with self.assertRaisesRegex(ValueError, "max_weight_kg must be positive"):
            OrToolsOptimizer(time_limit_seconds=2).solve(
                depot,
                [stop],
                [Vehicle("bad-capacity", 0, 10, 10)],
                matrix,
            )
        with self.assertRaisesRegex(ValueError, "capacity demands must be non-negative"):
            OrToolsOptimizer(time_limit_seconds=2).solve(
                depot,
                [DeliveryStop("bad-demand", stop.coordinate, -1, 1, 1, 0, 0, 600, 5)],
                [Vehicle("707", 1000, 10, 10)],
                matrix,
            )

    def test_optimizer_rejects_negative_matrix_values(self):
        depot = Coordinate(13.72, 100.56)
        stop = DeliveryStop("5501", Coordinate(13.75, 100.60), 100, 1, 1, 0, 0, 600, 5)
        matrix = TravelMatrix(
            ((0, -1), (1000, 0)),
            ((0, 60), (60, 0)),
            "invalid-test",
        )
        with self.assertRaisesRegex(ValueError, "non-negative integer"):
            OrToolsOptimizer(time_limit_seconds=2).solve(
                depot,
                [stop],
                [Vehicle("707", 1000, 10, 10)],
                matrix,
            )

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
