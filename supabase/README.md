# SYNAPSE Supabase

Database changes are stored as ordered SQL migrations.

## Migration files

- `migrations/202607140001_m01_foundation.sql` — schemas, roles, RLS, audit and existing-data reconciliation
- `migrations/202607140002_m01_environment_label.sql` — registers this project as the Test environment
- `migrations/202607150001_m03_raw_ingestion.sql` — immutable source rows, batch/run control and source reconciliation
- `migrations/202607150002_m04_staging_quality.sql` — typed staging, validation rules, issue log and district mapping
- `migrations/202607150003_m05_core_model.sql` — normalized Core model, inventory foundations and analytics views
- `migrations/202607150004_m06_replenishment.sql` — stock health, versioned replenishment, confirmation and approval audit
- `migrations/202607150005_m07_forecasting.sql` — demand features, versioned forecasts, metrics and retryable background jobs
- `migrations/202607150006_m08_routes.sql` — cargo/vehicle masters, route jobs, OR-Tools result tables and GeoJSON
- `migrations/202607150007_wave3_readiness.sql` — AutoETS registry, drift detection and Wave 3 readiness signal
- `migrations/202607150008_m12_operations.sql` — alerts, service heartbeats, backup evidence, workflow audit and release register
- `migrations/202607150009_m09_serverless_api.sql` — same-origin M09 RPC gateway, RBAC and persistent rate limiting
- `migrations/202607160010_m10_web_input_pipeline.sql` — governed Web input from Supabase masters through Raw, Staging, Stock, demand features and optional M06 run
- `migrations/202607160011_legacy_actual_sources.sql` — idempotent importer and API for legacy material, warehouse-stock and CMP actual sources
- `migrations/202607160012_legacy_usage_quality.sql` — preserves signed SAP adjustments while protecting non-negative Core forecast features
- `migrations/202607160013_m09_district_scope_status.sql` — returns explicit 403 for cross-district confirmation and protects the internal M09 dispatcher implementation
- `tests/m01_verify.sql` — read-only acceptance checks
- `tests/wave1_data_foundation_verify.sql` — 21 read-only Wave 1 acceptance checks
- `tests/m06_replenishment_verify.sql` — M06 calculation, security and regression checks
- `tests/m07_forecasting_verify.sql` — M07 schema, model, security and regression checks
- `tests/m08_routes_verify.sql` — M08 schema, workflow, security and master-data checks
- `tests/wave3_intelligence_verify.sql` — combined Wave 3 acceptance checks
- `tests/non_ai_completion_verify.sql` — aggregate non-AI release acceptance (15 checks)
- `tests/m09_serverless_verify.sql` — serverless M09 deployment and privilege checks
- `tests/m10_web_input_pipeline_verify.sql` — 10 Web-input schema, RLS and privilege checks
- `tests/m11_legacy_actual_sources_verify.sql` — 13 legacy-source schema, RBAC and dispatcher checks
- `tests/m12_legacy_usage_quality_verify.sql` — 5 signed-adjustment quality checks
- `tests/local_schema_contract_verify.sql` — fresh-PostgreSQL migration, RLS and dispatcher privilege contract (no business-data fixtures)
- `tests/local_pipeline_workflow_verify.sql` — isolated authenticated workflow contract from VMI input through replenishment, forecast and route queues
- `tests/local_worker_execution_verify.sql` — consumes the isolated forecast/route jobs with the real worker image and verifies persisted results, heartbeat and route review
- `rollbacks/202607140001_m01_foundation_rollback.sql` — manual rollback before dependent modules exist
- `rollbacks/20260715_wave1_rollback.sql` — manual rollback of M03–M05 while preserving M01 and `public.contracts`
- `rollbacks/202607150004_m06_replenishment_rollback.sql` — manual rollback of M06 while preserving Wave 1
- `rollbacks/202607150005_m07_forecasting_rollback.sql` — manual rollback of M07 after M08 is removed
- `rollbacks/202607150006_m08_routes_rollback.sql` — manual rollback of M08
- `rollbacks/202607150007_wave3_readiness_rollback.sql` — manual rollback of the Wave 3 completion migration
- `rollbacks/202607150008_m12_operations_rollback.sql` — manual rollback of operations objects
- `rollbacks/202607150009_m09_serverless_api_rollback.sql` — rollback of the serverless M09 gateway
- `rollbacks/202607160010_m10_web_input_pipeline_rollback.sql` — rollback of the governed Web-input API and persistence objects
- `rollbacks/202607160011_legacy_actual_sources_rollback.sql` — rollback of legacy-source ingestion objects
- `rollbacks/202607160012_legacy_usage_quality_rollback.sql` — rollback of signed-adjustment quality treatment
- `rollbacks/202607160013_m09_district_scope_status_rollback.sql` — restores the pre-wrapper M09 dispatcher
- `.env.example` — variable names only; never commit real secrets

