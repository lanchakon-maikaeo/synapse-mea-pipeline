# SYNAPSE Data Foundation Pipeline

Open-source Python connectors and an idempotent Raw ingestion runner for M02–M03.

## Supported sources

- Excel/OneDrive-synced `.xlsx`
- Local `.csv`
- Public Google Sheets CSV export
- Legacy Apps Script JSON endpoints used by the original SYNAPSE Web App
- Local PDF/DOCX/DOC/TXT discovery for the later document pipeline

Each source is identified by SHA-256. A completed checksum/sheet combination is skipped, and Raw rows use `(batch_id, source_entity, source_row_number)` as the idempotency key.

## Local profile

```bash
PYTHONPATH=pipeline/src python -m synapse_pipeline profile \
  --source "รวมสัญญา.xlsx" \
  --sheet "รวมสัญญา"
```

## Database ingestion

Install the package in an isolated environment, set `DATABASE_URL` outside the repository, then run:

```bash
python -m pip install -e pipeline
synapse-pipeline ingest \
  --source "รวมสัญญา.xlsx" \
  --sheet "รวมสัญญา" \
  --entity contracts
```

The managed Supabase migration already reconciles the existing 6,305 contract rows into Raw, Staging and Core. Use this command for subsequent source versions.

## Import the existing actual operational sources

The Google Drive files contain the same legacy/raw layout already used by the old pipeline. Do not reshape or duplicate them manually. The governed importer downloads the accessible material, warehouse-stock and CMP sources, normalizes them, and publishes each checksum through `Raw → Staging → Core/Analytics`:

```bash
SUPABASE_URL="https://<project>.supabase.co" \
SUPABASE_ANON_KEY="<publishable-key>" \
SUPABASE_ACCESS_TOKEN="<admin-user-token>" \
synapse-pipeline import-legacy-actual --work-dir .synapse-cache/legacy-actual
```

Retries are idempotent. Negative SAP return/adjustment observations remain in Raw lineage and are excluded from non-negative forecast features. Dummy workbooks are never imported through the Actual importer.

## Import the four governed Actual workbooks to Production

The directory importer verifies the package manifest/checksums, preserves every
source row and loads Stock, Usage, Contract and Khlong Toei workbook relations.
When a `MEA_Synapse_Supabase_Production_*` package is present, its checksummed
`source_files/` directory takes precedence over older loose copies.

The current package is `PRODUCTION_APPROVED` for project
`fvdfduuanfrncrwuareb`. The owner-attested exhaustive-source policy records
omitted active VMI district/warehouse pairs as `owner_attested_zero`, never as
direct source observations.

```bash
SUPABASE_URL="https://fvdfduuanfrncrwuareb.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<server-side-service-role-key>" \
synapse-pipeline import-actual-workbooks \
  --data-dir data \
  --attested-by "synapse.mea project owner" \
  --attestation-text "Owner confirms the four checksummed workbooks are complete for the declared Production scope; exhaustive source omission means zero." \
  --change-ticket "SYNAPSE-PROD-20260724" \
  --confirm-actual-data \
  --confirm-production-attestation
```

Run migrations through `202607240022` and the local PostgreSQL contract before
this command. Never place the Service Role key in browser code, logs or the
repository.

## Import the governed UAT fixture

`MEA_VMI_Dummy_Klongtoey.xlsx` may be imported only to the registered Test
environment. Migration `202607240016` labels promoted rows as `TEST_FIXTURE`,
prevents overwrite of Actual rows and records reversible Material before-values.

```bash
SUPABASE_URL="https://<test-project>.supabase.co" \
SUPABASE_ANON_KEY="<publishable-key>" \
SUPABASE_ACCESS_TOKEN="<admin-user-token>" \
synapse-pipeline import-test-fixture \
  --source MEA_VMI_Dummy_Klongtoey.xlsx \
  --confirm-test-environment
```

Only Material gap fields, Packaging profiles, District stock and CMP usage are
promoted. Dummy contracts, vendors, routes, drivers, plans, dispatches and trips
are excluded so they cannot bypass approval, FIFO or immutable movement controls.

## Tests

```bash
PYTHONPATH=pipeline/src python -m unittest discover -s pipeline/tests -v
```
