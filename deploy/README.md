# SYNAPSE deployment profiles

Production Operations v1 is deployed as the tracked `dashboard/` application
on Vercel plus managed Supabase PostgreSQL/Auth. Forecasting, routing and RAG
are excluded; no worker, Valhalla or document indexer belongs in the production
release command.

## Production

1. Run `make workspace-ci`.
2. Apply Supabase migrations with
   `scripts/deploy_database_migrations.sh`, using an off-repository backup
   directory and explicit deployment confirmation.
3. Deploy the verified `main` commit to `spaiss-6/synapse-mea` with Root
   Directory `dashboard`.
4. Run the authenticated read-only deployment smoke suite.
5. Preserve backup, release, CI and Vercel evidence.

The complete commands and rollback containment procedure are in
`docs/PRODUCTION_OPERATIONS_V1.md`.

## Local dashboard

```bash
cd dashboard
npm ci
npm run dev
```

Use public Supabase browser values only. Never store `service_role`, a database
URL or JWT secret in a `NEXT_PUBLIC_*` variable.

## Optional compatibility API

The FastAPI container is retained for local integration/compatibility work. It
is not the Vercel production runtime.

```bash
docker compose --profile development up --build api
```

The optional Prometheus profile monitors that compatibility API:

```bash
docker compose --profile observability up -d --build api prometheus
```

Keep the port loopback-only unless a TLS MEA ingress and explicit CORS policy
are configured.

## One-shot ingestion

```bash
docker compose --profile tools run --rm pipeline ingest \
  --source /imports/source.xlsx --sheet Sheet1 --entity contracts
```

The `intelligence` and `routing` Compose profiles are historical experiments.
They are deliberately absent from production instructions and CI image builds.
