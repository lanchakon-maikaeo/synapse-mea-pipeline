# SYNAPSE Production Operations v1

- Status: release chain through migration `202607240022`; Production starts
  fail-closed until Actual-data, identity and recovery gates pass
- Business rules: frozen 22 July 2026
Release scope: stock, replenishment, warehouse issue and traceability

This document is the active production contract. Forecasting, routing and RAG
are not part of this release. Historical source and migrations for those
experiments may remain for data compatibility, but the production UI, OpenAPI,
CI schedule and deployment profile do not invoke them.

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
The Production web target is `https://synapse-mea.vercel.app`.
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

The command creates a logical backup before applying pending migrations and
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
SMOKE_BASE_URL='https://synapse-mea.vercel.app' \
SYNAPSE_ACCESS_TOKEN='<temporary-masked-token>' \
npm run smoke:deployment
```

The token is optional for public/unauthenticated checks and required for the
authenticated read-only checks. Delete/revoke a temporary token after evidence
is captured.

## Release acceptance

- Dashboard lint, type-check, production build and tests pass.
- Clean PostgreSQL applies 25 ordered migrations.
- All schema/RLS/privilege checks pass.
- All 20 authenticated operational workflow checks pass.
- Pre-cutover readiness returns `503 not_ready`; after authorized cutover it
  returns `200 ok`.
- Unauthenticated `/api/v1/me` returns `401`.
- All 37 documented same-origin OpenAPI paths respond through the release.
- Legacy forecast, route, job, Wave 3 and RAG requests return `410
  scope_excluded`.
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

## Explicit exclusions

The active dashboard and its published OpenAPI have no forecasting, routing,
background intelligence job, Wave 3 or RAG paths. The database dispatcher
returns `410` for direct legacy requests to those namespaces. No worker,
Valhalla service, forecast scheduler or document/RAG indexer is included in the
production deployment command.
