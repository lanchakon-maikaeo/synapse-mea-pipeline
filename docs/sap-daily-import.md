# Daily SAP import for Synapse

## Quick file-check mode (current Import page)

The current Import page checks the prepared workbook entirely in the browser.
Choose one `.xlsx` containing `INPUT_รวมสัญญา` and `INPUT_105จริง`, or choose
the two SAP exports separately. Press **ตรวจไฟล์** to validate headers,
business keys, quantities, and duplicate rows. The page shows item counts,
warnings, and the first 20 rows of each source; the user can export validated
rows as CSV. Files and parsed rows are **not uploaded or saved** to Supabase,
and this mode does not compare against prior imports or subtract Synapse 301
issues. Do not treat 105 totals as available-to-issue stock.

The database-backed team import described below is a later release, not the
current quick mode; it requires M22 and a governed production backup/restore.

## Operator workflow

1. Download the contract report and Khlong Toei 105 receipt report from SAP.
2. On any team computer, sign in to Synapse as Planner or Admin and open
   **Import Data**. The default option accepts one prepared `.xlsx` workbook
   containing both `INPUT_รวมสัญญา` and `INPUT_105จริง`. Alternatively select
   the two original SAP `.xlsx` exports separately; the former reviewed CSV
   files remain accepted in that mode. The importer identifies each sheet by
   its supported headers, not by workbook sheet order. No shared Windows
   folder or local refresh script is required.
3. The page checks supported headers, required identifiers, numeric
   quantities, and duplicate business keys. The 14-column Khlong Toei 105
   layout has no unit: an unambiguous unit is inferred from the contract file,
   with material-only matches flagged for explicit review. SAP `SLoc` is
   preserved separately and is **not** treated as `รก.`.
4. Review added, updated, unchanged, and not-in-file counts. Not-in-file rows
   remain in current data; absence does not delete an earlier SAP record.
5. The Planner leaves a draft for the team. An active Admin opens the pending
   draft, reviews changes and warnings, and confirms it. Warnings require an
   explicit acknowledgement. Only then are accepted current rows updated.
   Admins and planners can inspect import history, changed fields, and download
   either complete historical CSV snapshot.

The old four-step Import preview is retained under an explicitly labeled
collapsed section. It does not write to the database and must not be used as
evidence of a production import.

## Record identity and audit

- Contract line: material + purchase order + SAP line item. Rows without a
  material code (for example services) remain in the audit snapshot but cannot
  be matched to stock. Procurement code
  is a many-line grouping field. Contract number is an attribute so a corrected
  number appears as an update, not a second line.
- 105 receipt: material document + material + purchase order + GR/GI slip +
  `รายการ` + `รก.` + posting date. `รายการ` and `รก.` are warehouse/storage
  fields, not a contract installment or lot number. For the 14-column layout,
  quantity also separates rows whose exported identity fields are otherwise
  identical. An amount correction on such a row may appear as a new key and
  needs human review. Ambiguous duplicate keys are rejected.
- The draft and every committed run retain normalized imported rows, source row
  numbers, filenames, SHA-256 file digests, actor, timestamp, and comparison
  summary. Changed rows also retain before and after payloads. Original `.xlsx`
  binary files are **not** archived in Supabase Storage yet; operators should
  keep their SAP exports under the organization's existing records policy.
- `ops.sap_current_rows` is the latest accepted value for each business key.
  `ops.sap_contract_totals` groups contract quantity by procurement code,
  material, and unit, never across incompatible units.

## Deployment order and limits

Apply `supabase/migrations/202610010001_m22_sap_import_history.sql` first,
after the governed production backup and restore drill in `supabase/README.md`.
Verify its RPCs and admin permissions, then deploy the dashboard. The web page
uses authenticated Supabase RPCs and never exposes a service-role key.

This import establishes a governed database landing and history for daily SAP
contracts and 105 receipts. It does **not** automatically rewrite the legacy
`public.contracts` table or activate planning, FIFO, or dispatch calculations.
Those downstream modules must explicitly read the validated current tables
after their matching and reconciliation rules have been approved. This keeps a
new SAP file from silently altering an already locked operational plan.

Movement 105 means receipt in preparation for issue. Movement 301 is generated
from Synapse's own approved issue transactions, **not** imported as a SAP
file. The SAP import does not yet reconcile these staging rows to operational
receipt lots or subtract issue balances; do not display the staging 105 total
as available-to-issue stock until that reconciliation is implemented.
