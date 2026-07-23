from __future__ import annotations

import argparse
from datetime import date
import json
import os

import psycopg

from .forecasting import forecast_best_baseline
from .scheduler import refresh_drift, schedule_forecast
from .worker import run_once


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="synapse-intelligence")
    subparsers = parser.add_subparsers(dest="command", required=True)
    forecast = subparsers.add_parser("forecast-baseline")
    forecast.add_argument("--history", required=True, help="Comma-separated monthly demand")
    forecast.add_argument("--horizon", type=int, default=3)
    worker = subparsers.add_parser("worker-once")
    worker.add_argument("--worker-id", default="local-worker")
    scheduler = subparsers.add_parser("schedule-forecast")
    scheduler.add_argument("--training-end", type=date.fromisoformat)
    scheduler.add_argument("--horizon", type=int, default=3)
    subparsers.add_parser("refresh-drift")
    alerts = subparsers.add_parser("refresh-alerts")
    alerts.add_argument("--stale-hours", type=int, default=26)
    args = parser.parse_args(argv)
    if args.command in ("worker-once", "schedule-forecast", "refresh-drift", "refresh-alerts"):
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL is required")
        if args.command == "worker-once":
            result = run_once(database_url, worker_id=args.worker_id)
        elif args.command == "schedule-forecast":
            result = schedule_forecast(database_url, training_end=args.training_end, horizon_months=args.horizon)
        elif args.command == "refresh-drift":
            result = refresh_drift(database_url)
        else:
            with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
                cursor.execute("select ops.refresh_operational_alerts(%s)", (args.stale_hours,))
                result = {"status": "succeeded", "alerts_refreshed": cursor.fetchone()[0]}
        print(json.dumps({"event": "synapse_intelligence", "command": args.command, **result}, default=str, ensure_ascii=False, separators=(",", ":")))
        return 0
    history = [float(value) for value in args.history.split(",")]
    evaluation, points = forecast_best_baseline(history, args.horizon)
    print(json.dumps({"model": evaluation.model_name, "metrics": evaluation.metrics.__dict__, "forecast": [point.__dict__ for point in points]}, indent=2))
    return 0
