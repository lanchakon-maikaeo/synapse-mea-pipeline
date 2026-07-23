# Wave 2 — Stock Health, Replenishment and API

**Project:** `test-synapse-mea` (`mklnbumfwojxhqscthjd`)  
**Environment:** Test  
**Implementation date:** 2026-07-15  
**Status:** M06 database deployed and accepted; M09 API deployed as same-origin serverless production runtime

## Delivered

### M06 — Stock Health and Replenishment

- Versioned calculation policy `v1.0.0`, anchored to `synapse/ALGORITHM.md`
- `core.usage_rates` for CMP, 4M, 6M and 12M usage by material and district
- `analytics.v_stock_health` for the latest district stock snapshot joined to the latest usage rate
- Tiered replenishment rounding: exact under 70, then 50 / 100 / 500 / 1,000
- 3.5-month trigger; proposed MIN uses 4M and suggested/MAX uses 6M
- Replenishment run, plan and item workflow with district confirmation and planner/admin approval
- Anti-hoarding guard: confirmed quantity cannot exceed the calculated maximum
- Immutable adjustment history with actor, reason, prior and new value
- RLS is enabled and anonymous access is blocked on all six M06 tables

M06 verification passed 6/6 checks in Supabase, including the regression cases: `55 → 55`, `83 → 100`, `350 → 400`, `1,300 → 1,500`, and `12,500 → 13,000`.

### M09 — API contract

The FastAPI service in `api/` provides a versioned contract for stock health and replenishment. It validates a Supabase Auth JWT, looks up the application role in `public.user_profiles`, scopes district users to their own district, and sets the database JWT context before approval functions execute.

The production implementation exposes the same contract at `/api` on the Vercel Dashboard origin. A native Next.js route validates request shape and forwards the caller's Supabase JWT to `public.m09_dispatch()`. The database function applies RBAC, district scope and a persistent 120 requests/minute user limit. FastAPI remains available for optional self-hosting, but production no longer depends on localhost.

| Endpoint | Access |
|---|---|
| `GET /health` | process health |
| `GET /v1/stock-health` | authenticated; district-scoped |
| `GET /v1/replenishment/queue` | authenticated; district-scoped |
| `POST /v1/replenishment/runs` | planner or admin |
| `POST /v1/replenishment/items/{item_id}/confirm` | matching district, planner or admin |
| `POST /v1/replenishment/plans/{plan_id}/approve` | planner or admin |

## Operational prerequisite

The CMP source is reachable and is suitable for loading `core.usage_rates`. The documented Stock Google Sheet export currently returns HTTP `401`, so no real `core.stock_snapshots` can be loaded yet. The database therefore correctly contains no fabricated stock-health or replenishment candidate rows.

To activate live recommendations, provide one of the following scoped inputs:

1. A read-only CSV export URL for the Stock sheet; or
2. A scheduled SAP stock CSV/XLSX export; or
3. A service account / account access route approved for the pipeline.

After stock and CMP batches are ingested, load `core.stock_snapshots` and `core.usage_rates`, then execute `core.create_replenishment_run()`. The returned run produces a traceable plan ready for district confirmation.

## Files

- `supabase/migrations/202607150004_m06_replenishment.sql`
- `supabase/tests/m06_replenishment_verify.sql`
- `supabase/rollbacks/202607150004_m06_replenishment_rollback.sql`
- `api/` — FastAPI service and environment template
