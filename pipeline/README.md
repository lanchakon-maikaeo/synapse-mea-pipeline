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

Retries are idempotent. Negative SAP return/adjustment observations remain in Raw lineage and are excluded from non-negative forecast features. Dummy workbooks are not imported.

## Tests

```bash
PYTHONPATH=pipeline/src python -m unittest discover -s pipeline/tests -v
```
