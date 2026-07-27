from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
import math
import os
import re
import socket
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row

from .forecasting import MODEL_VERSIONS, forecast_best_available
from .routing import (
    Coordinate,
    DeliveryStop,
    OrToolsOptimizer,
    RoadRouteEvidence,
    RoutingEngineStatus,
    ValhallaMatrixAdapter,
    Vehicle,
    is_canonical_tileset_version,
)


SERVICE_VERSION = "1.2.0-m13e-route-evidence-attested"
ROUTING_ATTESTATION_VERSION = "valhalla-status-v1"
ROUTABLE_PLAN_STATUS = "locked"
ROUTABLE_ITEM_STATUS = "locked"
ROUTE_TIMEZONE = ZoneInfo("Asia/Bangkok")
VERIFIED_GEOCODE_STATUS = "verified"
VERIFIED_MAPPING_STATUS = "verified"
VERIFIED_CAPACITY_STATUS = "verified"
AVAILABLE_EVIDENCE_STATUS = "available"
VERIFIED_PACKAGING_QUALITY = "verified"
ACTUAL_DATA_CLASS = "actual"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _heartbeat(connection, worker_id: str, status: str, **details: Any) -> None:
    if status == "healthy" and (
        details.get("routing_attestation_version")
        != ROUTING_ATTESTATION_VERSION
        or details.get("routing_ready") is not True
        or details.get("routing_engine") != "valhalla"
        or details.get("routing_profile") != "truck"
        or details.get("routing_url_policy")
        != "controlled_non_community_origin"
        or not isinstance(details.get("valhalla_url"), str)
        or not details["valhalla_url"].strip()
        or not is_canonical_tileset_version(details.get("tileset_version"))
        or not isinstance(details.get("engine_version"), str)
        or not details["engine_version"].strip()
        or isinstance(details.get("tileset_last_modified"), bool)
        or not isinstance(details.get("tileset_last_modified"), int)
        or details["tileset_last_modified"] <= 0
        or isinstance(details.get("osm_changeset"), bool)
        or not isinstance(details.get("osm_changeset"), int)
        or details["osm_changeset"] < 0
        or not isinstance(details.get("engine_status_response_sha256"), str)
        or not SHA256_PATTERN.fullmatch(
            details["engine_status_response_sha256"]
        )
        or not isinstance(details.get("status_validated_at"), str)
        or not details["status_validated_at"].strip()
        or isinstance(details.get("status_validated_epoch"), bool)
        or not isinstance(details.get("status_validated_epoch"), int)
        or details["status_validated_epoch"] <= 0
    ):
        raise ValueError(
            "healthy route worker heartbeat requires validated Valhalla status attestation"
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "select ops.record_service_heartbeat(%s,%s,%s,%s,%s::jsonb)",
            (f"synapse-worker:{worker_id}", worker_id, SERVICE_VERSION, status, json.dumps(details, default=str)),
        )
    connection.commit()


def _heartbeat_best_effort(
    connection,
    worker_id: str,
    status: str,
    **details: Any,
) -> bool:
    """Publish post-commit observability without changing the job outcome."""

    try:
        _heartbeat(connection, worker_id, status, **details)
    except Exception:
        connection.rollback()
        return False
    return True


def _route_adapter_from_environment() -> ValhallaMatrixAdapter:
    base_url = os.environ.get("VALHALLA_URL")
    if not base_url:
        raise ValueError("VALHALLA_URL is required for production matrix jobs")
    tileset_version = os.environ.get("VALHALLA_TILESET_VERSION")
    if not tileset_version:
        raise ValueError(
            "VALHALLA_TILESET_VERSION is required for production matrix jobs"
        )
    osm_changeset_value = os.environ.get("VALHALLA_OSM_CHANGESET", "").strip()
    if not re.fullmatch(r"\d+", osm_changeset_value):
        raise ValueError(
            "VALHALLA_OSM_CHANGESET is required and must be the controlled non-negative Valhalla dataset id"
        )
    return ValhallaMatrixAdapter(
        base_url,
        auth_token=os.environ.get("VALHALLA_AUTH_TOKEN"),
        tileset_version=tileset_version,
        expected_osm_changeset=int(osm_changeset_value),
    )


def _validated_routing_heartbeat_details() -> dict[str, Any]:
    """Attest routing health only after controlled-origin /status validation."""

    adapter = _route_adapter_from_environment()
    status = adapter.status()
    if status.osm_changeset is None:
        raise ValueError(
            "Valhalla status did not resolve the controlled OSM changeset"
        )
    validated_at = datetime.now(timezone.utc)
    return {
        "routing_attestation_version": ROUTING_ATTESTATION_VERSION,
        "routing_ready": True,
        "routing_engine": "valhalla",
        "routing_profile": "truck",
        "routing_url_policy": "controlled_non_community_origin",
        "valhalla_url": adapter.base_url,
        "tileset_version": adapter.tileset_version,
        "engine_version": status.version,
        "tileset_last_modified": status.tileset_last_modified,
        "osm_changeset": status.osm_changeset,
        "engine_status_response_sha256": status.response_hash,
        "status_validated_at": validated_at.isoformat(),
        "status_validated_epoch": int(validated_at.timestamp()),
    }


