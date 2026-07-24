# MEA Synapse — Business Rules v1

Status: **FROZEN**
Effective baseline: 22 July 2026
Environment: Staging first; Production is explicitly out of scope

Changes after this baseline require a new version and must not rewrite historical plan or movement results.
Never run these migrations against Production without separate approval, backup, and release verification.

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

## Vehicle baseline

- Observed payload is approximately 6,000 kg and remains unverified as a legal/safety limit.
- Average usable deck: 2.45 × 5.20 metres.
- Side height: approximately 0.50 metres.
- No overhang and no lifting equipment.
- Default stacking is one layer/manual review because stacking is operationally difficult.
