from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.routing import (
    Coordinate,
    DeliveryStop,
    PlannedStop,
    RoadRouteEvidence,
    RoutingEngineStatus,
    VehicleRoute,
)
from synapse_intelligence.worker import (
    ROUTABLE_ITEM_STATUS,
    ROUTING_ATTESTATION_VERSION,
    SERVICE_VERSION,
    _build_vehicle_road_evidence,
    _heartbeat_best_effort,
    _load_route_inputs,
    _lock_route_job,
    _positive_demand_rows,
    _process_forecast,
    _process_route,
    _route_start_at,
    _route_adapter_from_environment,
    _validate_route_inputs,
    _validated_routing_heartbeat_details,
)


SOURCE_CHECKSUM = "f" * 64
TILESET_VERSION = (
    "osm-thailand-2026-07-25-sha256-"
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)


class SequencedCursor:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.current = None
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=None):
        self.calls.append((query, params))
        self.current = next(self.responses)

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.current


class FakeConnection:
    def __init__(self, responses):
        self.cursor_instance = SequencedCursor(responses)
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def valid_depot(**overrides):
    depot = {
        "plan_status": "locked",
        "origin_location_id": "LOC-WH-MMBP",
        "week_start_date": date(2026, 7, 27),
        "version_no": 2,
        "origin_location_type": "WAREHOUSE",
        "origin_location_active": True,
        "origin_warehouse_id": "WH-MMBP-CANONICAL",
        "origin_warehouse_active": True,
        "transport_warehouse_code": "เมืองใหม่",
        "mapped_canonical_warehouse_id": "WH-MMBP-CANONICAL",
        "depot_district_ref": "WH-MMBP",
        "latitude": 13.55760333,
        "longitude": 100.77072260,
        "depot_geocode_status": "verified",
        "depot_source_reference": "districts.csv#row=20",
        "depot_source_checksum_sha256": SOURCE_CHECKSUM,
        "depot_source_row_number": 20,
        "depot_verified_at": "2026-07-25T00:00:00Z",
        "is_latest_active_version": True,
    }
    depot.update(overrides)
    return depot


def valid_item(**overrides):
    item = {
        "replenishment_item_id": UUID(
            "30000000-0000-4000-8000-000000000003"
        ),
        "material_id": "MAT-001",
        "district_id": "5501",
        "item_status": "locked",
        "quantity": 240,
        "priority_score": 9,
        "material_uom": "EA",
        "material_weight_per_unit_kg": 2,
        "packaging_quantity_uom": "EA",
        "quantity_per_box": 12,
        "box_volume_m3": 0.08,
        "weight_per_box_kg": 24,
        "boxes_per_pallet": 10,
        "packaging_source_reference": "owner-approved-packaging.xlsx#row=2",
        "packaging_source_checksum_sha256": SOURCE_CHECKSUM,
        "packaging_source_row_number": 2,
        "packaging_verified_at": "2026-07-25T00:00:00Z",
        "packaging_verified_by": UUID(
            "50000000-0000-4000-8000-000000000005"
        ),
        "packaging_verification_ticket": "MEA-PACKAGING-2026-001",
        "profile_base_uom": "EA",
        "full_pallet_qty": 120,
        "inner_pack_qty": 12,
        "profile_data_class": "actual",
        "profile_source_quality": "verified",
        "profile_source_reference": "owner-approved-packaging.xlsx#row=2",
        "profile_source_checksum_sha256": SOURCE_CHECKSUM,
        "profile_source_row_number": 2,
        "profile_verified_at": "2026-07-25T00:00:00Z",
        "profile_verified_by": UUID(
            "50000000-0000-4000-8000-000000000005"
        ),
        "profile_verification_ticket": "MEA-PACKAGING-2026-001",
        "latitude": 13.81895000,
        "longitude": 100.64410000,
        "geocode_status": "verified",
        "geocode_source_reference": "districts.csv#row=2",
        "geocode_source_checksum_sha256": SOURCE_CHECKSUM,
        "geocode_source_row_number": 2,
        "geocode_verified_at": "2026-07-25T00:00:00Z",
        "location_latitude": 13.81895000,
        "location_longitude": 100.64410000,
        "location_geocode_source_reference": "districts.csv#row=2",
        "location_geocode_source_checksum_sha256": SOURCE_CHECKSUM,
        "location_geocode_source_row_number": 2,
        "location_geocode_verified_at": "2026-07-25T00:00:00Z",
        "time_window_start": time(8),
        "time_window_end": time(17),
        "service_minutes": 20,
    }
    item.update(overrides)
    return item


