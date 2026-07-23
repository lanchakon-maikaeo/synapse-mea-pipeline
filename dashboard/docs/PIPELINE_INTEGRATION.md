# MEA Synapse — Vercel Staging ↔ Existing Pipeline

Status: deployed and connected

Frontend branch: `vercel-staging`

Deployment branch: `main`

Backend source of truth: existing Supabase pipeline and API dispatch functions

Canonical GitHub repository: `lanchakon-maikaeo/synapse-mea-pipeline`

Current Vercel deployment mirror: `lanchakon-maikaeo/synapse-mea-dashboard`

Vercel workspace/project: `synapse-mea/mea-synapse-staging`

Deployed URL: <https://mea-synapse-staging.vercel.app>

Last production verification: 2026-07-23

## Runtime topology

```text
Browser
  → Supabase Auth (publishable browser key)
  → /api/* on the same Vercel origin
  → m09_dispatch / m10_input_dispatch / m11_legacy_dispatch
  → existing Supabase schemas, views, RLS and audit functions
```

No service-role key or database credential is shipped to the browser.

## Live data contract

| Frontend area | Existing API |
|---|---|
| Identity and role scope | `GET /v1/me` |
| Contract evidence | `GET /v1/contracts` |
| Data quality | `GET /v1/data-quality` |
| Material and district masters | `GET /v1/reference/materials`, `GET /v1/reference/districts` |
| Warehouse and district stock | `GET /v1/warehouse-stock`, `GET /v1/stock-health` |
| Replenishment and adjustments | `GET /v1/replenishment/queue` |
| Governed VMI context and publish | `GET /v1/data-inputs/vmi/context`, `POST /v1/data-inputs/vmi` |
| Create and approve replenishment | `POST /v1/replenishment/runs`, `POST /v1/replenishment/plans/{plan_id}/approve` |
| District confirmation | `POST /v1/replenishment/items/{item_id}/confirm` |
| Forecast and monitoring | `GET /v1/forecasts/latest`, `GET /v1/forecasts/monitoring`, `POST /v1/forecasts/runs` |
| Job monitoring | `GET /v1/jobs`, `GET /v1/jobs/{job_id}` |
| Route orchestration | `POST /v1/routes/jobs`, `GET /v1/routes/plans`, `GET /v1/routes/plans/{route_plan_id}`, `POST /v1/routes/plans/{route_plan_id}/review` |
| Readiness and operations | `GET /v1/wave3/readiness`, `GET /v1/operations/health`, `GET /v1/operations/alerts` |
| Legacy source status | `GET /v1/data-sources/legacy/status` |

The client loads operational datasets and invokes the governed write endpoints
through the same-origin API. District access remains filtered by the backend;
the browser does not implement district security by hiding rows after download.

The Stock Update screen publishes 3–36 validated monthly observations with a
source note and can trigger replenishment. Planner/admin screens can approve
replenishment, queue forecasts, inspect background jobs, queue Valhalla route
optimization and review route plans. Production UI never offers the
`haversine-test` adapter.

Client validation mirrors the governed contract: it rejects duplicate/future
months, invalid stockout/lead-time values, future snapshots, invalid forecast
date order and non-integer horizons. Backend RBAC, readiness and database
constraints remain authoritative.

## `update-v1` Decision Intelligence screens

The three handoff screens are preserved in the new navigation:

- Quantity Suggestions uses live M06 policy evidence: Stock, CMP, Months
  Remaining, MIN/MAX, Suggested Quantity, Priority and confirmation state.
- Abnormal Request Review compares live Suggested and Confirmed quantities and
  displays the persisted District reason.
- Issue Traceback searches the Plan and Contract evidence available from the
  existing API.

The existing backend does not expose Quantity Recommendation statistics,
9-month special approval, FIFO Allocation, Handling Unit or Issue Movement
endpoints. Those sections therefore remain explicitly `DATA GATED`; the
frontend must not fabricate a recommendation, risk score or trace path.

## Environment configuration

The browser values are public Supabase project configuration:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_BASE_URL=
```

Leave `NEXT_PUBLIC_API_BASE_URL` blank to use `/api` on the same Vercel origin.
Never place `service_role`, database URLs or private credentials in a
`NEXT_PUBLIC_*` variable.

## Delivery pipeline

The canonical source is tracked under `dashboard/` on the monorepo `main`
branch. The existing dashboard repository remains the Vercel-connected mirror
until the project integration is changed to the monorepo with Root Directory
set to `dashboard`.

Every monorepo push or pull request runs the root `non-ai-ci` dashboard job.
The deployment mirror also retains its `Verify` workflow:

1. install the exact dependency graph with `npm ci`;
2. run ESLint;
3. build the Next.js application and test rendered output plus pipeline action orchestration;
4. type-check the application and database tooling;
5. validate the database contract tests.

Run the same checks locally with:

```bash
npm ci
npm run verify
npm audit --omit=dev
```

Run repeatable live smoke checks after Vercel reaches `READY`:

```bash
npm run smoke:deployment
```

This verifies the public shell, process/database health, unauthenticated denial
and all 29 OpenAPI paths. To add authenticated read-only checks without writing
business data, provide a temporary masked `SYNAPSE_ACCESS_TOKEN`. Override the
origin with `SMOKE_BASE_URL` for a Preview deployment.

Vercel deploys from `main` only after GitHub receives the commit. A successful
release must also pass these live checks:

```text
GET /                         → STAGING · SUPABASE AUTH
GET /api/health               → 200
GET /api/health/ready         → 200, database=ready
GET /api/v1/me (no token)     → 401
```

The Supabase Test database currently has 15 ordered migrations. Migration
`202607160013_m09_district_scope_status.sql` adds an explicit `403 forbidden`
response for cross-district replenishment confirmation and keeps the internal
dispatcher implementation callable only by `service_role`.

Use a GitHub-verified author email for deployment commits. Vercel rejects
commits whose author cannot be linked to an allowed GitHub account.

### Dependency baseline (2026-07-23)

- Production audit: 0 vulnerabilities (`npm audit --omit=dev`).
- Local verification: 15/15 Dashboard validation, orchestration, render and
  database-contract tests passed.
- The remaining development-only audit findings are 1 low and 4 moderate in
  Babel 7 and Drizzle Kit's deprecated esbuild loader chain.
- `npm audit fix --force` is intentionally not used because npm proposes a
  breaking Babel major upgrade or a Drizzle Kit downgrade. Reassess when those
  direct packages publish compatible releases.
