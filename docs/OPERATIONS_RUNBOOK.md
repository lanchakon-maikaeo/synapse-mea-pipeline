# SYNAPSE Operations Runbook — Production Operations v1

This runbook covers source ingestion, stock/CMP, weekly replenishment,
District/Planner/Academic approval, receiving, FIFO/Handling Units, issue,
return/quarantine, ad-hoc issue, traceability, API, dashboard, backup and
release evidence for the verified live M24 baseline. Governed transport,
OSM-derived mapping and the OR-Tools/Valhalla worker are a separate local M13
candidate and have not been deployed. Forecasting, legacy route-job namespaces
and RAG remain excluded.

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
7. After an approved M13 deployment only, review `/api/v1/transport/readiness`;
   do not interpret ordinary inventory readiness as transport readiness.

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
7. Legacy `/v1/forecasts*`, `/v1/routes*`, `/v1/jobs*`, Wave 3 and RAG paths
   should return `410 scope_excluded`; do not enable a worker to make them pass.
   The candidate `/v1/transport/*` namespace is distinct and must not be routed
   to the legacy exclusion handler.

## Transport incident and activation guard

This section applies only after a separately approved M13 release. Until then,
the expected live behavior is the deployed M24 transport exclusion.

1. Check `/api/v1/transport/readiness` and preserve its request ID. A blocked
   canonical origin, geocode, fleet, packaging, road-engine, tariff or
   trip-activation gate is an operational stop, not a reason to use demo data.
   For an `admin`/`planner`, confirm the selected exact locked plan UUID appears
   in `optimization_eligible_plan_ids`; a missing, malformed or empty list
   closes the queue for that plan.
2. Verify the selected origin is the locked latest replenishment plan's exact
   canonical warehouse location. Never infer `WH-MMBP`, Khlong Toei or Bang
   Phli mappings from geographic proximity.
3. Confirm every stop carries the approved coordinate-source checksum and row;
   the candidate source checksum is
   `fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a`.
4. For an operational solve, verify canonical vehicle mapping, measured
   weight/pallet capacity, non-expired availability, physical packaging/UOM,
   Valhalla truck matrix status and immutable OSM graph/extract identity.
   `ROUTING_ENGINE_DATA_VERSION` and `VALHALLA_TILESET_VERSION` must each match
   `<lowercase-label>-sha256-<64 lowercase hex>` and contain the reviewed
   artifact/manifest digest. Reject labels, dates or label-checksums presented as
   evidence. `VALHALLA_OSM_CHANGESET` is a nonnegative secondary operator
   `dataset_id`, not cryptographic proof; reject status or route responses whose
   numeric value differs from the release configuration.
5. Review persisted `core.route_plan_vehicle_road_evidence`: ordered
   depot→stops→depot waypoints, valid WGS84 `LineString`, road
   distance/duration and engine/status/request/response hashes must agree with
   plan totals. Never substitute a straight line or Haversine distance.
6. Treat a nullable road-engine toll flag only as route metadata. Display no
   Thai-baht toll until an approved, effective-dated EXAT/BEM/DOH/M-Flow tariff
   and route/plaza match exist.
7. `POST /v1/transport/trips` remains expected to return 410 until the reviewed
   route-plan→trip activation contract is released. A legacy trip returning
   `409 road_evidence_not_verified` for dispatch/retry/complete is correct; only
   cancellation is allowed.
8. Stop the worker and preserve job/evidence rows when engine or tileset identity
   changes mid-run, a waypoint is unreachable, or availability expires. Re-run
   only after correcting the governed source and creating fresh evidence.
9. Interpret `optimization_worker_status` literally:
   `blocked_operational_writes_locked`,
   `blocked_no_exact_locked_plan_with_verified_depot_and_fleet` and
   `blocked_no_recent_optimization_worker_heartbeat` are stop conditions. Only
   `ready_valhalla_exact_locked_plan_queue` permits a new governed queue request;
   it does not override the separate trip-persistence blocker.
10. Treat a worker heartbeat as compatible only when it is recent and attests
    the expected worker/attestation version, controlled non-community Valhalla
    URL, truck profile, exact digest-bound tileset, numeric operator dataset ID,
    engine/tile timestamp, `/status` response SHA-256 and validation timestamp.
    Queue creation rechecks this server-side and should return 503 when no such
    worker exists.
11. The planner UI may resume a lost submitting response only with the same
    actor+plan-scoped `X-Request-ID` stored in session state. It then polls the
    actor-owned job. Failed/cancelled attempts require confirmation and a new
    request ID; succeeded plans are immutable. Never copy a stored request ID to
    another actor or plan, and never store JWTs or route payload/evidence there.

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

The commands below describe the M24 baseline release pattern. Reproducing M24
requires the exact verified M24 release commit. Do **not** run the guarded
migration script from the current M13 working tree against live Production: it
applies pending migrations from the checked-out commit. These instructions do
not authorize or prove an M13 deployment.

1. At the exact approved release commit, run `make workspace-ci` and secret scan.
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

For an M13 release, first satisfy the owner-data and infrastructure blockers in
`docs/SMART_LOGISTICS_PRODUCTION.md`, then use the protected artifact-promotion
workflow with staging evidence. Database migration must precede web/worker
cutover; the worker is never started by the Vercel deployment. The local
production workflow has not been run against a live target as part of the M13
candidate work.

Production using a standard `https://<20-character-ref>.supabase.co` origin
leaves `SUPABASE_ALLOWED_ORIGIN` empty. A custom Supabase domain must be pinned
as one exact server-only HTTPS origin; reject userinfo, paths, query/fragment,
loopback hosts and any `NEXT_PUBLIC_` copy of this value.

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
