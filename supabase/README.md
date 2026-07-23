# SYNAPSE Supabase

The managed database uses ordered SQL migrations, database-enforced RBAC/RLS,
append-only operational evidence and guarded backup-before-migrate deployment.

## Active production migration chain

- `202607140001_m01_foundation.sql` — schemas, roles, RLS and audit
- `202607140002_m01_environment_label.sql` — environment registration
- `202607150001_m03_raw_ingestion.sql` — immutable batches/source rows
- `202607150002_m04_staging_quality.sql` — validation and district mapping
- `202607150003_m05_core_model.sql` — normalized Core model and stock
- `202607150004_m06_replenishment.sql` — replenishment foundation
- `202607150008_m12_operations.sql` — health, alerts, backup/release evidence
- `202607150009_m09_serverless_api.sql` — authenticated RPC gateway
- `202607160010_m10_web_input_pipeline.sql` — governed VMI input and exact CMP
- `202607160011_legacy_actual_sources.sql` — idempotent existing-source importer
- `202607160012_legacy_usage_quality.sql` — signed SAP adjustment preservation
- `202607160013_m09_district_scope_status.sql` — district denial and dispatcher protection
- `202607230014_production_operations_v1.sql` — complete weekly planning,
  District/Planner/Academic workflow, quantity evidence, abnormal review,
  Handling Unit/FIFO, receipt/issue/return, ad-hoc issue and traceback

Migrations `202607150005`–`202607150007` remain in filename order because they
may already exist in deployed databases. Their forecast, route and Wave 3
objects are historical/dormant compatibility data. Migration
`202607230014` removes those namespaces from the production API by returning
`410 scope_excluded`. Forecasting, routing and RAG are not release
capabilities.

## Production verification

- `tests/local_schema_contract_verify.sql` — 43 migration, schema, function,
  RLS and privilege checks
- `tests/local_pipeline_workflow_verify.sql` — 20 authenticated business-flow
  checks from governed VMI input through weekly/ad-hoc issue and traceback
- `scripts/test_supabase_migrations_local.sh` — clean PostgreSQL 17 apply,
  both SQL contracts and guarded deployment/backup evidence

Run:

```bash
make database-contract-local
```

The harness uses a disposable PostgreSQL container and never connects to the
managed project.

Historical module-specific SQL tests and rollback files are retained as
implementation records. They are not part of the Production Operations v1
acceptance gate.

## Migration rules

1. Apply migrations in filename order.
2. Add a new migration for every deployed change; do not rewrite deployed
   history.
3. Never delete/recreate the existing `public.contracts` source baseline.
4. Keep `service_role`, database credentials and JWT secrets outside Git.
5. Back up first and capture a named release/operator record.
6. Preserve operational movements and approvals; use a reviewed forward-fix or
   verified backup restore instead of dropping production evidence.

## Guarded production deployment

```bash
export DATABASE_URL='postgresql://...'
export BACKUP_DIR='/approved/off-repository/location'
export RELEASE_VERSION='production-operations-v1'
export RELEASE_GIT_SHA='<40-character-commit>'
export DEPLOY_CONFIRM='APPLY_PENDING_MIGRATIONS'
bash scripts/deploy_database_migrations.sh
```

The command refuses an invalid confirmation, creates a logical backup, applies
only pending migrations and records backup/release evidence. Restore that backup
into a separate test project and validate it before any production cutover.

The Supabase Free plan does not provide the same automated backup guarantees as
paid plans. An operator-owned `pg_dump` plus restore drill is mandatory for a
production change window.

## Role bootstrap

New Supabase Auth users default to `viewer`. Assign roles deliberately after
the user has signed in:

```sql
update public.user_profiles
set role = 'admin', district_id = null
where user_id = '<auth-user-uuid>';
```

Available roles are `admin`, `planner`, `academic`, `picker`, `district`
and `viewer`. A District user must also receive its authorized System District
ID (`5501`–`5518`). Never use browser metadata as the authorization source.

See `docs/PRODUCTION_OPERATIONS_V1.md` for deployment order, smoke checks,
rollback containment and the full release acceptance contract.
