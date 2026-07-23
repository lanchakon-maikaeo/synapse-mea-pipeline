from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
import socket
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from .forecasting import forecast_best_available
from .routing import Coordinate, DeliveryStop, HaversineMatrixAdapter, OrToolsOptimizer, ValhallaMatrixAdapter, Vehicle


SERVICE_VERSION = "1.0.0"


def _heartbeat(connection, worker_id: str, status: str, **details: Any) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "select ops.record_service_heartbeat(%s,%s,%s,%s,%s::jsonb)",
            (f"synapse-worker:{worker_id}", worker_id, SERVICE_VERSION, status, json.dumps(details, default=str)),
        )
    connection.commit()


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
        _heartbeat(connection, worker_id, "healthy", hostname=socket.gethostname(), phase="polling")
        job = _claim(connection, worker_id)
        if not job:
            _heartbeat(connection, worker_id, "healthy", hostname=socket.gethostname(), phase="idle")
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
            _heartbeat(connection, worker_id, "healthy", hostname=socket.gethostname(), phase="completed", job_id=str(job["job_id"]))
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
            _heartbeat(connection, worker_id, "degraded", hostname=socket.gethostname(), phase="job_failed", job_id=str(job["job_id"]), error_type=type(exc).__name__)
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

    result_count = 0
    processed_series = 0
    with connection.cursor() as cursor:
        for (material_id, district_id), rows in series.items():
            history = [float(row["demand_quantity"]) for row in rows]
            if len(history) < 7:
                continue
            evaluations, selected, forecast_points = forecast_best_available(history, run["horizon_months"])
            model_versions = {"seasonal_naive": "seasonal-naive-v1", "moving_average": "moving-average-v1", "autoets": "autoets-v1"}
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
    connection.commit()
    return {"forecast_run_id": str(forecast_run_id), "series_count": processed_series, "result_count": result_count}


def _time_to_minute(value: time | None, default: int) -> int:
    return default if value is None else value.hour * 60 + value.minute


