# SYNAPSE Operations Runbook — Production Operations v1

This runbook covers source ingestion, stock/CMP, weekly replenishment,
District/Planner/Academic approval, receiving, FIFO/Handling Units, issue,
return/quarantine, ad-hoc issue, traceability, API, dashboard, backup and
release evidence. Forecasting, routing and RAG are excluded.

## Ownership and service levels

| Area | Primary owner | Backup owner | Target / trigger |
|---|---|---|---|
| Source files and contracts | Procurement data steward | SYNAPSE admin | Import in the agreed source window |
| Stock export | SAP/WMS data steward | Warehouse operator | Daily; freshness <= 26 hours |
| Usage/CMP export | SAP data steward | Planner | Monthly |
| Pipeline and data quality | Data engineer | SYNAPSE admin | Failed import investigated within 4 hours |
| Weekly plan | Planner | SYNAPSE admin | One governed plan/version per week |
| District response | District coordinator | Planner on behalf | Every rejection/change has requester and reason |
| Special approval | Academic Officer | Named delegate | Note required when any line exceeds 9 months |
| Receipt/FIFO/issue | Picker/warehouse | Planner | Every physical change has an immutable movement |
| Backup/restore | Database operator | Platform operator | Pre-release backup; quarterly restore drill |
| Security/access | SYNAPSE admin | MEA security | Quarterly review; immediate leaver removal |

## Routine checks

1. Check `/api/health` and `/api/health/ready`.
2. Review `analytics.v_operations_health` and open `ops.system_alerts`.
3. Verify newest source batches, file checksums, accepted/rejected counts and
   stock/usage cadence.
4. Confirm no `OPENING_UNKNOWN` Handling Unit is being allocated before
   physical reconciliation.
5. Review pending abnormal requests and Planner/Academic approval queues.
6. Confirm the newest required `ops.backup_runs` evidence is `succeeded`.

## Repeated API error

1. Correlate the dashboard `request_id` with Vercel and Supabase logs.
2. Separate Auth/RBAC/RLS denial from database readiness or application error.
3. If several new `/v1/*` paths return `404` while older paths return `200`,
   compare `max(ops.schema_migrations.version)` with the migration required by
   the deployed Git commit before changing application routing.
4. If every API returns `200` but the page remains blank or unresponsive,
   inspect response row counts and payload size. Dashboard list endpoints must
   use bounded server-side reads; do not render an entire analytical cube in
   the initial load.
5. Do not retry approval, issue or return writes blindly; inspect immutable
   approval/movement/audit evidence first.
6. Preserve the relevant log window and record an incident before changing data.
7. A request for forecast, route, job, Wave 3 or RAG paths should return `410
   scope_excluded`; do not enable a worker to make it pass.

## Import or data-quality failure

1. Locate the batch in `raw.import_batches` and its source/error rows.
2. Correct mapping/data at source; never edit verified Core rows to hide an
   issue.
3. Re-run the same source checksum. Idempotency prevents duplicate acceptance.
4. Verify lineage from Core to source row.
5. Missing Material + Plant stock stays assumed zero and visibly
   source-missing; it is not fabricated as a real source row.

## Plan or approval incident

1. Confirm the plan version and current state.
2. Confirm all District changes have requester/reason and all review decisions
   are immutable.
3. Above 6 months is a warning; above 9 months requires Academic approval and a
   note.
4. A locked plan is never edited in place. Cancel or create a new version so
   reservations and audit history remain coherent.
5. Planner on-behalf actions must retain the District requester identity.

## Inventory discrepancy

1. Stop issue for the affected Handling Unit.
2. Compare current quantity with append-only receipt/reserve/release/issue/
   return/quarantine movements.
3. Reconcile an `OPENING_UNKNOWN` unit only after physical verification.
4. Use a return linked to the original issue. Damaged/test-failed stock must
   move to Quarantine.
5. Never update or delete an inventory movement to force a balance.

## Backup

```bash
DATABASE_URL='...' \
BACKUP_DIR='/secure/off-repository/synapse' \
scripts/backup_database.sh
```

The script creates a custom-format dump, SHA-256 sidecar and backup evidence.
Encrypt the volume, restrict operator access and follow MEA retention policy.

Supabase Free projects do not provide scheduled backups. A same-database
snapshot can reduce migration data risk but cannot recover a lost project and
must not be represented as an off-project backup. Use an encrypted `pg_dump`
whenever database credentials and PostgreSQL client tools are available.

## Restore drill

Use an empty isolated PostgreSQL/Supabase test target, never Production:

```bash
SOURCE_DATABASE_URL='...' \
DRILL_DATABASE_URL='...' \
scripts/restore_drill.sh
```

Accept the drill only after checksum verification, `pg_restore
--exit-on-error`, catalog checks and the production workflow contract.

## Release

1. Run `make workspace-ci` and secret scan.
2. Verify approved change, Git commit and Vercel/Supabase targets.
3. Apply the database migration first with the guarded command.
4. Verify backup/release evidence and all database acceptance checks.
5. Deploy the verified `main` commit to Vercel.
6. Wait for `READY`; run public plus authenticated read-only smoke checks.
7. Capture CI, database, backup and Vercel evidence; revoke any temporary token.

```bash
DATABASE_URL='...' \
BACKUP_DIR='/secure/off-repository/synapse' \
RELEASE_VERSION='production-operations-v1' \
RELEASE_GIT_SHA='<published-40-character-sha>' \
DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS \
scripts/deploy_database_migrations.sh
```

## Rollback

1. Restrict new writes and preserve the incident window.
2. Redeploy the previous verified Vercel version if the application caused the
   issue.
3. Do not automatically drop tables or erase approval/movement evidence.
4. Prefer a reviewed forward-fix for additive schema problems.
5. If data recovery is required, restore the verified pre-release backup into
   an isolated project, validate, then switch only with change approval.
6. Record failed/rolled-back release status and operator reason.

## Security incident

1. Disable/rotate the credential in its owning system; never paste it into
   tickets, logs or chat.
2. Revoke affected users and review Auth, Vercel request IDs, RLS denials and
   `audit.change_log`.
3. Preserve evidence and notify MEA security.
4. Re-run the secret scanner and role review before service restoration.
