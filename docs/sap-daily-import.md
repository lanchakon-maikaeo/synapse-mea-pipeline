# Daily and monthly source file import for Synapse

## What the operator uploads

| File | Cadence | Used for |
|---|---|---|
| `Stock_update_DD.MM.YY.XLSX` (6-column SAP export) or prepared `Stock.xlsx` (11 columns, date in K1) | daily | Khlong Toei warehouse stock (plus district stock when the file contains district plants) |
| `รวมสัญญา_update_DD.MM.YYYY.xlsx` / `INPUT_รวมสัญญา` (16 columns) | daily | Contract / PO lines, acceptance date for FIFO order |
| `105_update_DD.MM.YY.XLSX` (13 columns with PO) or the older 14/15-column layouts | daily | Khlong Toei receipts (movement 105) |
| `อัตราการใช้งาน.xlsx` (sheet `Check CMP`, 12 or more MMYYYY columns) | monthly | Monthly usage per district, CMP |

Format notes:

- The 6-column Stock export has no date; the page pre-fills the snapshot date
  from the file name (`20.10.69` = 20 Oct 2569 = 2026-10-20) and the operator
  can correct it.
- Contract exports use 18-digit material codes with leading zeros; they are
  normalized to the 12-digit code (original kept as `source_material_code`).
- The 13-column 105 export ends with SAP subtotal rows that carry only a
  quantity; they are skipped. `รายการ` is kept as `po_item` (PO line) and
  `รายการในเอกสารวัสดุ` as the material-document item.
- Usage workbooks exported from Google Sheets carry `12.0`, `5701.0` and
  `6.21045006E11`; these are read as exact integer codes.
- After checking, the page shows how the files link: 105 rows matched to a
  contract line by PO + material + PO line, rows whose PO is not in the
  contract file, unit mismatches between contract and 105 (never converted
  automatically) and Stock materials that have usage history. This cross-check
  is informational and not stored.

Movement 301 is **not** uploaded: issues are recorded by Synapse itself when a
picker confirms a real issue. 105 is receipt in preparation for issue, not
available-to-issue stock.

## Workflow (Import Data page)

1. Admin or Planner opens **Import Data** and selects any of the four files.
   `INPUT_รวมสัญญา` and `INPUT_105` may come from one prepared workbook; the
   14-column 105 export needs the contract file in the same batch to read the
   unit of measure.
2. **ตรวจไฟล์** parses every file in the browser: headers, identifiers,
   numbers, duplicate keys. Stock and usage use the same rules as
   `pipeline/src/synapse_pipeline/actual_workbooks.py` (12-digit material,
   4-digit plant/storage, `-` usage = 0,
   `CMP = ROUND(AVERAGE(non-negative LY, 12M, 6M, 4M), 0)`).
3. **อัปโหลดและเทียบกับข้อมูลล่าสุด** creates an import run per file, uploads
   rows in chunks under the 1 MB API limit and compares every row with the
   latest accepted value of its business key: new, changed, reappeared,
   unchanged and not-in-file counts, with before/after samples.
4. An **Admin** confirms. Parser warnings must be acknowledged first. A run
   becomes stale, and must be checked again, if another run of the same file
   type was committed after it was compared. Uploading the same file twice is
   flagged by its SHA-256.
5. History lists every run with file name, SHA-256, uploader, confirmer and
   its changes.

## Record identity

- Stock: plant + storage location + material. Rows without a storage
  location use `<missing>`. SAP sometimes exports the same key twice (seen for
  scrap material at plant 2402); each occurrence is kept in file order with
  suffix `#2`, `#3`, … and flagged.
- Usage/CMP: material + plant. Plants outside the 18 districts are stored but
  carry no district.
- Contract line: material + purchase order + SAP line item (leading zeros
  ignored). Procurement code is a grouping field; contract number is an
  attribute, so a corrected number is an update, not a second line.
- 105 receipt: material document + material + purchase order + GR/GI slip +
  `รายการ` + `รก.` + posting date; the 14-column layout also includes
  quantity. `รายการ` and `รก.` are storage fields, not a contract installment.

Keys are computed in the database (`ops.srcimp_business_key`), so a client
cannot redefine record identity.

## Storage and history

Migration `supabase/migrations/202610200001_source_file_import_history.sql`:

- `ops.source_import_runs` — permanent run evidence (cannot be deleted;
  committed and discarded runs are final).
- `ops.source_current_rows` — latest accepted value per key. Keys absent from a
  newer file get `missing_since_run_id`; they are never deleted.
- `ops.source_row_versions` — append-only new/changed/missing/reappeared
  versions with before/after payloads. The accepted state at any run can be
  rebuilt from these versions, so unchanged rows are not copied every day
  (the managed database storage allowance is small).
- `ops.source_import_staging_rows` — working rows, removed on commit/discard;
  drafts older than two days are discarded automatically.

All tables have RLS enabled with no direct grants. The only entry point is
`public.srcimp_dispatch`, reached through the same-origin API at
`/v1/source-imports/*`, which requires the `admin` or `planner` role; commit
requires `admin`.

## What this release does not change

Accepted rows land in their own governed tables. Core stock, CMP, FIFO lots
and weekly replenishment keep reading their existing governed sources until
promotion from these accepted rows is approved as a separate change. A new
file therefore cannot silently alter an open or locked plan.

## Deployment order

1. Take the governed backup described in `supabase/README.md`.
2. Apply `202610200001_source_file_import_history.sql`, then run
   `supabase/tests/source_file_import_verify.sql` (all checks must pass; it
   rolls back its own fixtures).
3. Deploy the dashboard. Until step 2 is done the page shows that the database
   is not ready and offers local file checks only.

Rollback: `supabase/rollbacks/202610200001_source_file_import_history_rollback.sql`
withdraws the entry point and discards open drafts; all history is retained.
