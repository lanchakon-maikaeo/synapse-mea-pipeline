# SYNAPSE Intelligence — Wave 3

Open-source workers for M07 demand forecasting and M08 route optimization.

## Forecasting

- Seasonal Naive and recursive Moving Average baselines
- Nixtla StatsForecast AutoETS candidate for series with sufficient history
- Rolling-origin backtest and automatic model selection by WAPE, then MAE/Bias
- WAPE, MAE, Bias and MASE metrics
- 80% empirical prediction interval for baselines and native 80% AutoETS interval
- Baselines remain deterministic and dependency-light for a transparent model comparison

### Intermittent-demand models (candidate, activation-gated)

Spare-parts / slow-moving materials have many zero months, where seasonal and
moving-average models are biased. `forecasting.py` adds the standard family:

- `classify_demand()` — ADI × CV² Syntetos-Boylan-Croston classification
  (`smooth` / `erratic` / `intermittent` / `lumpy`)
- Croston, SBA and TSB rate estimators (TSB decays toward zero on obsolescence)
  and ADIDA temporal aggregation
- `forecast_intermittent()` — MASE-ranked selection that keeps the baselines in
  the candidate pool

These are gated: `forecast_best_available(..., allow_intermittent=True)` (worker
env `SYNAPSE_INTERMITTENT_FORECAST=1`) is used only after the model versions are
registered — see `supabase/candidate/` and `docs/RESEARCH_DRIVEN_IMPROVEMENTS.md`.

### Hierarchical reconciliation (candidate, no database coupling)

`hierarchy.py` makes per-series forecasts coherent so district forecasts sum to
the material total the warehouse replenishes:

- `build_hierarchy()` / `summing_matrix()` — aggregate → leaf structure
- `reconcile_bottom_up()` — coherent by construction
- `reconcile_min_trace()` — MinT projection (`ols` / `wls_struct`), optional
  `non_negative` clamping that stays coherent

Pure-Python (its own Gaussian-elimination solver), so no NumPy/SciPy dependency.

### Obsolescence / slow-mover risk (candidate, no database coupling)

`obsolescence.py` combines the TSB demand probability, the ADI×CV² category, the
trailing zero-demand streak and months of cover into a transparent
`ObsolescenceSignal` (`risk_score`, `risk_level`, and human-readable `reasons`),
extending the existing >6 / >9 months overstock rules.

### Two-echelon inventory (candidate, no database coupling)

`multi_echelon.py` reasons about the warehouse → district structure as a whole:

- `simulate_two_echelon()` — replays district demand under order-up-to policies
  at both levels and propagates warehouse shortfalls into district service,
  reporting per-district / system fill rate and on-hand at each level
- `size_two_echelon_policy()` — sizes districts from their own demand and the
  warehouse from pooled aggregate demand (a guaranteed-service starting point)

## Replenishment policy (candidate, no database coupling)

`replenishment.py` provides a statistical alternative to the fixed
`CMP×4` / `CMP×6` months-of-cover buffer:

- `safety_stock()` — `z(service level) × σ√protection`, with a local `normal_ppf`
- `periodic_policy()` — `(R, s, S)` order-up-to policy on the weekly cadence
- `simulate_periodic_review()` — inventory-aware backtest reporting achieved fill
  rate, cycle service level and average on-hand (also the MEIO building block)

### Route benchmark and second solver (candidate, solver-agnostic)

`route_benchmark.py` scores and compares route solutions on common metrics
(distance, duration, served/unserved, utilization, capacity feasibility) so the
OR-Tools plan can be benchmarked against another solver or the previous plan. It
is structurally typed — it consumes anything shaped like `OptimizationResult`, so
no solver needs to be installed to evaluate one.

`savings_solver.py` is a dependency-free Clarke-Wright savings CVRP solver
(`SavingsOptimizer.solve(depot, stops, vehicles, matrix)`) that emits the same
`OptimizationResult`, giving the benchmark a real second solver without pulling in
an external package. It optimises distance under capacity and does not enforce
time windows, so it is a comparison solver, not a dispatch plan.

### Declarative data quality (candidate, dependency-free)

`data_quality.py` provides a Great Expectations / Soda-style declarative
expectation suite (`not_null`, `unique`, `in_set`, `between`, `non_negative`,
`matches_regex`, `row_count_between`, `foreign_key`, `column_exists`) and
`run_suite()` → a JSON-serialisable `DataQualityReport` for data-contract
evidence — no external framework required.

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
