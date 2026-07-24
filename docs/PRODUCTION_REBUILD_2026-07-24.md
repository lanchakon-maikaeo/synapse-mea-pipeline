# SYNAPSE Production Rebuild — 24 July 2026

## Decision

The canonical system is rebuilt as one ordered pipeline:

```text
Verified source / governed web input
  -> raw immutable evidence
  -> staging validation and quarantine
  -> core canonical entities
  -> analytics read models and readiness
  -> authenticated same-origin API
  -> role-scoped Next.js operations workspace
```

The folder `MEA_Synapse_Supabase_Staging_20260724_090946` is a design
reference only. Its README explicitly limits it to Staging, and its parallel
UUID schema has no application-role policies or grants. Applying those files
would collide with the operational schema and break the current API contract.

Concepts merged into the canonical model by migrations `202607240017` through
`202607240020`:

- contract-item version evidence;
- verified, source-derived, estimated, opening-unknown and test-fixture source
  quality;
- production environment and cutover evidence;
- data, identity and recovery readiness gates;
- fail-closed operational writes.
- Actual `รวมสัญญา.xlsx` import and quality-controlled Core promotion;
- complete VMI-workbook source evidence and typed cross-sheet relations;
- checksum manifest for every file in the Staging design package.
- owner attestation, checksum-preserving Actual promotion and auditable DQ
  remediation.

Data class is determined by governed evidence and an explicit owner
attestation, not by the source filename:

| Source | Data class | Operational promotion |
|---|---|---|
| `รวมสัญญา.xlsx` | `actual` | Yes, after completeness and DQ checks |
| `MEA_VMI_Dummy_Klongtoey.xlsx` | `actual` | Yes, owner-attested on 24 July 2026 |
| Staging package files | `design_reference` | No |

Forecasting, routing and RAG remain excluded.

## Environments

| Environment | Supabase project | Purpose |
|---|---|---|
| Test/UAT | `mklnbumfwojxhqscthjd` | governed TEST_FIXTURE and rollback baseline |
| Production | `fvdfduuanfrncrwuareb` | Current fail-closed operational target |

Production was provisioned separately. Test is never relabeled or overwritten.

The previous Production project `jbwbmrizawxcrtliozqt` is retained as legacy
deployment evidence only. Its owner-attested import results below do not prove
data readiness on the current `synapse-01` target.

The aligned Production web project is
`https://mea-synapse-production.vercel.app`, built from GitHub `main` with
Root Directory `dashboard` and the Production Supabase public connection
variables. Public health returns `200`; readiness intentionally returns `503`
with `operational_ready=false` until the cutover gates pass.

## Production import evidence

Legacy verification on Supabase project `jbwbmrizawxcrtliozqt` on 24 July
2026:

| Evidence | Verified result |
|---|---:|
| Ordered migrations | 23 |
| Actual contract landing/raw rows | 6,305 / 6,305 |
| Contract staging DQ | 4,128 valid; 2,177 warning; 0 rejected |
| Current Core contracts/items | 2,857 / 6,305 |
| Active VMI materials | 225 |
| Owner-attested Actual workbook rows | 9,160 across 12 artifacts |
| Actual district stock coverage | 4,050 / 4,050 |
| Actual usage/CMP coverage | 4,050 / 4,050 |
| Verified packaging / positive unit weight | 225 / 225 |
| Usage DQ remediation | 4 negative aggregates normalized to 0 from zero monthly history |
| Staging design-package files | 8 checksum artifacts |
| Typed relation edges | 22,519 |
| Linked source rows | 9,670 |

All Actual artifact inventories report complete row counts. The data gate is
`data_contract_ready=true`. Production remains locked only because the identity
and recovery gates have not passed: one central role is provisioned, no
district identities are provisioned, and the Supabase Free plan supplies no
managed backup or verified restore drill.

## Cutover contract

Production starts with `operational_writes_enabled = false`. Reads, imports and
verification may proceed, but replenishment, inventory and ad-hoc mutations
return `423 production_not_ready`.

The service-role-only cutover function refuses to enable writes until all of
these are true:

1. 18 active districts and a non-empty VMI material scope exist.
2. Every VMI material/district pair has Actual district stock and Actual CMP.
3. No `test_fixture` stock, usage or packaging rows exist.
4. Every VMI material has positive unit weight and verified packaging.
5. Admin, Planner, Academic and Picker roles exist, plus all district scopes.
6. A successful database backup and an isolated restore drill are recorded.

The readiness state is exposed through
`analytics.v_production_readiness`, `/v1/operations/readiness` and the
Operations Center. The dashboard blocks the same operational mutations before
they reach the API.

## Greenfield deployment

```bash
export DATABASE_URL='postgresql://...'
export BACKUP_DIR='/approved/off-repository/location'
export RELEASE_VERSION='production-rebuild-2026-07-24'
export RELEASE_GIT_SHA='<verified-git-sha>'
export DEPLOYMENT_PROFILE='production'
export TARGET_PROJECT_REF='fvdfduuanfrncrwuareb'
export TARGET_REGION='ap-southeast-1'
export CHANGE_TICKET='SYNAPSE-PROD-CUTOVER'
export DEPLOY_CONFIRM='APPLY_PENDING_MIGRATIONS'
export PRODUCTION_DEPLOY_CONFIRM='DEPLOY_GREENFIELD_PRODUCTION'
export GREENFIELD_BOOTSTRAP_CONFIRM='INITIALIZE_EMPTY_DATABASE'
bash scripts/deploy_database_migrations.sh
```

Never place the database password, service-role key or generated Auth
credentials in Git or a `NEXT_PUBLIC_*` variable.

## Cutover completion

The owner selected the explicit `single_admin` identity policy. Production has
one active administrator and no synthetic planner, district or warehouse
identities. Additional identities must only be added from a future
owner-approved roster.

The off-project logical backup, checksum verification and isolated PostgreSQL
17 restore drill passed and their evidence is recorded in `ops.backup_runs`.
M24 was deployed and verified, then
`ops.set_operational_writes_enabled(...)` completed with change ticket
`SYNAPSE-PROD-20260724`. The resulting readiness state is `operational`.

The Supabase Free plan does not include managed backups. Continue the
repository `pg_dump`/restore workflow against an approved isolated target until
the Production plan provides an equivalent managed recovery control. A
same-project snapshot is not acceptable recovery evidence.