def valid_vehicle(**overrides):
    checked_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    vehicle = {
        "transport_vehicle_id": "M13E-TRANSPORT-1",
        "vehicle_id": "M13E-CANONICAL-1",
        "vehicle_mapping_status": "verified",
        "vehicle_mapping_source_reference": "fleet-map.xlsx#row=7",
        "vehicle_mapping_source_checksum_sha256": SOURCE_CHECKSUM,
        "vehicle_mapping_source_row_number": 7,
        "vehicle_mapping_verified_at": checked_at,
        "vehicle_mapping_verified_by": UUID(
            "50000000-0000-4000-8000-000000000005"
        ),
        "vehicle_mapping_approval_ticket": "MEA-FLEET-MAP-2026-001",
        "max_weight_kg": 5_000,
        "max_volume_m3": 24.2,
        "max_pallets": 12,
        "capacity_evidence_status": "verified",
        "capacity_source_reference": "fleet-master.xlsx#row=7",
        "capacity_source_checksum_sha256": SOURCE_CHECKSUM,
        "capacity_source_row_number": 7,
        "capacity_verified_at": checked_at,
        "capacity_verified_by": UUID(
            "50000000-0000-4000-8000-000000000005"
        ),
        "capacity_verification_ticket": "MEA-FLEET-2026-001",
        "availability_evidence_status": "available",
        "availability_source_reference": "fleet-live.xlsx#row=7",
        "availability_source_checksum_sha256": "e" * 64,
        "availability_source_row_number": 7,
        "availability_checked_at": checked_at,
        "availability_expires_at": checked_at + timedelta(hours=2),
        "availability_verified_by": UUID(
            "50000000-0000-4000-8000-000000000005"
        ),
        "availability_verification_ticket": "MEA-FLEET-LIVE-2026-001",
        "current_warehouse": "เมืองใหม่",
        "canonical_warehouse_id": "WH-MMBP-CANONICAL",
        "canonical_vehicle_active": True,
        "canonical_home_location_active": True,
        "canonical_home_warehouse_id": "WH-MMBP-CANONICAL",
    }
    vehicle.update(overrides)
    return vehicle


