# SYNAPSE Operations Runbook (release 1.0.0-non-ai)

This runbook covers the non-AI delivery: data foundation, ingestion and quality, core VMI model, replenishment, forecasting baseline, route optimization, API, dashboard and operations. Wave 4 / M11 AI is intentionally excluded.

## Ownership and service levels

| Area | Primary owner | Backup owner | Target / trigger |
|---|---|---|---|
| Source files and contracts | Procurement data steward | SYNAPSE admin | Import within agreed source window |
| Stock and CMP export | SAP/WMS data steward | District coordinator | Freshness ≤ 26 hours |
| Pipeline and quality | Data engineer | SYNAPSE admin | Failed import investigated within 4 hours |
| Replenishment decisions | Planner | District approver | Every override includes a reason |
| API and worker | Platform operator | Data engineer | Availability target 99.5% during pilot |
| Backup and restore | Database operator | Platform operator | Daily logical backup; quarterly restore drill |
| Security and access | SYNAPSE admin | MEA security | Quarterly role review; immediate leaver removal |

## Routine checks

1. Open `/health/ready`; a `503` means the database cannot be reached.
2. Review `analytics.v_operations_health` and open `ops.system_alerts`.
3. Confirm the latest `ops.service_heartbeats.last_seen_at` is less than ten minutes old.
4. Confirm the newest `ops.backup_runs` record is `succeeded` and verify the artifact checksum.
5. Run `synapse-intelligence refresh-alerts --stale-hours 26` after scheduled source windows.

## API down

1. Run `docker compose ps` and `docker compose logs --since=15m api`.
2. Check `/health` first, then `/health/ready` to separate process failure from database failure.
3. Verify `DATABASE_URL`, TLS reachability and connection limits without printing credentials.
4. Restart only the failed service: `docker compose restart api`.
5. If the new release caused the incident, follow **Rollback** below.

## Repeated 5xx

1. Correlate the dashboard error's `request_id` with JSON API logs.
2. Check failed background jobs and operational alerts.
3. Do not retry approval endpoints blindly; inspect `audit.change_log` first.
4. Preserve the relevant log window and record an incident before changing data.

## Import or data-quality failure

1. Locate the failed batch in `raw.import_batches` and its rows in `raw.import_errors` / staging issue tables.
2. Correct source mapping or data at source; do not edit verified core rows to hide the issue.
3. Re-run with the same source checksum. Idempotency prevents duplicate accepted rows.
4. Refresh alerts and confirm lineage from core record to source row.

## Failed worker job

1. Inspect `ops.background_jobs.error_message`, payload and attempt count.
2. For forecast jobs, confirm at least seven months for baselines and fourteen months for AutoETS comparison.
3. For route jobs, verify geocodes, packaging, vehicle capacities and driver availability.
4. Permit Haversine only in test by setting `ALLOW_HAVERSINE_FALLBACK=true`; production uses Valhalla.

## Backup

Run from a host with PostgreSQL client tools compatible with the server:

```bash
DATABASE_URL='…' BACKUP_DIR=/secure/synapse/backups scripts/backup_database.sh
```

The script creates a custom-format dump, a SHA-256 sidecar and a successful evidence row in `ops.backup_runs`. Encrypt the backup volume, restrict directory access to the operator and apply the MEA retention policy.

## Restore drill

Provision an empty, isolated PostgreSQL/Supabase test database. Never use the production project as the drill target.

```bash
SOURCE_DATABASE_URL='…' DRILL_DATABASE_URL='…' scripts/restore_drill.sh
```

Evidence is written only after checksum verification, `pg_restore --exit-on-error`, a catalog query and detection of all six SYNAPSE schemas.

## Release

1. Run `make ci`.
2. Review migrations and matching rollback scripts.
3. Build immutable images tagged with the release version and commit SHA.
4. Apply migrations first with the guarded command below, then deploy API,
   worker and dashboard.
5. Confirm the release evidence in `ops.release_versions` and run production
   smoke/RBAC checks.

The database deployment command refuses the wrong environment or a missing
approval phrase, creates a logical backup first, serializes migration execution
with a PostgreSQL advisory lock, applies only unregistered migrations, verifies
the schema contract and records the release SHA:

```bash
DATABASE_URL='…' \
BACKUP_DIR=/secure/synapse/backups \
RELEASE_VERSION='1.0.1-non-ai' \
RELEASE_GIT_SHA='<published-full-pipeline-sha>' \
DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS \
RUN_DATA_ACCEPTANCE=true \
scripts/deploy_database_migrations.sh
```

Do not run it with a local-only or unpublished SHA. The default expected
database environment is `test`; changing `EXPECTED_DATABASE_ENVIRONMENT`
requires separate change approval.

## Rollback

1. Stop new writes by pausing the worker and restricting planner traffic.
2. Redeploy the previously validated image tags.
3. Use the matching SQL rollback only after checking whether it removes accepted business data. Prefer forward fixes for additive migrations.
4. If data recovery is required, restore into an isolated database first, validate, then obtain change approval for production recovery.
5. Add a `rolled_back` record to `ops.release_versions`, preserve audit logs and refresh alerts.

## Security incident

1. Disable or rotate the affected credential in its owning system; never paste it into tickets or chat.
2. Revoke affected users and review `audit.change_log`, Auth logs and API request IDs.
3. Preserve evidence, notify MEA security and document the time window.
4. Re-run the secret scanner and access review before service restoration.
