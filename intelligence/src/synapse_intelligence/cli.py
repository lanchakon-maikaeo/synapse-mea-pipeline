from __future__ import annotations

import argparse
from datetime import date
import json
import os
import time

import psycopg

from .forecasting import forecast_best_baseline
from .scheduler import refresh_drift, schedule_forecast
from .worker import run_once


def _poll_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "poll seconds must be a number"
        ) from exc
    if not 1 <= seconds <= 3600:
        raise argparse.ArgumentTypeError(
            "poll seconds must be between 1 and 3600"
        )
    return seconds


def _emit(command: str, result: object) -> None:
    payload = (
        result
        if isinstance(result, dict)
        else {"result": result}
    )
    print(
        json.dumps(
            {
                "event": "synapse_intelligence",
                "command": command,
                **payload,
            },
            default=str,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="synapse-intelligence")
    subparsers = parser.add_subparsers(dest="command", required=True)
    forecast = subparsers.add_parser("forecast-baseline")
    forecast.add_argument("--history", required=True, help="Comma-separated monthly demand")
    forecast.add_argument("--horizon", type=int, default=3)
    worker = subparsers.add_parser("worker-once")
    worker.add_argument("--worker-id", default="local-worker")
    daemon = subparsers.add_parser("worker")
    daemon.add_argument(
        "--worker-id",
        default=os.environ.get("WORKER_ID", "synapse-worker"),
    )
    daemon.add_argument(
        "--poll-seconds",
        type=_poll_seconds,
        default=os.environ.get("WORKER_POLL_SECONDS", "30"),
    )
    scheduler = subparsers.add_parser("schedule-forecast")
    scheduler.add_argument("--training-end", type=date.fromisoformat)
    scheduler.add_argument("--horizon", type=int, default=3)
    subparsers.add_parser("refresh-drift")
    alerts = subparsers.add_parser("refresh-alerts")
    alerts.add_argument("--stale-hours", type=int, default=26)
    args = parser.parse_args(argv)
    if args.command in (
        "worker",
        "worker-once",
        "schedule-forecast",
        "refresh-drift",
        "refresh-alerts",
    ):
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL is required")
        if args.command == "worker":
            try:
                while True:
                    _emit(
                        args.command,
                        run_once(database_url, worker_id=args.worker_id),
                    )
                    time.sleep(args.poll_seconds)
            except KeyboardInterrupt:
                return 0
        elif args.command == "worker-once":
            result = run_once(database_url, worker_id=args.worker_id)
        elif args.command == "schedule-forecast":
            result = schedule_forecast(database_url, training_end=args.training_end, horizon_months=args.horizon)
        elif args.command == "refresh-drift":
            result = refresh_drift(database_url)
        else:
            with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
                cursor.execute("select ops.refresh_operational_alerts(%s)", (args.stale_hours,))
                result = {"status": "succeeded", "alerts_refreshed": cursor.fetchone()[0]}
        _emit(args.command, result)
        return 0
    history = [float(value) for value in args.history.split(",")]
    evaluation, points = forecast_best_baseline(history, args.horizon)
    print(json.dumps({"model": evaluation.model_name, "metrics": evaluation.metrics.__dict__, "forecast": [point.__dict__ for point in points]}, indent=2))
    return 0
