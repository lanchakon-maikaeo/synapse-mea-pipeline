# SYNAPSE deployment profiles

Production Operations v1 is deployed as the tracked `dashboard/` application
on Vercel plus managed Supabase PostgreSQL/Auth through the verified M24
baseline. The M13 smart-logistics code, map/road preview, OR-Tools worker and
private Valhalla profile are local release candidates; none is claimed as
migrated, promoted or active on the live target. RAG remains excluded.

The isolated Vercel container layout for the new governed OSRM, Valhalla and
on-demand OR-Tools runtimes is documented in `deploy/vercel/README.md`. Those
projects belong to the `synapse-mea` team and are intentionally independent of
the unrelated `mea-vrp-solver` project.

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

## Road-preview engine (OSRM)

The dashboard `/v1/transport/optimize` road preview needs an OSRM-compatible
Table + Route engine at `ROUTING_ENGINE_URL`. The `routing` Compose profile now
ships a self-hosted `osrm` service (digest-pinned `osrm-backend`) so the preview
no longer depends on the development-only public community host.

Build the graph once (downloads a pinned OSM extract, records its digest, and
runs extract → partition → customize into the `osrm-data` volume; the
multi-gigabyte artifacts stay in the Docker volume, never in the repository):

```bash
scripts/prepare_osrm_graph.sh
```

On a memory-constrained Docker host, building the full Thailand graph can exceed
the VM's RAM (`osrm-extract` is OOM-killed at its connectivity step). Set
`OSRM_CLIP_BBOX` to build a regional graph instead — for example the Bangkok
Metropolitan Region, which is MEA's service area:

```bash
OSRM_CLIP_BBOX=100.2,13.4,101.0,14.1 scripts/prepare_osrm_graph.sh
```

The clip runs `osmium extract` (image overridable via `OSRM_OSMIUM_IMAGE`) and
binds the data version to the clipped extract's digest.

The script prints the canonical `ROUTING_ENGINE_DATA_VERSION` (the served
graph's `sha256`) to bind into a production release. Then start the engine and point the
dashboard at it for local development:

```bash
docker compose --profile routing up -d osrm
# dashboard/.env.local
#   ROUTING_ENGINE_URL=http://localhost:5000
```

On macOS, port 5000 is taken by the AirPlay Receiver (requests return
`403 AirTunes`). Either disable *System Settings → General → AirDrop & Handoff →
AirPlay Receiver*, or publish OSRM on another port and match it:

```bash
OSRM_PORT=5050 docker compose --profile routing up -d osrm
# dashboard/.env.local
#   ROUTING_ENGINE_URL=http://127.0.0.1:5050
```

Loopback HTTP is accepted only outside production. A production release must
front this engine with a controlled HTTPS origin, supply a reviewed immutable
`ROUTING_ENGINE_DATA_VERSION`, and pass the smart-logistics gates in
`docs/SMART_LOGISTICS_PRODUCTION.md`; the public community OSRM host is never a
production fallback.

The `intelligence` and `routing` Compose profiles are the staging harness for
the guarded smart-logistics worker. They are built/tested in CI but are not
started by the Vercel release. Promote them only after the geographic-data,
road-engine and operational smoke gates in
`docs/SMART_LOGISTICS_PRODUCTION.md` pass. The protected worker canary must be
fully served (`solver_status=succeeded`, `unserved_stop_count=0`); a partial
solver result blocks promotion.