def _process_route(connection, route_job_id: UUID) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute("select * from ops.route_jobs where route_job_id=%s", (route_job_id,))
        route_job = cursor.fetchone()
        if not route_job:
            raise ValueError("route job not found")
        cursor.execute(
            """
            select i.replenishment_item_id, i.material_id, i.district_id,
                   coalesce(i.confirmed_qty, i.suggested_qty) as quantity,
                   p.quantity_per_box, p.box_volume_m3, p.weight_per_box_kg, p.boxes_per_pallet,
                   g.latitude, g.longitude, g.time_window_start, g.time_window_end, g.service_minutes
            from core.replenishment_items i
            left join core.material_packaging p using (material_id)
            left join core.location_geocodes g on g.location_id = 'DIST-' || i.district_id
            where i.replenishment_plan_id=%s and i.status in ('confirmed','approved')
            """,
            (route_job["replenishment_plan_id"],),
        )
        item_rows = cursor.fetchall()
        cursor.execute(
            """
            select g.latitude, g.longitude
            from core.replenishment_plans p
            join core.location_geocodes g on g.location_id=p.origin_location_id
            where p.replenishment_plan_id=%s
            """,
            (route_job["replenishment_plan_id"],),
        )
        depot_row = cursor.fetchone()
        cursor.execute(
            """
            select vehicle_id, max_weight_kg, max_volume_m3, max_pallets
            from core.vehicles where is_active and max_pallets is not null
            order by vehicle_id
            """
        )
        vehicle_rows = cursor.fetchall()
    if not depot_row:
        raise ValueError("verified warehouse geocode is required")
    if not item_rows:
        raise ValueError("approved replenishment plan has no confirmed or approved items")
    if not vehicle_rows:
        raise ValueError("at least one active vehicle with pallet capacity is required")

    grouped: dict[str, dict[str, Any]] = {}
    missing: dict[str, tuple[str, list[UUID]]] = {}
    for row in item_rows:
        item_id = row["replenishment_item_id"]
        if row["latitude"] is None:
            missing.setdefault(row["district_id"], ("missing_geocode", []))[1].append(item_id)
            continue
        if any(row[field] is None for field in ("quantity_per_box", "box_volume_m3", "weight_per_box_kg", "boxes_per_pallet")):
            missing.setdefault(row["district_id"], ("missing_packaging", []))[1].append(item_id)
            continue
        data = grouped.setdefault(row["district_id"], {"items": [], "weight": 0.0, "volume": 0.0, "pallets": 0.0, **row})
        boxes = math.ceil(float(row["quantity"]) / float(row["quantity_per_box"]))
        data["weight"] += boxes * float(row["weight_per_box_kg"])
        data["volume"] += boxes * float(row["box_volume_m3"])
        data["pallets"] += math.ceil(boxes / float(row["boxes_per_pallet"]))
        data["items"].append(item_id)

    depot = Coordinate(float(depot_row["latitude"]), float(depot_row["longitude"]))
    stop_data = list(grouped.values())
    stops = [
        DeliveryStop(
            data["district_id"], Coordinate(float(data["latitude"]), float(data["longitude"])),
            data["weight"], data["volume"], data["pallets"], data["service_minutes"],
            _time_to_minute(data["time_window_start"], 0), _time_to_minute(data["time_window_end"], 24 * 60 - 1), 5,
        )
        for data in stop_data
    ]
    vehicles = [Vehicle(row["vehicle_id"], float(row["max_weight_kg"]), float(row["max_volume_m3"]), float(row["max_pallets"])) for row in vehicle_rows]
    coordinates = [depot, *(stop.coordinate for stop in stops)]
    if route_job["matrix_source"] == "valhalla":
        base_url = os.environ.get("VALHALLA_URL")
        if not base_url:
            raise ValueError("VALHALLA_URL is required for production matrix jobs")
        matrix = ValhallaMatrixAdapter(base_url).build(coordinates)
    else:
        if os.environ.get("ALLOW_HAVERSINE_FALLBACK") != "true":
            raise ValueError("Haversine matrix is allowed only when ALLOW_HAVERSINE_FALLBACK=true")
        matrix = HaversineMatrixAdapter().build(coordinates)
    optimizer = OrToolsOptimizer(time_limit_seconds=route_job["timeout_seconds"])
    result = optimizer.solve(depot, stops, vehicles, matrix)
    matrix_payload = {"locations": [[point.latitude, point.longitude] for point in coordinates], "distances": matrix.distances_m, "durations": matrix.durations_s}
    request_hash = hashlib.sha256(json.dumps(matrix_payload, sort_keys=True).encode()).hexdigest()

    with connection.cursor() as cursor:
        cursor.execute(
            """
            insert into analytics.route_matrices (matrix_source, location_ids, distances_m, durations_s, request_hash)
            values (%s,%s,%s::jsonb,%s::jsonb,%s)
            on conflict (request_hash) do update set generated_at=now()
            returning route_matrix_id
            """,
            ("haversine-test" if matrix.source == "haversine" else matrix.source, ["WH", *(stop.stop_id for stop in stops)], json.dumps(matrix.distances_m), json.dumps(matrix.durations_s), request_hash),
        )
        matrix_id = cursor.fetchone()["route_matrix_id"]
        served_count = sum(len(route.stops) for route in result.routes)
        unserved_count = len(result.unserved_stop_ids) + len(missing)
        cursor.execute(
            """
            insert into core.route_plans (
              route_job_id, route_matrix_id, algorithm_version, solver_status,
              total_distance_m, total_duration_s, served_stop_count, unserved_stop_count
            ) values (%s,%s,%s,%s,%s,%s,%s,%s) returning route_plan_id
            """,
            (route_job_id, matrix_id, route_job["algorithm_version"], "partial" if unserved_count else result.solver_status,
             sum(route.distance_m for route in result.routes), sum(route.duration_s for route in result.routes), served_count, unserved_count),
        )
        route_plan_id = cursor.fetchone()["route_plan_id"]
        data_by_id = {data["district_id"]: data for data in stop_data}
        vehicle_by_id = {vehicle.vehicle_id: vehicle for vehicle in vehicles}
        for route_sequence, route in enumerate(result.routes, start=1):
            vehicle = vehicle_by_id[route.vehicle_id]
            cursor.execute(
                """
                insert into core.route_plan_vehicles (
                  route_plan_id, vehicle_id, route_sequence, planned_distance_m, planned_duration_s,
                  weight_kg, volume_m3, pallets, weight_utilization, volume_utilization, pallet_utilization
                ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning route_plan_vehicle_id
                """,
                (route_plan_id, route.vehicle_id, route_sequence, route.distance_m, route.duration_s,
                 route.weight_kg, route.volume_m3, route.pallets, route.weight_kg / vehicle.max_weight_kg,
                 route.volume_m3 / vehicle.max_volume_m3, route.pallets / vehicle.max_pallets),
            )
            route_vehicle_id = cursor.fetchone()["route_plan_vehicle_id"]
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
                     datetime.now(timezone.utc) + timedelta(minutes=planned_stop.arrival_minute), data["service_minutes"],
                     data["weight"], data["volume"], data["pallets"], data["items"], data["latitude"], data["longitude"]),
                )
        for district_id, (reason, item_ids) in missing.items():
            cursor.execute(
                "insert into core.route_unserved_stops (route_plan_id, district_id, reason_code, reason_detail, replenishment_item_ids) values (%s,%s,%s,%s,%s)",
                (route_plan_id, district_id, reason, reason.replace("_", " "), item_ids),
            )
        for district_id in result.unserved_stop_ids:
            data = data_by_id[district_id]
            cursor.execute(
                "insert into core.route_unserved_stops (route_plan_id, district_id, reason_code, reason_detail, replenishment_item_ids) values (%s,%s,'capacity','Solver dropped stop due to capacity/time constraints',%s)",
                (route_plan_id, district_id, data["items"]),
            )
    connection.commit()
    return {"route_job_id": str(route_job_id), "route_plan_id": str(route_plan_id), "served_stops": served_count, "unserved_stops": unserved_count}