def _month_add(value: date, months: int) -> date:
    absolute = value.year * 12 + value.month - 1 + months
    return date(absolute // 12, absolute % 12 + 1, 1)


def _claim(connection, worker_id: str) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        # Calling a volatile composite function as ``(function()).*`` can make
        # PostgreSQL evaluate it once per expanded column and claim multiple
        # jobs in one poll. A FROM item materializes exactly one function call.
        cursor.execute(
            "select claimed.* from ops.claim_background_job(%s, %s::text[]) as claimed",
            (worker_id, ["forecast", "route"]),
        )
        row = cursor.fetchone()
    connection.commit()
    return row if row and row.get("job_id") else None


def run_once(database_url: str, *, worker_id: str = "synapse-worker") -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        try:
            routing_details = _validated_routing_heartbeat_details()
        except Exception as exc:
            _heartbeat(
                connection,
                worker_id,
                "degraded",
                hostname=socket.gethostname(),
                phase="routing_preflight_failed",
                routing_ready=False,
                error_type=type(exc).__name__,
            )
            raise
        _heartbeat(
            connection,
            worker_id,
            "healthy",
            hostname=socket.gethostname(),
            phase="polling",
            **routing_details,
        )
        job = _claim(connection, worker_id)
        if not job:
            _heartbeat(
                connection,
                worker_id,
                "healthy",
                hostname=socket.gethostname(),
                phase="idle",
                **routing_details,
            )
            return {"status": "idle"}
        try:
            if job["job_type"] == "forecast":
                result = _process_forecast(connection, UUID(str(job["payload"]["forecast_run_id"])))
            elif job["job_type"] == "route":
                result = _process_route(connection, UUID(str(job["payload"]["route_job_id"])))
            else:
                raise ValueError(f"unsupported job type: {job['job_type']}")
            with connection.cursor() as cursor:
                cursor.execute("select ops.complete_background_job(%s, %s::jsonb)", (job["job_id"], json.dumps(result)))
            connection.commit()
            try:
                completion_routing_details = (
                    _validated_routing_heartbeat_details()
                )
            except Exception as heartbeat_exc:
                _heartbeat_best_effort(
                    connection,
                    worker_id,
                    "degraded",
                    hostname=socket.gethostname(),
                    phase="routing_postflight_failed",
                    job_id=str(job["job_id"]),
                    routing_ready=False,
                    error_type=type(heartbeat_exc).__name__,
                )
            else:
                _heartbeat_best_effort(
                    connection,
                    worker_id,
                    "healthy",
                    hostname=socket.gethostname(),
                    phase="completed",
                    job_id=str(job["job_id"]),
                    **completion_routing_details,
                )
            return {"status": "succeeded", "job_id": str(job["job_id"]), **result}
        except Exception as exc:
            connection.rollback()
            with connection.cursor() as cursor:
                cursor.execute("select ops.fail_background_job(%s, %s, 60)", (job["job_id"], str(exc)))
                cursor.execute("select status from ops.background_jobs where job_id=%s", (job["job_id"],))
                terminal = cursor.fetchone()["status"] == "failed"
                if terminal and job["job_type"] == "forecast" and job["payload"].get("forecast_run_id"):
                    cursor.execute(
                        """
                        update analytics.forecast_runs
                        set status='failed', error_message=%s, finished_at=now()
                        where forecast_run_id=%s
                        """,
                        (str(exc)[:4000], job["payload"]["forecast_run_id"]),
                    )
            connection.commit()
            _heartbeat_best_effort(
                connection,
                worker_id,
                "degraded",
                hostname=socket.gethostname(),
                phase="job_failed",
                job_id=str(job["job_id"]),
                error_type=type(exc).__name__,
                **routing_details,
            )
            return {"status": "failed", "job_id": str(job["job_id"]), "error": str(exc)}


def _process_forecast(connection, forecast_run_id: UUID) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute("select * from analytics.forecast_runs where forecast_run_id = %s for update", (forecast_run_id,))
        run = cursor.fetchone()
        if not run:
            raise ValueError("forecast run not found")
        cursor.execute(
            "update analytics.forecast_runs set status='running', started_at=now(), error_message=null where forecast_run_id=%s",
            (forecast_run_id,),
        )
        cursor.execute(
            """
            select material_id, district_id, period_start, demand_quantity
            from analytics.demand_monthly_features
            where feature_version = %s and period_start <= %s
              and (%s::date is null or period_start >= %s::date)
            order by material_id, district_id, period_start
            """,
            (run["feature_version"], run["training_end"], run["training_start"], run["training_start"]),
        )
        source_rows = cursor.fetchall()

    series: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        series[(row["material_id"], row["district_id"])].append(row)
    if not any(len(rows) >= 7 for rows in series.values()):
        raise ValueError("no demand series has the minimum seven monthly observations")

    # Intermittent-demand models (Croston/SBA/TSB) are activation-gated: they are
    # only selected once their model versions are registered in
    # analytics.forecast_model_versions. Enabling the flag without applying the
    # prepared registration migration would violate the model_version foreign
    # key, so keep the switch joined to the reviewed database release.
    allow_intermittent = os.environ.get("SYNAPSE_INTERMITTENT_FORECAST", "").strip() == "1"
    result_count = 0
    processed_series = 0
    with connection.cursor() as cursor:
        for (material_id, district_id), rows in series.items():
            history = [float(row["demand_quantity"]) for row in rows]
            if len(history) < 7:
                continue
            evaluations, selected, forecast_points = forecast_best_available(
                history, run["horizon_months"], allow_intermittent=allow_intermittent
            )
            model_versions = MODEL_VERSIONS
            for evaluation in evaluations:
                cursor.execute(
                    """
                    insert into analytics.forecast_metrics (
                      forecast_run_id, material_id, district_id, model_version,
                      backtest_start, backtest_end, observation_count, wape, mae, bias, selected
                    ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    on conflict (forecast_run_id, material_id, district_id, model_version) do update
                    set observation_count=excluded.observation_count, wape=excluded.wape,
                        mae=excluded.mae, bias=excluded.bias, selected=excluded.selected
                    """,
                    (
                        forecast_run_id, material_id, district_id, model_versions[evaluation.model_name],
                        rows[6]["period_start"], rows[-1]["period_start"], evaluation.metrics.observations,
                        evaluation.metrics.wape, evaluation.metrics.mae, evaluation.metrics.bias,
                        evaluation.model_name == selected.model_name,
                    ),
                )
            for point in forecast_points:
                forecast_period = _month_add(run["training_end"].replace(day=1), point.horizon)
                cursor.execute(
                    """
                    insert into analytics.forecast_results (
                      forecast_run_id, material_id, district_id, forecast_period, horizon,
                      model_version, predicted_quantity, lower_80, upper_80
                    ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    on conflict (forecast_run_id, material_id, district_id, forecast_period) do update
                    set model_version=excluded.model_version, predicted_quantity=excluded.predicted_quantity,
                        lower_80=excluded.lower_80, upper_80=excluded.upper_80
                    """,
                    (
                        forecast_run_id, material_id, district_id, forecast_period, point.horizon,
                        model_versions[selected.model_name], point.predicted, point.lower_80, point.upper_80,
                    ),
                )
                result_count += 1
            processed_series += 1
        cursor.execute(
            """
            update analytics.forecast_runs
            set status='succeeded', series_count=%s, result_count=%s, finished_at=now()
            where forecast_run_id=%s
            """,
            (processed_series, result_count, forecast_run_id),
        )
    return {"forecast_run_id": str(forecast_run_id), "series_count": processed_series, "result_count": result_count}


def _time_to_minute(value: time | None, default: int) -> int:
    return default if value is None else value.hour * 60 + value.minute


def _lock_route_job(connection, route_job_id: UUID) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            "select * from ops.route_jobs where route_job_id=%s for update",
            (route_job_id,),
        )
        route_job = cursor.fetchone()
    if not route_job:
        raise ValueError("route job not found")
    return route_job


