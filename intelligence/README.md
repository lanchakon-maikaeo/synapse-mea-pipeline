# SYNAPSE Intelligence — Wave 3

Open-source workers for M07 demand forecasting and M08 route optimization.

## Forecasting

- Seasonal Naive and recursive Moving Average baselines
- Nixtla StatsForecast AutoETS candidate for series with sufficient history
- Rolling-origin backtest and automatic model selection by WAPE, then MAE/Bias
- WAPE, MAE and Bias metrics
- 80% empirical prediction interval for baselines and native 80% AutoETS interval
- Baselines remain deterministic and dependency-light for a transparent model comparison

## Routing

- Valhalla `sources_to_targets` matrix adapter
- Haversine matrix fallback for development/tests only
- OR-Tools vehicle routing with weight, volume, pallet and time-window constraints
- Priority-weighted dropped-stop penalties, explicit unserved results and solver timeout
- Reproducible comparison with the former single-vehicle nearest-neighbour baseline
- No paid map API dependency

## Run tests

```bash
python -m pip install -e intelligence
python -m unittest discover -s intelligence/tests -v
```

The tests use deterministic synthetic demand and coordinates. They do not insert fictional operational records into Supabase.

## Background worker

```bash
DATABASE_URL=... synapse-intelligence worker-once --worker-id worker-01
```

For a long-running container, use the direct Python loop (no shell
interpolation):

```bash
DATABASE_URL=... WORKER_POLL_SECONDS=30 \
  synapse-intelligence worker --worker-id worker-01
```

The poll interval is validated between 1 and 3,600 seconds. The worker claims
one queued job with `FOR UPDATE SKIP LOCKED`, writes forecast or route results,
records success/failure with bounded retry, and persists a per-instance
operational heartbeat. Route jobs require `VALHALLA_URL`.
`ALLOW_HAVERSINE_FALLBACK=true` is accepted only for development/test jobs
explicitly queued with `haversine-test`.

Use the free Unix-cron template at `deploy/cron/synapse-intelligence.crontab.example` to run:

```bash
synapse-intelligence schedule-forecast --horizon 3
synapse-intelligence worker-once --worker-id cron-worker-01
synapse-intelligence refresh-drift
synapse-intelligence refresh-alerts --stale-hours 26
```

The monthly scheduler is idempotent and defaults to the previous calendar month end. Read `analytics.v_wave3_readiness` (or `GET /v1/wave3/readiness`) before operational runs; it never treats missing masters as ready.
