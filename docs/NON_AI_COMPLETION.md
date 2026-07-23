# SYNAPSE non-AI completion record

Release: `1.0.0-non-ai`  
Scope: all planned modules except Wave 4 / M11 AI  
Environment: Supabase project `test-synapse-mea` plus reproducible self-host runtime

Public dashboard shell and authenticated same-origin M09/M10 API: <https://mea-synapse-staging.vercel.app> (canonical source `dashboard/` in `lanchakon-maikaeo/synapse-mea-pipeline`; Vercel deployment mirror `lanchakon-maikaeo/synapse-mea-dashboard`; Vercel project `synapse-mea/mea-synapse-staging`)

## Delivered modules

| Module | Outcome | Evidence |
|---|---|---|
| M01 Foundation | Schemas, roles, profiles, audit, migration register | `202607140001_m01_foundation.sql` |
| M02 Pipeline core | Local/HTTP/SFTP/S3-compatible connectors plus governed Web input, checksum and idempotency | `pipeline/` tests and migration 010 |
| M03 Raw ingestion | Immutable source batches, rows, rejects and lineage | `202607150001_m03_raw_ingestion.sql` |
| M04 Staging and quality | Typed staging, validation issues and quality summary | `202607150002_m04_staging_quality.sql` |
| M05 Core VMI | Contract/material/location/stock/CMP model and lineage | `202607150003_m05_core_model.sql` |
| M06 Replenishment | Deterministic min/max calculation, district confirmation and approval; Web input can supply real stock/CMP and trigger a run | Wave 2 SQL/API tests and migration 010 |
| M07 Forecast | Baselines, AutoETS comparison, backtests, intervals and drift records; Web input supplies monthly-demand-v1 | Intelligence tests, Wave 3 SQL tests and migration 010 |
| M08 Route | OR-Tools capacity/time-window optimization, Valhalla adapter and approval | Intelligence tests and Wave 3 SQL tests |
| M09 API | 29 documented paths, JWT roles, district scope, rate/body limits, real Supabase reference/context endpoints and governed write actions | `api/openapi.json`, serverless OpenAPI, API tests and production acceptance |
| M10 Dashboard | Role-based Thai dashboard, Supabase master selectors, governed VMI publish/replenishment/forecast/route actions, uncertainty chart and MapLibre | native Next build, orchestration/render/database-contract tests and Vercel production |
| M12 Operations | Heartbeats, alerts, backup/restore evidence, Compose, Prometheus and CI | migration 008, scripts and runbook |
| M11 AI | Intentionally excluded by user scope | No implementation or fabricated AI result |

## Acceptance results

- Wave 1 database acceptance: **21/21 passed**.
- Wave 3 database acceptance: **12/12 passed**.
- Non-AI aggregate database acceptance: **15/15 passed**.
- M10 Web-input database acceptance: **10/10 passed**.
- API/Pipeline/Intelligence tests: **31/31 passed**.
- Dashboard validation/orchestration/render/database-contract tests: **15/15 passed**.
- Clean PostgreSQL migration/schema contract: **15/15 migrations applied; 29/29 schema, RLS and dispatcher privilege checks passed**.
- Authenticated database dispatcher workflow: **17/17 passed** across VMI lineage, idempotency, replenishment confirmation/approval, forecast and Valhalla route queues and RBAC denial.
- Real worker execution contract: **10/10 passed** across job claiming, forecast results/backtests, route optimization persistence, heartbeat and route review.
- Docker API, worker and pipeline images build as non-root; both CLIs start successfully and the API container passes process health while correctly failing readiness without a database.
- No fictional stock, forecast or route business records were inserted to make readiness appear green.

The 15/15, 29/29, 17/17 and 10/10 checks run from `make ci` against an isolated
PostgreSQL 17 container and the real non-root worker image. The fixtures exist
only for the lifetime of that disposable container. They validate migration
portability, security, orchestration and worker execution without altering
managed business data. The historical managed-Test data acceptance totals
above still require an authorized live Supabase session to rerun.

## Operational boundary

The Supabase database is deployed in the named test project. M09/M10 is deployed on Vercel as a same-origin serverless API under `/api`, using the caller's Supabase JWT and security-definer gateways with explicit RBAC, district scope and persistent rate limiting. The Web App reads governed material and district masters from Supabase. Admin/planner submissions flow through Raw and Staging into stock snapshots, monthly demand features and usage rates with source lineage and idempotency; no business record is created until an authorized user supplies actual observations and a source note. No service-role or database credential is shipped to the browser or Vercel runtime. The FastAPI/Docker runtime remains available as an optional self-host alternative, while M07/M08 stay fail-closed until their real-data readiness conditions are met.