## Rules

1. Apply migrations in filename order.
2. Run the matching verification SQL immediately after each migration.
3. Keep `service_role` and database credentials in a secret manager or ignored local `.env` only.
4. Do not delete or recreate `public.contracts`; it is the 6,305-row source baseline from `รวมสัญญา.xlsx`.
5. Use a new migration for every subsequent change; do not edit an already deployed migration.

## Local migration contract

Run every migration from a clean PostgreSQL 17 database and verify the platform
schema, RLS flags and browser-callable dispatcher privileges:

```sh
make database-contract-local
```

The harness creates only the minimum Supabase Auth roles/functions and an empty
legacy `public.contracts` table. Functional fixtures live only inside the
disposable PostgreSQL container, which is deleted after the checks. They do not
replace the data acceptance checks against the managed Test project.

## Wave deployments

Apply the three Wave 1 migrations in order, then run:

```sql
\i supabase/tests/wave1_data_foundation_verify.sql
```

The expected result is 21 rows with `passed = true`. The deployed Test baseline is documented in `docs/WAVE1_DATA_FOUNDATION.md`.

For Wave 2 M06, apply `migrations/202607150004_m06_replenishment.sql` after Wave 1 and run `tests/m06_replenishment_verify.sql`. The implementation and Stock-source prerequisite are documented in `docs/WAVE2_REPLENISHMENT_API.md`.

For Wave 3, apply migrations `202607150005` through `202607150007` in order, then run `tests/wave3_intelligence_verify.sql`. Expected result: every acceptance row has `passed = true`. The implementation and operational prerequisites are documented in `docs/WAVE3_INTELLIGENCE.md`.

For the non-AI release, apply `202607150008_m12_operations.sql` and run `tests/non_ai_completion_verify.sql`. Expected result: 15 rows and every `passed` value is true. Wave 4 / M11 is intentionally excluded.

For governed operational input, apply `202607160010_m10_web_input_pipeline.sql` after M09 and run `tests/m10_web_input_pipeline_verify.sql`. Expected result: 10 rows with `passed = true`. Admin/planner submissions are idempotent and retain lineage from `raw.import_batches` and `raw.source_rows` through staging, stock, demand features and usage rates. M07 remains readiness-gated until a material/district series has at least 14 real monthly observations.

For the existing operational sources, apply migrations `202607160011` and `202607160012`, then run both matching verification files. The verified Test import contains 658 material source rows, 462 warehouse snapshots, 5,926 CMP series and 48,259 non-negative monthly demand features. Raw retains 256 signed monthly adjustments and 35 signed CMP adjustments. No district-stock value is fabricated while the old `dist_stock` source remains unavailable.

## Role bootstrap

New Supabase Auth users receive the `viewer` application role. Assign the first administrator deliberately from the SQL Editor after that person has signed in to the application:

```sql
update public.user_profiles
set role = 'admin', district_id = null
where user_id = '<auth-user-uuid>';
```

District users must be assigned a System District ID from `5501` through `5518` in the same statement.

## Free-plan backup

The managed Free plan does not include automatic backups. Before a production migration, take a logical backup with `pg_dump` using a direct or session-pooler connection, store it outside the repository, and periodically test restore into a separate test project.
