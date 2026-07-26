# SYNAPSE Production Operations v1

- Status: verified live baseline through migration `202607250005` (M13e),
  applied 26 July 2026
- Smart logistics status: M13–M13e schema and API are live; the Valhalla +
  OR-Tools worker is not deployed. Depot mappings and V707/V708 evidence are
  verified; route execution still fails closed pending the remaining fleet,
  routing services, locked plan, packaging and activation contract
- Business rules: frozen 22 July 2026
- Release scope: stock, replenishment, warehouse issue and traceability

This document describes the last verified live Production Operations v1
contract. Forecasting, route execution and RAG are not active. The M13–M13e
transport schema/API/UI are deployed, while the OSRM/Valhalla/OR-Tools runtime
remains a separate fail-closed candidate described in
`docs/M13_TRANSPORT_PIPELINE.md`.

## Runtime topology

```text
User browser
  -> Vercel Next.js dashboard
  -> same-origin /api route
  -> Supabase Auth JWT
  -> public.m09_dispatch()
  -> RLS-protected core / ops / analytics data
  -> append-only movement, approval and audit evidence
```

The Production web target is Vercel project `spaiss-6/synapse-mea`.
The Production database/Auth target is Supabase project `fvdfduuanfrncrwuareb`
(`synapse-01`, `ap-southeast-1`); Test/UAT
remains `mklnbumfwojxhqscthjd`.
The Production web target is `https://mea-synapse-production.vercel.app`.
Vercel deploys branch `main` from the canonical
`lanchakon-maikaeo/synapse-mea-pipeline` repository with Root Directory
`dashboard`.
`https://synapse-mea-dashboard.lanchakon0.chatgpt.site` is an independent
snapshot and is not part of this release pipeline.

## Operational capabilities

- Daily immutable stock and contract input; monthly immutable usage/CMP input.
- Khlong Toei warehouse scope is Plant `2401`, Storage Location `0001`.
- District missing stock is assumed zero and visibly marked source-missing.
- CMP is `ROUND(AVERAGE(LY, 12M, 6M, 4M), 0)`.
- Weekly governed replenishment with quantity evidence and abnormal review.
- District response -> Planner approval -> Academic approval -> Lock.
- Mandatory Academic note when any item exceeds nine months.
- Locked-plan cancellation/version history with reservation release.
- Receiving, `OPENING_UNKNOWN` reconciliation and Handling Unit inventory.
- Deterministic FIFO reservation: accepted date, PO, item/installment and source
  order, using an already-opened Handling Unit before opening the next.
- Append-only receipt, reserve, release, issue, return and quarantine movements.
- Separate ad-hoc issue workflow that does not mutate the weekly plan.
- Traceback from District issue to allocation, Handling Unit, lot, contract, PO
  item/installment and privacy-safe vendor alias.

## Roles

| Role | Production responsibility |
|---|---|
| `admin` | configuration, imports, supervised operational actions |
| `planner` | plan creation, change review, Planner approval, cancellation/versioning |
| `academic` | Academic approval and special approval note |
| `picker` | receipt, reconciliation, issue and return recording |
| `district` | district-scoped confirm/reject/change and ad-hoc request |
| `viewer` | read-only evidence and health views |

Authorization is enforced in `public.m09_dispatch`, database functions and RLS.
Frontend navigation is convenience only and is not a security boundary.

## Database release

The canonical Production rebuild migrations are:

`supabase/migrations/202607240017_production_rebuild_contract.sql`

`supabase/migrations/202607240018_relational_source_import.sql`

`supabase/migrations/202607240019_relation_coverage_fix.sql`

`supabase/migrations/202607240020_owner_attested_actual_promotion.sql`

`supabase/migrations/202607240021_actual_workbook_observation_lineage.sql`

`supabase/migrations/202607240022_production_completion_attestation.sql`

`supabase/migrations/202607240023_active_scope_readiness.sql`

`supabase/migrations/202607240024_single_admin_identity_policy.sql`

The live transport extension then adds:

`supabase/migrations/202607250001_m13_transport_pipeline.sql`

`supabase/migrations/202607250002_m13b_transport_replenishment_link.sql`

`supabase/migrations/202607250003_m13_transport_hardening.sql`

`supabase/migrations/202607250004_m13d_operational_integrity.sql`

`supabase/migrations/202607250005_m13e_route_evidence.sql`

They are additive, preserve historical data and register their own ordered
versions. The files under `dashboard/db/migrations` are a Drizzle design
contract for the standalone dashboard schema. Do not apply both migration
families to the same database.

