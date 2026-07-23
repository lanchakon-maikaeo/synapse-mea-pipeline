from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row


def previous_month_end(today: date | None = None) -> date:
    value = today or date.today()
    return value.replace(day=1) - timedelta(days=1)


def schedule_forecast(
    database_url: str,
    *,
    training_end: date | None = None,
    horizon_months: int = 3,
) -> dict[str, Any]:
    """Idempotently queue the monthly forecast for a service-account scheduler."""
    if not 1 <= horizon_months <= 24:
        raise ValueError("horizon_months must be between 1 and 24")
    cutoff = training_end or previous_month_end()
    with psycopg.connect(database_url, row_factory=dict_row) as connection, connection.cursor() as cursor:
        cursor.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"synapse-forecast:{cutoff.isoformat()}",))
        cursor.execute(
            """
            select forecast_run_id, job_id, status
            from analytics.forecast_runs
            where training_end=%s and horizon_months=%s
              and status in ('queued','running','succeeded')
            order by created_at desc limit 1
            """,
            (cutoff, horizon_months),
        )
        existing = cursor.fetchone()
        if existing:
            return {"created": False, **existing}
        cursor.execute(
            "insert into ops.background_jobs (job_type, payload) values ('forecast','{}'::jsonb) returning job_id"
        )
        job_id: UUID = cursor.fetchone()["job_id"]
        cursor.execute(
            """
            insert into analytics.forecast_runs (job_id, training_end, horizon_months)
            values (%s,%s,%s) returning forecast_run_id, status
            """,
            (job_id, cutoff, horizon_months),
        )
        run = cursor.fetchone()
        cursor.execute(
            "update ops.background_jobs set payload=jsonb_build_object('forecast_run_id',%s::uuid) where job_id=%s",
            (run["forecast_run_id"], job_id),
        )
    return {"created": True, "job_id": job_id, **run}


def refresh_drift(database_url: str) -> dict[str, int]:
    with psycopg.connect(database_url, row_factory=dict_row) as connection, connection.cursor() as cursor:
        cursor.execute("select analytics.refresh_forecast_drift_events() as inserted_events")
        return dict(cursor.fetchone())