def _load_existing_route_result(
    connection,
    route_job_id: UUID,
) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            select route_plan_id, served_stop_count, unserved_stop_count
            from core.route_plans
            where route_job_id=%s
            """,
            (route_job_id,),
        )
        existing = cursor.fetchone()
    if not existing:
        return None
    return {
        "route_job_id": str(route_job_id),
        "route_plan_id": str(existing["route_plan_id"]),
        "served_stops": existing["served_stop_count"],
        "unserved_stops": existing["unserved_stop_count"],
        "reused_existing_plan": True,
    }


def _load_route_inputs(connection, route_job: dict[str, Any]):
    replenishment_plan_id = route_job["replenishment_plan_id"]
    with connection.cursor() as cursor:
        cursor.execute(
            """
            select
              item.replenishment_item_id,
              item.material_id,
              item.district_id,
              item.status as item_status,
              item.final_qty as quantity,
              item.priority_score,
              material.unit as material_uom,
              material.weight_per_unit_kg as material_weight_per_unit_kg,
              packaging.quantity_uom as packaging_quantity_uom,
              packaging.quantity_per_box,
              packaging.box_volume_m3,
              packaging.weight_per_box_kg,
              packaging.boxes_per_pallet,
              packaging.source_reference as packaging_source_reference,
              packaging.source_checksum_sha256 as
                packaging_source_checksum_sha256,
              packaging.source_row_number as packaging_source_row_number,
              packaging.verified_at as packaging_verified_at,
              packaging.verified_by as packaging_verified_by,
              packaging.verification_ticket as packaging_verification_ticket,
              profile.base_uom as profile_base_uom,
              profile.full_pallet_qty,
              profile.inner_pack_qty,
              profile.data_class as profile_data_class,
              profile.source_quality as profile_source_quality,
              profile.source_reference as profile_source_reference,
              profile.source_checksum_sha256 as
                profile_source_checksum_sha256,
              profile.source_row_number as profile_source_row_number,
              profile.verified_at as profile_verified_at,
              profile.verified_by as profile_verified_by,
              profile.verification_ticket as profile_verification_ticket,
              canonical_geo.latitude,
              canonical_geo.longitude,
              canonical_geo.geocode_status,
              canonical_geo.source_reference as geocode_source_reference,
              canonical_geo.source_checksum_sha256 as
                geocode_source_checksum_sha256,
              canonical_geo.source_row_number as geocode_source_row_number,
              canonical_geo.verified_at as geocode_verified_at,
              location_geo.latitude as location_latitude,
              location_geo.longitude as location_longitude,
              location_geo.source_reference as
                location_geocode_source_reference,
              location_geo.source_checksum_sha256 as
                location_geocode_source_checksum_sha256,
              location_geo.source_row_number as
                location_geocode_source_row_number,
              location_geo.verified_at as location_geocode_verified_at,
              location_geo.time_window_start,
              location_geo.time_window_end,
              location_geo.service_minutes
            from core.replenishment_items item
            join core.materials material
              on material.material_id = item.material_id
            left join core.material_packaging packaging
              on packaging.material_id = item.material_id
            left join core.packaging_profiles profile
              on profile.material_id = item.material_id
            left join core.transport_district_geo canonical_geo
              on canonical_geo.district_id = item.district_id
             and not canonical_geo.is_warehouse
            left join core.location_geocodes location_geo
              on location_geo.location_id = 'DIST-' || item.district_id
            where item.replenishment_plan_id=%s
              and item.status=%s
              and item.final_qty > 0
            order by item.district_id, item.material_id,
                     item.replenishment_item_id
            """,
            (replenishment_plan_id, ROUTABLE_ITEM_STATUS),
        )
        item_rows = cursor.fetchall()
        cursor.execute(
            """
            select
              plan.status as plan_status,
              plan.origin_location_id,
              plan.week_start_date,
              plan.version_no,
              origin.location_type as origin_location_type,
              origin.is_active as origin_location_active,
              canonical.warehouse_id as origin_warehouse_id,
              canonical.is_active as origin_warehouse_active,
              transport_warehouse.warehouse_code as
                transport_warehouse_code,
              transport_warehouse.canonical_warehouse_id as
                mapped_canonical_warehouse_id,
              depot_geo.district_ref as depot_district_ref,
              depot_geo.latitude,
              depot_geo.longitude,
              depot_geo.geocode_status as depot_geocode_status,
              depot_geo.source_reference as depot_source_reference,
              depot_geo.source_checksum_sha256 as
                depot_source_checksum_sha256,
              depot_geo.source_row_number as depot_source_row_number,
              depot_geo.verified_at as depot_verified_at,
              not exists (
                select 1
                from core.replenishment_plans newer
                where coalesce(
                    newer.parent_plan_id,
                    newer.replenishment_plan_id
                  ) = coalesce(
                    plan.parent_plan_id,
                    plan.replenishment_plan_id
                  )
                  and newer.version_no > plan.version_no
                  and newer.status not in ('cancelled', 'completed')
              ) as is_latest_active_version
            from core.replenishment_plans plan
            left join core.locations origin
              on origin.location_id = plan.origin_location_id
            left join core.warehouses canonical
              on canonical.warehouse_id = origin.warehouse_id
            left join core.transport_warehouses transport_warehouse
              on transport_warehouse.canonical_warehouse_id =
                canonical.warehouse_id
             and transport_warehouse.is_active
            left join core.transport_district_geo depot_geo
              on depot_geo.is_warehouse
             and depot_geo.warehouse_code =
                transport_warehouse.warehouse_code
            where plan.replenishment_plan_id=%s
            """,
            (replenishment_plan_id,),
        )
        depot_row = cursor.fetchone()
        cursor.execute(
            """
            select
              vehicle.vehicle_id as transport_vehicle_id,
              vehicle.canonical_vehicle_id as vehicle_id,
              canonical.max_weight_kg,
              canonical.max_volume_m3,
              canonical.max_pallets,
              vehicle.vehicle_mapping_status,
              vehicle.vehicle_mapping_source_reference,
              vehicle.vehicle_mapping_source_checksum_sha256,
              vehicle.vehicle_mapping_source_row_number,
              vehicle.vehicle_mapping_verified_at,
              vehicle.vehicle_mapping_verified_by,
              vehicle.vehicle_mapping_approval_ticket,
              vehicle.capacity_evidence_status,
              vehicle.capacity_source_reference,
              vehicle.capacity_source_checksum_sha256,
              vehicle.capacity_source_row_number,
              vehicle.capacity_verified_at,
              vehicle.capacity_verified_by,
              vehicle.capacity_verification_ticket,
              vehicle.availability_evidence_status,
              vehicle.availability_source_reference,
              vehicle.availability_source_checksum_sha256,
              vehicle.availability_source_row_number,
              vehicle.availability_checked_at,
              vehicle.availability_expires_at,
              vehicle.availability_verified_by,
              vehicle.availability_verification_ticket,
              vehicle.current_warehouse,
              warehouse.canonical_warehouse_id,
              canonical.is_active as canonical_vehicle_active,
              canonical_home.is_active as canonical_home_location_active,
              canonical_home.warehouse_id as canonical_home_warehouse_id
            from core.transport_vehicles vehicle
            join core.vehicles canonical
              on canonical.vehicle_id = vehicle.canonical_vehicle_id
            join core.locations canonical_home
              on canonical_home.location_id = canonical.home_location_id
             and canonical_home.location_type = 'WAREHOUSE'
            join core.transport_warehouses warehouse
              on warehouse.warehouse_code = vehicle.current_warehouse
             and warehouse.is_active
            where vehicle.is_active
              and vehicle.current_warehouse=%s
              and warehouse.canonical_warehouse_id=%s
              and vehicle.vehicle_mapping_status='verified'
              and vehicle.capacity_evidence_status='verified'
              and vehicle.availability_evidence_status='available'
              and vehicle.availability_checked_at <= clock_timestamp()
              and vehicle.availability_expires_at > clock_timestamp()
            order by vehicle.vehicle_id
            """,
            (
                depot_row["transport_warehouse_code"] if depot_row else None,
                depot_row["origin_warehouse_id"] if depot_row else None,
            ),
        )
        vehicle_rows = cursor.fetchall()
    return item_rows, depot_row, vehicle_rows


def _validate_route_inputs(item_rows, depot_row, vehicle_rows) -> None:
    if not depot_row:
        raise ValueError("replenishment plan not found")
    if depot_row.get("plan_status") != ROUTABLE_PLAN_STATUS:
        raise ValueError("replenishment plan must be locked before routing")
    if depot_row.get("is_latest_active_version") is not True:
        raise ValueError(
            "replenishment plan must be the latest active root-lineage version"
        )
    if (
        depot_row.get("origin_location_type") != "WAREHOUSE"
        or depot_row.get("origin_location_active") is not True
        or depot_row.get("origin_warehouse_active") is not True
    ):
        raise ValueError(
            "replenishment plan origin must be an active canonical warehouse"
        )
    if (
        not depot_row.get("origin_warehouse_id")
        or not depot_row.get("transport_warehouse_code")
        or depot_row.get("mapped_canonical_warehouse_id")
        != depot_row.get("origin_warehouse_id")
    ):
        raise ValueError(
            "exact transport-to-canonical warehouse mapping is required"
        )
    _validate_geocode_evidence(
        depot_row,
        status_field="depot_geocode_status",
        latitude_field="latitude",
        longitude_field="longitude",
        source_reference_field="depot_source_reference",
        source_checksum_field="depot_source_checksum_sha256",
        source_row_field="depot_source_row_number",
        verified_at_field="depot_verified_at",
        label="warehouse",
    )
    if not item_rows:
        raise ValueError("locked replenishment plan has no positive locked demand")
    for row in item_rows:
        _validate_route_item(row)
    if not vehicle_rows:
        raise ValueError(
            "at least one active canonical vehicle at the exact warehouse is required"
        )
    for row in vehicle_rows:
        _validate_vehicle_capacity(row, depot_row["origin_warehouse_id"])


def _validate_route_item(row: dict[str, Any]) -> None:
    if row.get("item_status") != ROUTABLE_ITEM_STATUS:
        raise ValueError("every routed replenishment item must be locked")
    _positive_finite(row.get("quantity"), "replenishment demand quantity")
    priority_score = _positive_finite(
        row.get("priority_score"),
        "replenishment priority_score",
    )
    if priority_score > 10:
        raise ValueError("replenishment priority_score must not exceed 10")
    _validate_geocode_evidence(
        row,
        status_field="geocode_status",
        latitude_field="latitude",
        longitude_field="longitude",
        source_reference_field="geocode_source_reference",
        source_checksum_field="geocode_source_checksum_sha256",
        source_row_field="geocode_source_row_number",
        verified_at_field="geocode_verified_at",
        label=f"district {row.get('district_id', 'unknown')}",
    )
    _coordinate(
        row.get("location_latitude"),
        row.get("location_longitude"),
        "location geocode",
    )
    if (
        row.get("location_geocode_verified_at") is None
        or not _normalized_text(row.get("location_geocode_source_reference"))
    ):
        raise ValueError("location geocode must be verified")
    if not _valid_sha256(row.get("location_geocode_source_checksum_sha256")):
        raise ValueError("location geocode requires a source checksum")
    if not _positive_integer(row.get("location_geocode_source_row_number")):
        raise ValueError("location geocode requires a source row number")
    if (
        not math.isclose(
            float(row["latitude"]),
            float(row["location_latitude"]),
            rel_tol=0,
            abs_tol=1e-8,
        )
        or not math.isclose(
            float(row["longitude"]),
            float(row["location_longitude"]),
            rel_tol=0,
            abs_tol=1e-8,
        )
        or row.get("geocode_source_checksum_sha256")
        != row.get("location_geocode_source_checksum_sha256")
        or row.get("geocode_source_row_number")
        != row.get("location_geocode_source_row_number")
    ):
        raise ValueError(
            "transport and route-worker district geocodes must match exactly"
        )

    material_uom = _normalized_text(row.get("material_uom"))
    if not material_uom:
        raise ValueError("material UOM is required")
    if (
        _normalized_text(row.get("packaging_quantity_uom")) != material_uom
        or _normalized_text(row.get("profile_base_uom")) != material_uom
    ):
        raise ValueError(
            "material, physical-packaging and canonical-profile UOM must match"
        )
    if (
        row.get("packaging_verified_at") is None
        or not _normalized_text(row.get("packaging_source_reference"))
        or not _valid_sha256(row.get("packaging_source_checksum_sha256"))
        or not _positive_integer(row.get("packaging_source_row_number"))
        or row.get("packaging_verified_by") is None
        or not _normalized_text(row.get("packaging_verification_ticket"))
    ):
        raise ValueError(
            "physical packaging evidence must be verified, row-traceable and sourced"
        )
    if (
        row.get("profile_data_class") != ACTUAL_DATA_CLASS
        or row.get("profile_source_quality") != VERIFIED_PACKAGING_QUALITY
        or row.get("profile_verified_at") is None
        or not _normalized_text(row.get("profile_source_reference"))
        or not _valid_sha256(row.get("profile_source_checksum_sha256"))
        or not _positive_integer(row.get("profile_source_row_number"))
        or row.get("profile_verified_by") is None
        or not _normalized_text(row.get("profile_verification_ticket"))
    ):
        raise ValueError(
            "canonical packaging profile must be verified actual evidence"
        )
    if (
        row.get("packaging_source_checksum_sha256")
        != row.get("profile_source_checksum_sha256")
        or row.get("packaging_source_row_number")
        != row.get("profile_source_row_number")
        or row.get("packaging_verified_by")
        != row.get("profile_verified_by")
        or _normalized_text(row.get("packaging_verification_ticket"))
        != _normalized_text(row.get("profile_verification_ticket"))
    ):
        raise ValueError(
            "physical and canonical packaging evidence must share one source row"
        )

    quantity_per_box = _positive_finite(
        row.get("quantity_per_box"),
        "quantity_per_box",
    )
    _positive_finite(
        row.get("box_volume_m3"),
        "box_volume_m3",
    )
    weight_per_box_kg = _positive_finite(
        row.get("weight_per_box_kg"),
        "weight_per_box_kg",
    )
    boxes_per_pallet = _positive_finite(
        row.get("boxes_per_pallet"),
        "boxes_per_pallet",
    )
    inner_pack_qty = _positive_finite(
        row.get("inner_pack_qty"),
        "inner_pack_qty",
    )
    full_pallet_qty = _positive_finite(
        row.get("full_pallet_qty"),
        "full_pallet_qty",
    )
    material_weight_per_unit_kg = _positive_finite(
        row.get("material_weight_per_unit_kg"),
        "material_weight_per_unit_kg",
    )
    if not math.isclose(
        quantity_per_box,
        inner_pack_qty,
        rel_tol=1e-9,
        abs_tol=1e-9,
    ):
        raise ValueError(
            "physical packaging quantity_per_box must match canonical inner_pack_qty"
        )
    if not math.isclose(
        quantity_per_box * boxes_per_pallet,
        full_pallet_qty,
        rel_tol=1e-9,
        abs_tol=1e-9,
    ):
        raise ValueError(
            "physical boxes_per_pallet must match canonical full_pallet_qty"
        )
    if not math.isclose(
        weight_per_box_kg / quantity_per_box,
        material_weight_per_unit_kg,
        rel_tol=1e-6,
        abs_tol=1e-9,
    ):
        raise ValueError(
            "physical box weight must match canonical material unit weight"
        )
    if not isinstance(row.get("service_minutes"), int) or row["service_minutes"] < 0:
        raise ValueError("district service_minutes must be a non-negative integer")
    window_start = row.get("time_window_start")
    window_end = row.get("time_window_end")
    if window_start is not None and not isinstance(window_start, time):
        raise ValueError("district time_window_start must be a time")
    if window_end is not None and not isinstance(window_end, time):
        raise ValueError("district time_window_end must be a time")
    if (
        isinstance(window_start, time)
        and isinstance(window_end, time)
        and window_end <= window_start
    ):
        raise ValueError("district time window must end after it starts")


def _validate_vehicle_capacity(
    row: dict[str, Any],
    origin_warehouse_id: str,
) -> None:
    if not _normalized_text(row.get("transport_vehicle_id")):
        raise ValueError("transport vehicle identity is required")
    if not _normalized_text(row.get("vehicle_id")):
        raise ValueError("explicit canonical vehicle mapping is required")
    if row.get("vehicle_mapping_status") != VERIFIED_MAPPING_STATUS:
        raise ValueError("vehicle mapping evidence must be verified")
    if row.get("canonical_warehouse_id") != origin_warehouse_id:
        raise ValueError("vehicle warehouse mapping does not match plan origin")
    if (
        row.get("canonical_home_warehouse_id") != origin_warehouse_id
        or row.get("canonical_home_location_active") is not True
        or row.get("canonical_vehicle_active") is not True
    ):
        raise ValueError(
            "canonical vehicle and home warehouse must be active at the exact plan origin"
        )
    if (
        not _normalized_text(row.get("vehicle_mapping_source_reference"))
        or not _valid_sha256(
            row.get("vehicle_mapping_source_checksum_sha256")
        )
        or not _positive_integer(row.get("vehicle_mapping_source_row_number"))
        or row.get("vehicle_mapping_verified_at") is None
        or row.get("vehicle_mapping_verified_by") is None
        or not _normalized_text(row.get("vehicle_mapping_approval_ticket"))
    ):
        raise ValueError(
            "vehicle mapping requires owner-approved source provenance"
        )
    _positive_finite(row.get("max_weight_kg"), "vehicle max_weight_kg")
    _positive_finite(row.get("max_volume_m3"), "vehicle max_volume_m3")
    _positive_finite(row.get("max_pallets"), "vehicle max_pallets")
    if row.get("capacity_evidence_status") != VERIFIED_CAPACITY_STATUS:
        raise ValueError("vehicle capacity evidence must be verified")
    if (
        not _normalized_text(row.get("capacity_source_reference"))
        or not _valid_sha256(row.get("capacity_source_checksum_sha256"))
        or not _positive_integer(row.get("capacity_source_row_number"))
        or row.get("capacity_verified_at") is None
        or row.get("capacity_verified_by") is None
        or not _normalized_text(row.get("capacity_verification_ticket"))
    ):
        raise ValueError(
            "vehicle capacity requires source, checksum, row, verification time and ticket"
        )
    if row.get("availability_evidence_status") != AVAILABLE_EVIDENCE_STATUS:
        raise ValueError("vehicle availability evidence must say available")
    checked_at = _aware_datetime(
        row.get("availability_checked_at"),
        "vehicle availability_checked_at",
    )
    expires_at = _aware_datetime(
        row.get("availability_expires_at"),
        "vehicle availability_expires_at",
    )
    current_time = datetime.now(timezone.utc)
    if checked_at > current_time or expires_at <= current_time:
        raise ValueError(
            "vehicle availability evidence must be current and non-expired"
        )
    if (
        expires_at <= checked_at
        or not _normalized_text(row.get("availability_source_reference"))
        or not _valid_sha256(
            row.get("availability_source_checksum_sha256")
        )
        or not _positive_integer(row.get("availability_source_row_number"))
        or row.get("availability_verified_by") is None
        or not _normalized_text(
            row.get("availability_verification_ticket")
        )
    ):
        raise ValueError(
            "vehicle availability requires source, checksum, row, validity window, verifier and ticket"
        )


def _validate_geocode_evidence(
    row: dict[str, Any],
    *,
    status_field: str,
    latitude_field: str,
    longitude_field: str,
    source_reference_field: str,
    source_checksum_field: str,
    source_row_field: str,
    verified_at_field: str,
    label: str,
) -> None:
    if row.get(status_field) != VERIFIED_GEOCODE_STATUS:
        raise ValueError(f"{label} geocode must be verified")
    _coordinate(row.get(latitude_field), row.get(longitude_field), label)
    if (
        not _normalized_text(row.get(source_reference_field))
        or not _valid_sha256(row.get(source_checksum_field))
        or not _positive_integer(row.get(source_row_field))
        or row.get(verified_at_field) is None
    ):
        raise ValueError(
            f"{label} geocode requires source, checksum, row and verification time"
        )


def _coordinate(latitude: object, longitude: object, label: str) -> None:
    lat = _finite_number(latitude, f"{label} latitude")
    lon = _finite_number(longitude, f"{label} longitude")
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError(f"{label} coordinate must be WGS84")


def _positive_finite(value: object, label: str) -> float:
    numeric = _finite_number(value, label)
    if numeric <= 0:
        raise ValueError(f"{label} must be positive")
    return numeric


def _finite_number(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite number")
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a finite number") from exc
    if not math.isfinite(numeric):
        raise ValueError(f"{label} must be a finite number")
    return numeric


def _positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _normalized_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def _aware_datetime(value: object, label: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError(f"{label} must be a timezone-aware timestamp")
    return value.astimezone(timezone.utc)


def _route_start_at(depot_row) -> datetime:
    plan_date = depot_row["week_start_date"]
    if not isinstance(plan_date, date):
        raise ValueError("replenishment plan week_start_date is required for route ETAs")
    return datetime.combine(plan_date, time.min, tzinfo=ROUTE_TIMEZONE)


def _positive_demand_rows(item_rows):
    positive_rows = []
    for row in item_rows:
        raw_quantity = row.get("quantity")
        if isinstance(raw_quantity, bool):
            raise ValueError("replenishment demand quantity must be a finite number")
        try:
            quantity = float(raw_quantity)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("replenishment demand quantity must be a finite number") from exc
        if not math.isfinite(quantity):
            raise ValueError("replenishment demand quantity must be a finite number")
        if quantity > 0:
            positive_rows.append(row)
    if not positive_rows:
        raise ValueError("locked replenishment plan has no positive demand")
    return positive_rows


def _routing_status_identity(
    status: RoutingEngineStatus,
) -> tuple[str, int, int | None, bool | None]:
    return (
        status.version,
        status.tileset_last_modified,
        status.osm_changeset,
        status.has_tiles,
    )


def _build_vehicle_road_evidence(
    matrix_adapter: ValhallaMatrixAdapter,
    depot: Coordinate,
    stops: list[DeliveryStop],
    result,
    matrix_status: RoutingEngineStatus,
) -> dict[str, RoadRouteEvidence]:
    stop_by_id = {stop.stop_id: stop for stop in stops}
    evidence_by_vehicle: dict[str, RoadRouteEvidence] = {}
    for route in result.routes:
        ordered_coordinates = [
            depot,
            *(
                stop_by_id[planned_stop.stop_id].coordinate
                for planned_stop in route.stops
            ),
            depot,
        ]
        evidence = matrix_adapter.build_route(ordered_coordinates)
        if (
            evidence.engine_name != "valhalla"
            or evidence.routing_profile != "truck"
            or evidence.engine_version != matrix_status.version
            or evidence.tileset_version != matrix_adapter.tileset_version
            or evidence.tileset_last_modified
            != matrix_status.tileset_last_modified
            or evidence.osm_changeset != matrix_status.osm_changeset
            or evidence.osm_changeset is None
            or evidence.engine_status_response_hash
            != matrix_status.response_hash
            or evidence.ordered_waypoint_count != len(ordered_coordinates)
        ):
            raise ValueError(
                "Valhalla road evidence does not match the verified matrix engine and ordered waypoints"
            )
        evidence_by_vehicle[route.vehicle_id] = evidence
    return evidence_by_vehicle


def _process_route(connection, route_job_id: UUID) -> dict[str, Any]:
    route_job = _lock_route_job(connection, route_job_id)
    existing_result = _load_existing_route_result(connection, route_job_id)
    if existing_result:
        return existing_result
    item_rows, depot_row, vehicle_rows = _load_route_inputs(connection, route_job)
    _validate_route_inputs(item_rows, depot_row, vehicle_rows)
    item_rows = _positive_demand_rows(item_rows)

    grouped: dict[str, dict[str, Any]] = {}
    for row in item_rows:
        item_id = row["replenishment_item_id"]
        data = grouped.setdefault(
            row["district_id"],
            {
                "items": [],
                "weight": 0.0,
                "volume": 0.0,
                "pallets": 0.0,
                **row,
            },
        )
        boxes = math.ceil(float(row["quantity"]) / float(row["quantity_per_box"]))
        data["weight"] += boxes * float(row["weight_per_box_kg"])
        data["volume"] += boxes * float(row["box_volume_m3"])
        data["pallets"] += math.ceil(
            float(row["quantity"]) / float(row["full_pallet_qty"])
        )
        data["priority_score"] = max(
            float(data["priority_score"]),
            float(row["priority_score"]),
        )
        data["items"].append(item_id)

    depot = Coordinate(float(depot_row["latitude"]), float(depot_row["longitude"]))
    stop_data = list(grouped.values())
    stops = [
        DeliveryStop(
            data["district_id"], Coordinate(float(data["latitude"]), float(data["longitude"])),
            data["weight"], data["volume"], data["pallets"], data["service_minutes"],
            _time_to_minute(data["time_window_start"], 0),
            _time_to_minute(data["time_window_end"], 24 * 60 - 1),
            float(data["priority_score"]),
        )
        for data in stop_data
    ]
    vehicles = [
        Vehicle(
            row["vehicle_id"],
            float(row["max_weight_kg"]),
            float(row["max_volume_m3"]),
            float(row["max_pallets"]),
        )
        for row in vehicle_rows
    ]
    optimizer = OrToolsOptimizer(time_limit_seconds=route_job["timeout_seconds"])
    coordinates = [depot, *(stop.coordinate for stop in stops)]
    if route_job["matrix_source"] != "valhalla":
        raise ValueError(
            "production route worker accepts only Valhalla matrix jobs"
        )
    matrix_adapter = _route_adapter_from_environment()
    tileset_version = matrix_adapter.tileset_version
    matrix_status_before = matrix_adapter.status()
    if matrix_status_before.osm_changeset is None:
        raise ValueError(
            "Valhalla status must expose the immutable OSM changeset"
        )
    matrix = matrix_adapter.build(coordinates)
    matrix_status = matrix_adapter.status()
    if _routing_status_identity(
        matrix_status_before
    ) != _routing_status_identity(matrix_status):
        raise ValueError(
            "Valhalla engine or tileset changed while building the matrix"
        )
    result = optimizer.solve(depot, stops, vehicles, matrix)
    road_evidence = _build_vehicle_road_evidence(
        matrix_adapter,
        depot,
        stops,
        result,
        matrix_status,
    )
    matrix_captured_at = datetime.now(timezone.utc)
    route_start_at = _route_start_at(depot_row)
    matrix_payload = {
        "locations": [
            [point.latitude, point.longitude]
            for point in coordinates
        ],
        "distances": matrix.distances_m,
        "durations": matrix.durations_s,
        "source": matrix.source,
        "tileset_version": tileset_version,
        "engine_version": matrix_status.version,
        "tileset_last_modified": matrix_status.tileset_last_modified,
        "osm_changeset": matrix_status.osm_changeset,
        "engine_status_response_hash": matrix_status.response_hash,
        "upstream_request_hash": matrix.request_hash,
        "upstream_response_hash": matrix.response_hash,
    }
    request_hash = hashlib.sha256(json.dumps(matrix_payload, sort_keys=True).encode()).hexdigest()

    with connection.cursor() as cursor:
        cursor.execute(
            """
            with inserted as (
              insert into analytics.route_matrices (
                matrix_source,
                location_ids,
                distances_m,
                durations_s,
                request_hash,
                evidence_status,
                engine_name,
                engine_version,
                routing_profile,
                tileset_version,
                tileset_last_modified_at,
                osm_changeset,
                engine_status_response_sha256,
                upstream_request_sha256,
                upstream_response_sha256,
                evidence_captured_at
              )
              values (
                %s,%s,%s::jsonb,%s::jsonb,%s,
                'verified','valhalla',%s,'truck',%s,%s,%s,%s,%s,%s,%s
              )
              on conflict (request_hash) do nothing
              returning route_matrix_id
            )
            select route_matrix_id from inserted
            union all
            select route_matrix_id
            from analytics.route_matrices
            where request_hash=%s
              and evidence_status='verified'
              and matrix_source='valhalla'
              and engine_name='valhalla'
              and engine_version=%s
              and routing_profile='truck'
              and tileset_version=%s
              and tileset_last_modified_at=%s
              and osm_changeset=%s
              and engine_status_response_sha256=%s
              and upstream_request_sha256=%s
              and upstream_response_sha256=%s
              and not exists (select 1 from inserted)
            limit 1
            """,
            (
                matrix.source,
                [
                    depot_row["origin_location_id"],
                    *(f"DIST-{stop.stop_id}" for stop in stops),
                ],
                json.dumps(matrix.distances_m),
                json.dumps(matrix.durations_s),
                request_hash,
                matrix_status.version,
                tileset_version,
                datetime.fromtimestamp(
                    matrix_status.tileset_last_modified,
                    tz=timezone.utc,
                ),
                matrix_status.osm_changeset,
                matrix_status.response_hash,
                matrix.request_hash,
                matrix.response_hash,
                matrix_captured_at,
                request_hash,
                matrix_status.version,
                tileset_version,
                datetime.fromtimestamp(
                    matrix_status.tileset_last_modified,
                    tz=timezone.utc,
                ),
                matrix_status.osm_changeset,
                matrix_status.response_hash,
                matrix.request_hash,
                matrix.response_hash,
            ),
        )
        matrix_row = cursor.fetchone()
        if not matrix_row:
            raise ValueError(
                "conflicting unverified route matrix evidence already exists"
            )
        matrix_id = matrix_row["route_matrix_id"]
        served_count = sum(len(route.stops) for route in result.routes)
        unserved_count = len(result.unserved_stop_ids)
        total_road_distance_m = sum(
            road_evidence[route.vehicle_id].distance_m
            for route in result.routes
        )
        total_road_duration_s = sum(
            road_evidence[route.vehicle_id].duration_s
            for route in result.routes
        )
        cursor.execute(
            """
            insert into core.route_plans (
              route_job_id, route_matrix_id, algorithm_version, solver_status,
              total_distance_m, total_duration_s, served_stop_count, unserved_stop_count
            ) values (%s,%s,%s,%s,%s,%s,%s,%s) returning route_plan_id
            """,
            (route_job_id, matrix_id, route_job["algorithm_version"], "partial" if unserved_count else result.solver_status,
             total_road_distance_m, total_road_duration_s, served_count, unserved_count),
        )
        route_plan_id = cursor.fetchone()["route_plan_id"]
        data_by_id = {data["district_id"]: data for data in stop_data}
        vehicle_by_id = {vehicle.vehicle_id: vehicle for vehicle in vehicles}
        vehicle_row_by_id = {
            row["vehicle_id"]: row
            for row in vehicle_rows
        }
        for route_sequence, route in enumerate(result.routes, start=1):
            vehicle = vehicle_by_id[route.vehicle_id]
            vehicle_row = vehicle_row_by_id[route.vehicle_id]
            evidence = road_evidence[route.vehicle_id]
            cursor.execute(
                """
                insert into core.route_plan_vehicles (
                  route_plan_id, vehicle_id, route_sequence, planned_distance_m, planned_duration_s,
                  weight_kg, volume_m3, pallets, weight_utilization, volume_utilization, pallet_utilization
                ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning route_plan_vehicle_id
                """,
                (route_plan_id, route.vehicle_id, route_sequence, evidence.distance_m, evidence.duration_s,
                 route.weight_kg, route.volume_m3, route.pallets, route.weight_kg / vehicle.max_weight_kg,
                 route.volume_m3 / vehicle.max_volume_m3, route.pallets / vehicle.max_pallets),
            )
            route_vehicle_id = cursor.fetchone()["route_plan_vehicle_id"]
            cursor.execute(
                """
                insert into core.route_plan_vehicle_road_evidence (
                  route_plan_vehicle_id,
                  route_matrix_id,
                  transport_vehicle_id,
                  canonical_vehicle_id,
                  vehicle_mapping_source_checksum_sha256,
                  capacity_source_checksum_sha256,
                  availability_source_checksum_sha256,
                  availability_checked_at,
                  availability_expires_at,
                  geometry_geojson,
                  road_distance_m,
                  road_duration_s,
                  has_toll,
                  engine_name,
                  engine_version,
                  routing_profile,
                  tileset_version,
                  tileset_last_modified_at,
                  osm_changeset,
                  engine_status_response_sha256,
                  route_request_sha256,
                  route_response_sha256,
                  ordered_waypoint_ids,
                  ordered_waypoint_count,
                  evidence_validator_version
                ) values (
                  %s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,
                  %s,%s,%s,%s,%s,%s,%s,%s,%s,%s
                )
                """,
                (
                    route_vehicle_id,
                    matrix_id,
                    vehicle_row["transport_vehicle_id"],
                    route.vehicle_id,
                    vehicle_row[
                        "vehicle_mapping_source_checksum_sha256"
                    ],
                    vehicle_row["capacity_source_checksum_sha256"],
                    vehicle_row[
                        "availability_source_checksum_sha256"
                    ],
                    vehicle_row["availability_checked_at"],
                    vehicle_row["availability_expires_at"],
                    json.dumps(evidence.geometry_geojson),
                    evidence.distance_m,
                    evidence.duration_s,
                    evidence.has_toll,
                    evidence.engine_name,
                    evidence.engine_version,
                    evidence.routing_profile,
                    evidence.tileset_version,
                    datetime.fromtimestamp(
                        evidence.tileset_last_modified,
                        tz=timezone.utc,
                    ),
                    evidence.osm_changeset,
                    evidence.engine_status_response_hash,
                    evidence.request_hash,
                    evidence.response_hash,
                    [
                        depot_row["origin_location_id"],
                        *(
                            f"DIST-{planned_stop.stop_id}"
                            for planned_stop in route.stops
                        ),
                        depot_row["origin_location_id"],
                    ],
                    evidence.ordered_waypoint_count,
                    f"synapse-worker/{SERVICE_VERSION}:road-evidence-v1",
                ),
            )
            for planned_stop in route.stops:
                data = data_by_id[planned_stop.stop_id]
                cursor.execute(
                    """
                    insert into core.route_stops (
                      route_plan_vehicle_id, district_id, stop_sequence, eta, service_minutes,
                      weight_kg, volume_m3, pallets, replenishment_item_ids, latitude, longitude
                    ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (route_vehicle_id, planned_stop.stop_id, planned_stop.sequence,
                     route_start_at + timedelta(minutes=planned_stop.arrival_minute), data["service_minutes"],
                     data["weight"], data["volume"], data["pallets"], data["items"], data["latitude"], data["longitude"]),
                )
        for district_id in result.unserved_stop_ids:
            data = data_by_id[district_id]
            cursor.execute(
                "insert into core.route_unserved_stops (route_plan_id, district_id, reason_code, reason_detail, replenishment_item_ids) values (%s,%s,'infeasible','Solver dropped stop; inspect capacity, time-window and connectivity constraints',%s)",
                (route_plan_id, district_id, data["items"]),
            )
    return {"route_job_id": str(route_job_id), "route_plan_id": str(route_plan_id), "served_stops": served_count, "unserved_stops": unserved_count}
