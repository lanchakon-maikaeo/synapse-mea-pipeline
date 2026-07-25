# M13 — Transport / Route Dispatch Pipeline

Connects the Transport module to Supabase as a first-class, governed pipeline,
following the same conventions as m09/m10/m11 and the target architecture in
`SYNAPSE_Open_Source_Pipeline_Improvement.md` (§4 M08, §9 Route Optimization,
Deployment Profile A — Free PoC).

## Scope

Deterministic, worker-free route dispatch: reference masters + a route-leg matrix
+ transactional trips, served through one security-definer dispatcher. It does
**not** re-enable the excluded forecasting/OR-Tools `/v1/routes*` scope; it is a
separate, self-contained model that runs on free-tier Supabase with no external
routing service. The Valhalla time-distance matrix + OR-Tools VRP described in the
improvement plan remain the future upgrade path (Profile B — self-host).

## Migration

`supabase/migrations/202607250001_m13_transport_pipeline.sql` (additive, registered
as version `202607250001`, module `M13`).

Masters (schema `core`, RLS-locked, served only via the dispatcher):

- `core.transport_warehouses` — 3 depots (คลองเตย, บางพลี, เมืองใหม่)
- `core.transport_district_geo` — 19 nodes (WH + 18 destinations) with lat/lon and
  internal 850×520 SVG map coordinates
- `core.transport_vehicles` — 6-wheel fleet with driver, capacity and fuel rate
- `core.transport_route_legs` — 54 warehouse→district legs (distance, toll, time,
  unload params), the authoritative cost source

Transactional (schema `ops`):

- `ops.transport_trips` — planned/dispatched/completed/cancelled trips with server-
  computed totals, estimate vs. actual fuel, `created_by` and audit timestamps

Analytics views: `analytics.v_transport_vehicle_status`,
`analytics.v_transport_route_matrix`, `analytics.v_transport_trip_summary`.

RLS: all tables `enable row level security` and revoke direct access from
`public/anon/authenticated`; reads and writes flow only through the
`security definer` dispatcher (owner = postgres bypasses RLS), matching the m09
pattern. No business data is exposed to the browser except through the API.

## API — `/v1/transport/*`

Dispatcher `public.m13_transport_dispatch(text,text,jsonb,jsonb,text)`; the
dashboard same-origin API (`app/api/[...path]/route.ts`) routes any path under
`/v1/transport/` to it (alongside m09/m10/m11).

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/v1/transport/warehouses` | any | Active depots |
| GET | `/v1/transport/geo` | any | District/warehouse map nodes |
| GET | `/v1/transport/vehicles` | any | Active fleet |
| GET | `/v1/transport/route-matrix?warehouse=` | any | Route legs (optionally filtered) |
| GET | `/v1/transport/trips?limit=&status=` | any | Trip history |
| POST | `/v1/transport/trips` | admin/planner | Plan a trip; server computes totals from the route matrix and assigns a depot vehicle |
| POST | `/v1/transport/trips/{uuid}/status` | admin/planner | Update status / actual fuel / depart-return times |

Trip totals (distance, toll, minutes, fuel estimate) are computed **server-side**
from `core.transport_route_legs` and the vehicle's fuel rate — the browser cannot
fabricate cost figures.

## Frontend

`dashboard/app/transport.tsx` is API-first: on load it calls the four GET
endpoints; on any error (e.g. the migration is not deployed yet) it falls back to
the ported `transport-data.ts` masters so the module keeps working. A status
banner shows whether it is reading live Supabase data or the ported PoC set.
Planner saves POST to `/v1/transport/trips` and reload. Reached via the
คลังพัสดุ / ระบบขนส่ง module switcher in the sidebar.

## CI/CD

- Contract: `supabase/tests/m13_transport_verify.sql` (registered migration,
  tables, RLS, views, dispatcher grants, seed counts 3/19/6/54) is run by
  `scripts/test_supabase_migrations_local.sh` after the M24 verify.
- `supabase/tests/local_schema_contract_verify.sql` migration count updated
  27 → 28.
- Run locally / in CI: `make database-contract-local` (clean PostgreSQL 17 applies
  all migrations in filename order and runs every contract verify) and
  `cd dashboard && npm run verify` (lint + build + rendered/DB contract).

## Deploy (new-pipeline order)

1. Apply the migration to Supabase Production via the guarded script:
   ```bash
   export DATABASE_URL='postgresql://…@…:5432/postgres'
   export BACKUP_DIR='/approved/off-repository/location'
   export RELEASE_VERSION='transport-pipeline-m13'
   export RELEASE_GIT_SHA='<40-char-commit>'
   export DEPLOY_CONFIRM='APPLY_PENDING_MIGRATIONS'
   bash scripts/deploy_database_migrations.sh
   ```
2. Push `main`; Vercel builds `dashboard` and deploys.
3. Smoke: authenticated `GET /api/v1/transport/vehicles` returns the fleet; the
   Transport banner switches to “เชื่อมต่อ Supabase แล้ว”.
