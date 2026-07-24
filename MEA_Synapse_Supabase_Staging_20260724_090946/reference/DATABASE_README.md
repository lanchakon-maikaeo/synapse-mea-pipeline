# MEA Synapse Staging Database

This directory contains the additive PostgreSQL/Drizzle foundation for Staging.

## Safety boundary

- Never set `STAGING_DATABASE_URL` to a Production database.
- Migration requires both `STAGING_DATABASE_URL` and the exact confirmation value `STAGING_DB_CONFIRM=MEA_SYNAPSE_STAGING`.
- No online database migration has been run from this workspace yet.
- Take a logical backup/snapshot before every later migration once Staging contains operational data.

## Files

- `schema.ts`: typed schema source of truth.
- `migrations/0000_famous_talos.sql`: four schemas, enums, constraints, indexes and 18 foundation tables.
- `migrations/0001_staging_baseline_views_and_guards.sql`: Business Rules v1 seed data, Analytics views, audit/append-only guards and RLS enablement.
- `migrations/0002_wise_jamie_braddock.sql`: six decision-support tables for weekly plans, explainable suggestions, abnormal requests, approvals and FIFO traceback; three Analytics views and additional guards/RLS.
- `acceptance/001_foundation_acceptance.sql`: post-migration acceptance checks.

## Local validation

```powershell
npm.cmd run db:check
npm.cmd run db:validate
npm.cmd run build
```

## Apply to an approved Staging PostgreSQL database

Set the variables in the current terminal without saving them into repository files, then run:

```powershell
npm.cmd run db:migrate:staging
```

After migration, execute `db/acceptance/001_foundation_acceptance.sql` in the same Staging database. Every check must complete without an exception.

## Next delivery

Migration 0003 should add authenticated role-specific RLS policies and any API-specific support required for weekly confirmation/approval. Ad-hoc issues and transport linkage remain separate follow-up work. Do not apply 0002 or later to an online environment until the foundation migration is applied to a dedicated Staging database and acceptance checks pass.
