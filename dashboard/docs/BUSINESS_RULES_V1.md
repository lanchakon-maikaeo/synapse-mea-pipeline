# MEA Synapse — Business Rules v1

Status: **FROZEN**
Effective baseline: 22 July 2026
Environment: Production deployment baseline

Changes after this baseline require a new version and must not rewrite historical plan or movement results.
Every Production deployment requires a verified logical backup, migration
contract pass, application smoke test, release evidence and a named operator.

## Data sources and cadence

- `Stock.xlsx`: import daily.
- `อัตราการใช้งาน.xlsx`: import monthly.
- `รวมสัญญา.xlsx`: import daily; old rows may change and new rows may be added.
- Every import is retained as an immutable batch with file checksum and source-row lineage.
- A daily file updates the current interpretation but never deletes historical versions.

## Stock

- Khlong Toei source warehouse is Plant `2401`, Storage Location `0001`.
- Calculation uses `Unrestricted / ไม่จำกัด` only.
- `Stock in Transfer / การส่ง/การโอน` is excluded.
- District stock sums Unrestricted quantity across all Storage Locations under that district Plant; no Storage Location is excluded.
- Missing Material + Plant stock is calculated as zero and flagged `Source Missing / Assumed 0`.

## Usage and CMP

- A `-` in monthly usage means no usage and is normalized to numeric zero.
- `CMP = ROUND(AVERAGE(LY, 12M, 6M, 4M), 0)`.
- CMP is an average monthly usage quantity, not a percentage.
- CMP zero is displayed as zero and MIN/MAX are not calculated.

## Replenishment policy

- Stock Trigger: remaining stock at or below `3.5` months.
- MIN Target: `4` months.
- 3M: reference only.
- MAX Target: `6` months.
- Above 6 months: warning.
- Above 9 months: special approval required.
- Official plan is weekly. Daily calculation is Alert/Exception only and cannot overwrite a locked weekly plan.
- Final approval order is District confirmation, Planner approval, Academic Officer approval, then Lock.

## Contracts and FIFO

- Only rows containing both Material and Contract are eligible for preparation and FIFO allocation.
- `รายการที่` is treated as PO Item/delivery installment from the supplied source.
- FIFO order is accepted date (`วันผ่านตรวจรับ`) ascending, followed by PO, PO Item/installment and source-row order as deterministic tie-breakers.
- Use the oldest opened Handling Unit with Remain before opening the next unit in the same FIFO lot.
- Returns link to the original issue and original Handling Unit. Damaged/test-failed returns move to Quarantine.
- Vendor is hidden for privacy in the current release. Use a stable dummy alias such as `SUP-UNKNOWN`; do not fabricate changing supplier identities.

## Handling units and packaging

- Track all Khlong Toei materials progressively from Go-Live.
- Supported types: Full Pallet, Box, Crate, Bundle/Loose and Long Material.
- Go-Live starts reliable Pallet/Remain/Movement history. Pre-Go-Live movements are not fabricated.
- Unknown opening stock remains `OPENING_UNKNOWN` until verified.
- Dummy packaging is permitted in Staging but cannot automatically approve a real vehicle load.

## Production deployment

- The governed release scope is stock, CMP, weekly replenishment, District
  response, Planner/Academic approval, locking/versioning/cancellation,
  receiving, Handling Unit/FIFO allocation, issue, return/quarantine, ad-hoc
  issue and end-to-end traceability.
- Authentication, role checks, district scope, RLS, append-only movements,
  approval history and audit evidence are enforced in the database/API, not
  only in the browser.
- Apply ordered migrations with `scripts/deploy_database_migrations.sh`; the
  command requires an explicit confirmation phrase, creates a backup first and
  records the release result.
- Forecasting, routing, and RAG are excluded from this release. They have no
  production navigation or published OpenAPI paths, and direct legacy requests
  fail closed.
- A previous application version may be redeployed, but a database rollback
  must restore the verified pre-release backup or use a reviewed forward-fix.
  Production data tables must never be dropped as an automatic rollback.