class WorkerRouteTests(unittest.TestCase):
    def test_worker_advertises_m13e_route_evidence_capability(self):
        self.assertEqual(
            SERVICE_VERSION,
            "1.2.0-m13e-route-evidence-attested",
        )
        self.assertEqual(
            ROUTING_ATTESTATION_VERSION,
            "valhalla-status-v1",
        )

    def test_healthy_heartbeat_attests_validated_controlled_valhalla_status(self):
        status = RoutingEngineStatus(
            "3.5.1",
            1_721_865_600,
            123456,
            True,
            "a" * 64,
        )
        adapter = SimpleNamespace(
            base_url="https://valhalla.internal",
            tileset_version=TILESET_VERSION,
            expected_osm_changeset=123456,
            status=lambda: status,
        )
        environment = {
            "VALHALLA_URL": "https://valhalla.internal",
            "VALHALLA_TILESET_VERSION": TILESET_VERSION,
            "VALHALLA_OSM_CHANGESET": "123456",
        }
        with patch.dict("os.environ", environment, clear=True), patch(
            "synapse_intelligence.worker.ValhallaMatrixAdapter",
            return_value=adapter,
        ) as adapter_factory:
            details = _validated_routing_heartbeat_details()

        adapter_factory.assert_called_once_with(
            "https://valhalla.internal",
            auth_token=None,
            tileset_version=TILESET_VERSION,
            expected_osm_changeset=123456,
        )
        self.assertTrue(details["routing_ready"])
        self.assertEqual(details["routing_engine"], "valhalla")
        self.assertEqual(details["routing_profile"], "truck")
        self.assertEqual(details["osm_changeset"], 123456)
        self.assertGreater(details["status_validated_epoch"], 0)
        self.assertEqual(
            details["engine_status_response_sha256"],
            "a" * 64,
        )

    def test_route_adapter_rejects_missing_controlled_dataset_identity(self):
        with patch.dict(
            "os.environ",
            {
                "VALHALLA_URL": "https://valhalla.internal",
                "VALHALLA_TILESET_VERSION": TILESET_VERSION,
            },
            clear=True,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "VALHALLA_OSM_CHANGESET is required",
            ):
                _route_adapter_from_environment()

    def test_route_job_is_row_locked_before_idempotency_check(self):
        route_job_id = UUID("10000000-0000-4000-8000-000000000001")
        route_job = {
            "route_job_id": route_job_id,
            "replenishment_plan_id": UUID(
                "20000000-0000-4000-8000-000000000002"
            ),
        }
        connection = FakeConnection([route_job])

        self.assertEqual(_lock_route_job(connection, route_job_id), route_job)

        query, params = connection.cursor_instance.calls[0]
        self.assertIn("for update", " ".join(query.split()).lower())
        self.assertEqual(params, (route_job_id,))

    def test_route_inputs_use_exact_canonical_contracts(self):
        plan_id = UUID("20000000-0000-4000-8000-000000000002")
        route_job = {"replenishment_plan_id": plan_id}
        item_rows = [valid_item()]
        depot_row = valid_depot()
        vehicle_rows = [valid_vehicle()]
        connection = FakeConnection([item_rows, depot_row, vehicle_rows])

        loaded = _load_route_inputs(connection, route_job)
        self.assertEqual(loaded, (item_rows, depot_row, vehicle_rows))

        item_query, item_params = connection.cursor_instance.calls[0]
        normalized_item_query = " ".join(item_query.split()).lower()
        self.assertIn("item.final_qty as quantity", normalized_item_query)
        self.assertIn("item.status=%s", normalized_item_query)
        self.assertIn("item.final_qty > 0", normalized_item_query)
        self.assertIn("core.packaging_profiles", normalized_item_query)
        self.assertIn("packaging_source_checksum_sha256", normalized_item_query)
        self.assertIn("profile_source_checksum_sha256", normalized_item_query)
        self.assertIn("core.transport_district_geo", normalized_item_query)
        self.assertIn("core.location_geocodes", normalized_item_query)
        self.assertEqual(item_params, (plan_id, ROUTABLE_ITEM_STATUS))

        plan_query, plan_params = connection.cursor_instance.calls[1]
        normalized_plan_query = " ".join(plan_query.split()).lower()
        self.assertIn("core.transport_warehouses", normalized_plan_query)
        self.assertIn(
            "transport_warehouse.canonical_warehouse_id",
            normalized_plan_query,
        )
        self.assertIn("not exists", normalized_plan_query)
        self.assertIn("newer.version_no > plan.version_no", normalized_plan_query)
        self.assertEqual(plan_params, (plan_id,))

        vehicle_query, vehicle_params = connection.cursor_instance.calls[2]
        normalized_vehicle_query = " ".join(vehicle_query.split()).lower()
        self.assertIn("core.transport_vehicles", normalized_vehicle_query)
        self.assertIn("join core.vehicles canonical", normalized_vehicle_query)
        self.assertIn(
            "vehicle.vehicle_id as transport_vehicle_id",
            normalized_vehicle_query,
        )
        self.assertIn(
            "vehicle.canonical_vehicle_id as vehicle_id",
            normalized_vehicle_query,
        )
        self.assertIn("capacity_evidence_status", normalized_vehicle_query)
        self.assertIn("availability_expires_at", normalized_vehicle_query)
        self.assertIn("warehouse.canonical_warehouse_id=%s", normalized_vehicle_query)
        self.assertIn(
            "vehicle.vehicle_mapping_status='verified'",
            normalized_vehicle_query,
        )
        self.assertIn(
            "vehicle.capacity_evidence_status='verified'",
            normalized_vehicle_query,
        )
        self.assertIn(
            "vehicle.availability_evidence_status='available'",
            normalized_vehicle_query,
        )
        self.assertIn(
            "vehicle.availability_expires_at > clock_timestamp()",
            normalized_vehicle_query,
        )
        self.assertEqual(
            vehicle_params,
            ("เมืองใหม่", "WH-MMBP-CANONICAL"),
        )

    def test_verified_canonical_inputs_are_routable(self):
        _validate_route_inputs(
            [valid_item()],
            valid_depot(),
            [valid_vehicle()],
        )

    def test_draft_or_superseded_plan_is_not_routable(self):
        with self.assertRaisesRegex(ValueError, "must be locked"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(plan_status="draft"),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "latest active"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(is_latest_active_version=False),
                [valid_vehicle()],
            )

    def test_depot_requires_exact_mapping_and_verified_source(self):
        with self.assertRaisesRegex(ValueError, "exact transport-to-canonical"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(
                    mapped_canonical_warehouse_id=None,
                    transport_warehouse_code="เมืองใหม่",
                ),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "warehouse geocode must be verified"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(depot_geocode_status="quarantined"),
                [valid_vehicle()],
            )

    def test_item_geocode_and_uom_must_match_canonical_evidence(self):
        with self.assertRaisesRegex(ValueError, "must match exactly"):
            _validate_route_inputs(
                [valid_item(location_latitude=13.8)],
                valid_depot(),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "UOM must match"):
            _validate_route_inputs(
                [valid_item(packaging_quantity_uom="BOX")],
                valid_depot(),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "verified actual evidence"):
            _validate_route_inputs(
                [valid_item(profile_data_class="test_fixture")],
                valid_depot(),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "row-traceable"):
            _validate_route_inputs(
                [valid_item(packaging_source_checksum_sha256=None)],
                valid_depot(),
                [valid_vehicle()],
            )
        with self.assertRaisesRegex(ValueError, "share one source row"):
            _validate_route_inputs(
                [valid_item(profile_source_row_number=3)],
                valid_depot(),
                [valid_vehicle()],
            )

    def test_fleet_capacity_fails_closed_without_verified_provenance(self):
        with self.assertRaisesRegex(ValueError, "max_pallets must be a finite number"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [valid_vehicle(max_pallets=None)],
            )
        with self.assertRaisesRegex(ValueError, "capacity evidence must be verified"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [valid_vehicle(capacity_evidence_status=None)],
            )

    def test_fleet_requires_explicit_mapping_and_current_availability(self):
        with self.assertRaisesRegex(ValueError, "canonical vehicle mapping"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [valid_vehicle(vehicle_id=None)],
            )
        with self.assertRaisesRegex(ValueError, "mapping evidence must be verified"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [valid_vehicle(vehicle_mapping_status="unmapped")],
            )
        with self.assertRaisesRegex(ValueError, "must say available"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [valid_vehicle(availability_evidence_status="unavailable")],
            )
        with self.assertRaisesRegex(ValueError, "current and non-expired"):
            _validate_route_inputs(
                [valid_item()],
                valid_depot(),
                [
                    valid_vehicle(
                        availability_checked_at=(
                            datetime.now(timezone.utc) - timedelta(hours=2)
                        ),
                        availability_expires_at=(
                            datetime.now(timezone.utc) - timedelta(hours=1)
                        ),
                    )
                ],
            )

    def test_road_evidence_uses_depot_ordered_stops_and_depot(self):
        depot = Coordinate(13.55, 100.77)
        stop = DeliveryStop(
            "5501",
            Coordinate(13.81, 100.64),
            100,
            1,
            1,
            10,
            0,
            1439,
            5,
        )
        route = VehicleRoute(
            "M13E-CANONICAL-1",
            (PlannedStop("5501", 1, 120),),
            10_000,
            1_000,
            100,
            1,
            1,
        )
        status = RoutingEngineStatus(
            "3.5.1",
            1_721_865_600,
            123456,
            True,
            "a" * 64,
        )

        class FakeAdapter:
            tileset_version = TILESET_VERSION

            def __init__(self):
                self.calls = []

            def build_route(self, coordinates):
                self.calls.append(tuple(coordinates))
                return RoadRouteEvidence(
                    {
                        "type": "LineString",
                        "coordinates": [
                            [100.77, 13.55],
                            [100.64, 13.81],
                            [100.77, 13.55],
                        ],
                    },
                    12_345,
                    1_234,
                    None,
                    "valhalla",
                    status.version,
                    "truck",
                    self.tileset_version,
                    status.tileset_last_modified,
                    status.osm_changeset,
                    status.response_hash,
                    3,
                    "c" * 64,
                    "d" * 64,
                )

        adapter = FakeAdapter()
        evidence = _build_vehicle_road_evidence(
            adapter,
            depot,
            [stop],
            SimpleNamespace(routes=(route,)),
            status,
        )

        self.assertEqual(
            adapter.calls,
            [(depot, stop.coordinate, depot)],
        )
        self.assertEqual(
            evidence["M13E-CANONICAL-1"].distance_m,
            12_345,
        )

    def test_worker_persists_real_road_metrics_without_internal_commit(self):
        source = inspect.getsource(_process_route)
        adapter_source = inspect.getsource(_route_adapter_from_environment)
        self.assertIn("route_plan_vehicle_road_evidence", source)
        self.assertIn("evidence.distance_m", source)
        self.assertIn("evidence.duration_s", source)
        self.assertIn("accepts only Valhalla", source)
        self.assertIn("VALHALLA_OSM_CHANGESET", adapter_source)
        self.assertIn("expected_osm_changeset", adapter_source)
        self.assertIn("route_matrix_id", source)
        self.assertNotIn("HaversineMatrixAdapter", source)
        self.assertNotIn("connection.commit", source)

    def test_existing_plan_is_reused_without_external_work_or_commit(self):
        route_job_id = UUID("10000000-0000-4000-8000-000000000001")
        route_plan_id = UUID("40000000-0000-4000-8000-000000000004")
        route_job = {
            "route_job_id": route_job_id,
            "replenishment_plan_id": UUID(
                "20000000-0000-4000-8000-000000000002"
            ),
        }
        connection = FakeConnection(
            [
                route_job,
                {
                    "route_plan_id": route_plan_id,
                    "served_stop_count": 7,
                    "unserved_stop_count": 1,
                },
            ]
        )

        result = _process_route(connection, route_job_id)

        self.assertEqual(
            result,
            {
                "route_job_id": str(route_job_id),
                "route_plan_id": str(route_plan_id),
                "served_stops": 7,
                "unserved_stops": 1,
                "reused_existing_plan": True,
            },
        )
        self.assertEqual(connection.commits, 0)
        self.assertEqual(len(connection.cursor_instance.calls), 2)
        self.assertNotIn("commit", inspect.getsource(_process_route))

    def test_forecast_write_is_committed_with_background_completion(self):
        self.assertNotIn("connection.commit", inspect.getsource(_process_forecast))

    def test_post_commit_heartbeat_failure_is_best_effort(self):
        connection = FakeConnection([])
        with patch(
            "synapse_intelligence.worker._heartbeat",
            side_effect=RuntimeError("heartbeat unavailable"),
        ):
            published = _heartbeat_best_effort(
                connection,
                "worker-1",
                "healthy",
                phase="completed",
            )

        self.assertFalse(published)
        self.assertEqual(connection.rollbacks, 1)

    def test_route_eta_anchors_to_plan_week_in_bangkok_time(self):
        start = _route_start_at({"week_start_date": date(2026, 7, 27)})
        self.assertEqual(start.isoformat(), "2026-07-27T00:00:00+07:00")

    def test_non_positive_demand_is_excluded(self):
        positive = {"replenishment_item_id": "positive", "quantity": 5}
        self.assertEqual(
            _positive_demand_rows(
                [
                    {"replenishment_item_id": "zero", "quantity": 0},
                    {"replenishment_item_id": "negative", "quantity": -2},
                    positive,
                ]
            ),
            [positive],
        )
        with self.assertRaisesRegex(ValueError, "no positive demand"):
            _positive_demand_rows(
                [
                    {"replenishment_item_id": "zero", "quantity": 0},
                    {"replenishment_item_id": "negative", "quantity": -2},
                ]
            )

    def test_non_finite_demand_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "finite number"):
            _positive_demand_rows(
                [{"replenishment_item_id": "invalid", "quantity": float("nan")}]
            )


if __name__ == "__main__":
    unittest.main()