Production is a separate greenfield project and is not cut over until
`analytics.v_production_readiness.cutover_ready` is true. Test remains the
rollback baseline.

Pre-release:

```bash
make workspace-ci
bash scripts/scan_secrets.sh
```

Apply the managed Supabase migrations only through the guarded script:

> Run this only from the exact approved release commit. Production is already at
> M13e; inspect the pending set with the guarded check before every future
> deployment and never apply an unapproved additive migration.

```bash
export DATABASE_URL='postgresql://...'
export BACKUP_DIR='/approved/off-repository/location'
export RELEASE_VERSION='production-operations-v1'
export RELEASE_GIT_SHA='<40-character-commit>'
export DEPLOYMENT_PROFILE='production'
export TARGET_PROJECT_REF='fvdfduuanfrncrwuareb'
export TARGET_REGION='ap-southeast-1'
export CHANGE_TICKET='<approved-change-ticket>'
export DEPLOY_CONFIRM='APPLY_PENDING_MIGRATIONS'
export PRODUCTION_DEPLOY_CONFIRM='DEPLOY_GREENFIELD_PRODUCTION'
export GREENFIELD_BOOTSTRAP_CONFIRM='INITIALIZE_EMPTY_DATABASE'
bash scripts/deploy_database_migrations.sh
```

The command creates a logical backup before applying pending migrations from
the checked-out release commit and
records backup/release evidence. Keep the backup outside the repository and run
a restore drill against a separate project before the production window.

## Web release

Set only public browser configuration in Vercel:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_BASE_URL=
```

Leave `NEXT_PUBLIC_API_BASE_URL` blank for the same-origin `/api` route. Never
add a database URL, JWT secret or `service_role` key to `NEXT_PUBLIC_*`.

Deploy a GitHub-verified commit from `main`, wait for Vercel `READY`, then run:

```bash
cd dashboard
SMOKE_BASE_URL='https://mea-synapse-production.vercel.app' \
SYNAPSE_ACCESS_TOKEN='<temporary-masked-token>' \
npm run smoke:deployment
```

The token is optional for public/unauthenticated checks and required for the
authenticated read-only checks. Delete/revoke a temporary token after evidence
is captured.

## Release acceptance

- Dashboard lint, type-check, production build and tests pass.
- Clean PostgreSQL applies all 32 migrations through M13e.
- All schema/RLS/privilege checks pass.
- All 20 authenticated operational workflow checks pass.
- Pre-cutover readiness returns `503 not_ready`; after authorized cutover it
  returns `200 ok`.
- Unauthenticated `/api/v1/me` returns `401`.
- All 48 documented same-origin OpenAPI paths respond through the
  deployed release.
- Governed `/v1/transport/*` paths enforce their readiness gates; legacy
  forecast, route/route-job, Wave 3 and RAG requests return `410 scope_excluded`.
- Backup and deployed release rows are present in operational evidence.

## Rollback and containment

1. Stop new governed writes by redeploying the previous verified application
   version or restricting ingress.
2. Preserve audit/movement evidence; never drop production workflow tables as
   an automated rollback.
3. If the schema/data must be reverted, restore the verified pre-release
   logical backup into a separate project, validate it, then switch the
   application only after approval.
4. Prefer a reviewed forward-fix when already-recorded production movements or
   approvals must be preserved.
5. Record the failed/rolled-back release and operator reason.

## Explicit exclusions and inactive runtime

The verified M13e deployment excludes forecasting, live route optimization,
route-plan→trip activation, background intelligence jobs, Wave 3 and RAG. The
governed `/v1/transport/*` read/preflight/job contract is deployed, while legacy
route/job namespaces return `410 scope_excluded`. No OSRM/Valhalla service,
OR-Tools worker, forecast scheduler or document/RAG indexer is included in the
deployed Vercel command.

## Deployed M13 contract and inactive routing runtime

The deployed API contract is version `1.3.0` with 48 paths and adds governed
`/v1/transport/*` reads, exact-plan preflight and a bounded real-road preview.
Its published OpenAPI also includes the M13e Valhalla-only exact locked-plan
optimization-job queue and owner/admin status read.
Legacy `/v1/routes*` and `/v1/jobs*` remain excluded. M13e can persist immutable
per-vehicle Valhalla road evidence for the operational solver, but direct
`POST /v1/transport/trips` still returns 410 because reviewed
route-plan→trip activation is not implemented. Legacy trip records may only be
cancelled. See `docs/SMART_LOGISTICS_PRODUCTION.md` for activation blockers and
release controls.
