# SYNAPSE API — release 1.0.0-non-ai

FastAPI contract for contracts, data quality, stock health, replenishment, forecasting, route workflow and operations. It validates a Supabase Auth JWT, reads the application role from `public.user_profiles`, and propagates the user ID to PostgreSQL so approval functions retain actor attribution.

Production uses the same 29-path contract through the Dashboard's same-origin `/api` serverless route. The FastAPI application in this directory remains the open-source self-host/container alternative and the canonical Python contract reference; localhost is not required for the deployed Dashboard.

## Endpoints

| Method | Endpoint | Roles |
|---|---|---|
| `GET` | `/health` | public process health only |
| `GET` | `/health/ready` | public database readiness only |
| `GET` | `/v1/me` | authenticated identity and application scope |
| `GET` | `/v1/contracts` | admin, planner, viewer |
| `GET` | `/v1/data-quality` | admin, planner, viewer |
| `GET` | `/v1/reference/materials` | authenticated; real Supabase material master |
| `GET` | `/v1/warehouse-stock` | authenticated; latest actual warehouse snapshot |
| `GET` | `/v1/data-sources/legacy/status` | authenticated; source lineage, counts and readiness warnings |
| `POST` | `/v1/admin/import/legacy` | admin; governed idempotent import chunks |
| `GET` | `/v1/reference/districts` | authenticated; district scope is filtered |
| `GET` | `/v1/data-inputs/vmi` | authenticated; district scope is filtered |
| `GET` | `/v1/data-inputs/vmi/context` | authenticated; loads latest stock, usage and monthly history |
| `POST` | `/v1/data-inputs/vmi` | admin, planner; validates and publishes governed operational input |
| `GET` | `/v1/stock-health` | authenticated; district scope is filtered |
| `GET` | `/v1/replenishment/queue` | authenticated; district scope is filtered |
| `POST` | `/v1/replenishment/runs` | admin, planner |
| `POST` | `/v1/replenishment/items/{item_id}/confirm` | matching district, planner, admin |
| `POST` | `/v1/replenishment/plans/{plan_id}/approve` | admin, planner |
| `GET` | `/v1/forecasts/latest` | authenticated; district scope is filtered |
| `GET` | `/v1/forecasts/monitoring` | admin, planner, viewer |
| `POST` | `/v1/forecasts/runs` | admin, planner |
| `GET` | `/v1/jobs/{job_id}` | admin, planner, viewer |
| `GET` | `/v1/jobs` | admin, planner, viewer |
| `POST` | `/v1/routes/jobs` | admin, planner |
| `GET` | `/v1/routes/plans` | admin, planner, viewer |
| `GET` | `/v1/routes/plans/{route_plan_id}` | admin, planner, viewer |
| `POST` | `/v1/routes/plans/{route_plan_id}/review` | admin, planner |
| `GET` | `/v1/wave3/readiness` | admin, planner, viewer |
| `GET` | `/v1/operations/health` | admin, planner, viewer |
| `GET` | `/v1/operations/alerts` | admin, planner |

The generated contract is committed at `api/openapi.json`. Refresh it with `python api/scripts/export_openapi.py`; CI fails when it is stale.

Forecast and route queue endpoints return HTTP `409` when verified history/master data is not operationally ready. They do not create empty or fictional plans.

The VMI input endpoint writes one idempotent, auditable batch through Raw and Staging before updating stock snapshots, monthly demand features and CMP/usage rates. It can optionally trigger the existing deterministic M06 replenishment run. A source note is mandatory, and M07 readiness still requires at least 14 real monthly observations.

## Run locally

```bash
python -m pip install -e api
uvicorn synapse_api.main:app --reload
```

Use values outside the repository for `DATABASE_URL` and any legacy `SUPABASE_JWT_SECRET`. Configure `SUPABASE_URL` so asymmetric ES256/RS256 session tokens are verified from the project's cached JWKS and the issuer is checked. Legacy HS256 remains supported during migration. Configure the dashboard origin explicitly in `API_CORS_ORIGINS`; the default is an empty allowlist.

The Compose runtime in the repository runs the service as a non-root user, adds process/readiness health checks and emits one-line JSON request logs with request IDs. `/metrics` requires `METRICS_TOKEN` through either `X-Metrics-Token` or a bearer token.
