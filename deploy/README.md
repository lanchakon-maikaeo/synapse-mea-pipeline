# SYNAPSE deployment profiles

The runtime uses open-source containers and managed Supabase PostgreSQL. Copy `.env.example` to `.env`, set permissions to `600`, then assign credentials outside version control.

## Development

```bash
docker compose --profile development up --build api worker
```

The default port binding is loopback-only. Haversine routing remains disabled unless a test operator deliberately sets `ALLOW_HAVERSINE_FALLBACK=true`.

## Production / self-host

```bash
docker compose --profile production --profile observability up -d --build api worker prometheus
```

Put a TLS reverse proxy or MEA ingress in front of the API, keep `API_CORS_ORIGINS` explicit, generate a random metrics token and restrict the Prometheus port to the operator network. Start the optional Valhalla service with the additional `routing` profile after preparing Bangkok/Metropolitan OSM tiles.

The `backend` network permits outbound TLS because the API and worker must reach managed Supabase. Only explicitly published ports accept inbound host traffic.

## One-shot ingestion

```bash
docker compose --profile tools run --rm pipeline ingest --source /imports/source.xlsx --sheet Sheet1 --entity contracts
```

See `docs/OPERATIONS_RUNBOOK.md` for readiness checks, backup, restore drill and rollback.
