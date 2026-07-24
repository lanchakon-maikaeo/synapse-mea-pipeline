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
`202607240019`:

- contract-item version evidence;
- verified, source-derived, estimated, opening-unknown and test-fixture source
  quality;
- production environment and cutover evidence;
- data, identity and recovery readiness gates;
- fail-closed operational writes.
- Actual `รวมสัญญา.xlsx` import and quality-controlled Core promotion;
- complete Dummy-workbook source evidence and typed cross-sheet relations;
- checksum manifest for every file in the Staging design package.

The three data classes are enforced separately:

| Source | Data class | Operational promotion |
|---|---|---|
| `รวมสัญญา.xlsx` | `actual` | Yes, after completeness and DQ checks |
| `MEA_VMI_Dummy_Klongtoey.xlsx` | `reference_fixture` | No |
| Staging package files | `design_reference` | No |

Forecasting, routing and RAG remain excluded.

## Environments

| Environment | Supabase project | Purpose |
|---|---|---|
| Test/UAT | `mklnbumfwojxhqscthjd` | governed TEST_FIXTURE and rollback baseline |
| Production | `jbwbmrizawxcrtliozqt` | Actual-only greenfield operational target |

Production was provisioned separately. Test is never relabeled or overwritten.

The aligned Production web project is
`https://mea-synapse-production.vercel.app`, built from GitHub `main` with
Root Directory `dashboard` and the Production Supabase public connection
variables. Public health returns `200`; readiness intentionally returns `503`
with `operational_ready=false` until the cutover gates pass.

## Production import evidence

Verified on Supabase project `jbwbmrizawxcrtliozqt` on 24 July 2026:

| Evidence | Verified result |
|---|---:|
| Ordered migrations | 22 |
| Actual contract landing/raw rows | 6,305 / 6,305 |
| Contract staging DQ | 4,128 valid; 2,177 warning; 0 rejected |
| Current Core contracts/items | 2,857 / 6,305 |
| Core materials | 776 total; 203 active VMI |
| Dummy reference rows | 9,160 across 12 artifacts |
| Staging design-package files | 8 checksum artifacts |
| Typed relation edges | 22,519 |
| Linked source rows | 9,670 |

Both the Actual and Dummy artifact inventories report complete row counts.
Production remains locked because the readiness result is `blocked`, not
because this import is incomplete.

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
export TARGET_PROJECT_REF='jbwbmrizawxcrtliozqt'
export TARGET_REGION='ap-southeast-2'
export CHANGE_TICKET='SYNAPSE-PROD-CUTOVER'
export DEPLOY_CONFIRM='APPLY_PENDING_MIGRATIONS'
export PRODUCTION_DEPLOY_CONFIRM='DEPLOY_GREENFIELD_PRODUCTION'
export GREENFIELD_BOOTSTRAP_CONFIRM='INITIALIZE_EMPTY_DATABASE'
bash scripts/deploy_database_migrations.sh
```

Never place the database password, service-role key or generated Auth
credentials in Git or a `NEXT_PUBLIC_*` variable.

## Remaining real-data work

The migrations make the software deployable and the controls production-safe;
they do not invent missing operational facts. The Actual contract workbook is
eligible for Core promotion, while Dummy and design-reference records remain
queryable only as lineage/reference evidence. Cutover remains blocked until
Actual stock/CMP, verified packaging/weight, Auth bootstrap, backup and
restore-drill evidence pass the database gates.
