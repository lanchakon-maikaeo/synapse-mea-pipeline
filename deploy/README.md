# SYNAPSE deployment profiles

Production Operations v1 is deployed as the tracked `dashboard/` application
on Vercel plus managed Supabase PostgreSQL/Auth through the verified M24
baseline. The M13 smart-logistics code, map/road preview, OR-Tools worker and
private Valhalla profile are local release candidates; none is claimed as
migrated, promoted or active on the live target. RAG remains excluded.

## Production

Use the exact approved release commit. The guarded script applies every pending
migration in that checkout; running the current M13 candidate checkout against
the M24 live database would expand scope and is prohibited without the separate
smart-logistics release approval.

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

The manual `.github/workflows/production-release.yml` workflow builds one
commit-addressed dashboard/worker bundle, SBOM and checksums, then uses protected
`staging` or `production` environments. It is intentionally inert until the
environment has required reviewers and these contracts:

- variables: `RELEASE_PROTECTION_CONFIRMED=true`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_API_BASE_URL`,
  `NEXT_PUBLIC_MAP_TILE_URL`, `NEXT_PUBLIC_MAP_ATTRIBUTION`,
  `SMOKE_BASE_URL`, digest-bearing `ROUTING_ENGINE_DATA_VERSION` and
  `VALHALLA_TILESET_VERSION`,
  nonnegative `VALHALLA_OSM_CHANGESET`, OIDC audiences,
  optional `ENABLE_GITHUB_ATTESTATIONS=true`, and the registered
  Supabase/backup values;
- secrets: Supabase publishable key, smoke access token, database credential
  and HTTPS release-orchestrator/routing-smoke hook URLs only on jobs that need
  them. The hooks authenticate GitHub's short-lived OIDC identity; there is no
  long-lived release-orchestrator bearer token;
- a dedicated `self-hosted, linux, synapse-release` runner for guarded database
  backup/migration;
- an idempotent HTTPS orchestrator that verifies the requested Git SHA and
  artifact digest before reporting a component `ready`.

Both dataset IDs must match the canonical pattern
`^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$`. The suffix is the reviewed
SHA-256 digest of the exact controlled road-graph/tile artifact or its immutable
signed build manifest. A date, release label, the word `sha256`, or a checksum
of the label itself is not sufficient evidence. Staging and production
promotion compare these complete IDs exactly.

The worker build uses a digest-pinned Python base image, blocks high/critical
OS and library findings with Trivy, and packages its vulnerability report,
dependency lock and image inspection with the dashboard SBOM, bundle checksums
and optional signed attestations as release evidence.

Use `build-only` first. A release requires the target-specific confirmation
phrase and environment approval; no workflow added here has been executed
against a live target.

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

Prometheus is pinned as `tag@sha256` to the registry's multi-architecture
manifest-list digest. To update it, inspect the intended immutable tag first:

```bash
docker buildx imagetools inspect prom/prometheus:<reviewed-tag>
```

Review the release notes, publisher, supported platform manifests and displayed
manifest-list digest; then update the tag and digest together in
`docker-compose.yml`, review the diff and rerun Compose/configuration and image
security checks. Do not copy a platform-specific child digest or move a floating
tag without review.

Keep the port loopback-only unless a TLS MEA ingress and explicit CORS policy
are configured.

## One-shot ingestion

```bash
docker compose --profile tools run --rm pipeline ingest \
  --source /imports/source.xlsx --sheet Sheet1 --entity contracts
```

The `intelligence` and `routing` Compose profiles are the staging harness for
the guarded smart-logistics worker. They are built/tested in CI but are not
started by the Vercel release. Promote them only after the geographic-data,
road-engine and operational smoke gates in
`docs/SMART_LOGISTICS_PRODUCTION.md` pass. The protected worker canary must be
fully served (`solver_status=succeeded`, `unserved_stop_count=0`); a partial
solver result blocks promotion.
