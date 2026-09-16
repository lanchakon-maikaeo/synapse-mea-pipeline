# SYNAPSE routing runtimes on Vercel

These are new runtimes for the `synapse-mea` Vercel team. They do not deploy,
call, or modify the unrelated `mea-vrp-solver` project.

Create four Git-backed Vercel projects from this repository:

| Project | Root Directory | Purpose |
| --- | --- | --- |
| `synapse-routing-osrm` | `deploy/vercel/osrm` | authenticated OSRM Table + Route preview |
| `synapse-routing-valhalla` | `deploy/vercel/valhalla` | authenticated truck matrix and route evidence |
| `synapse-optimization-worker` | `intelligence` | authenticated on-demand OR-Tools worker |
| `synapse-map-tiles` | `deploy/vercel/map-tiles` | self-hosted BMR PMTiles basemap |

Both routing images use the repository-pinned BMR extract
`bmr-2026-08-20.osm.pbf` (SHA-256
`b41ce7d5c5f2782fe4af222efede4edab366822cec0c3ed47dbc5c503b429351`).
It was clipped to the reviewed MEA service-area bounding box
(`100.2,13.4,101.0,14.1`) from Geofabrik's `thailand-260820.osm.pbf`
(SHA-256 `44a9d2917210c3ca6ada097d4cb8e55401b95779d2b4317b716ee0af34268553`).
Keeping the bounded extract in each Vercel build context prevents dated
upstream snapshots from disappearing between deployments; Git stores the two
identical copies as one blob. Runtime images and build tools remain
digest-pinned. The source data remains subject to the OpenStreetMap ODbL; map
UI attribution remains `© OpenStreetMap contributors`.

## Project environment

Generate independent high-entropy values for every token. Never expose them as
`NEXT_PUBLIC_*` variables.

`synapse-routing-osrm`:

```text
ROUTING_PROXY_AUTH_TOKEN=<random server-only token>
VERCEL_SUPPORT_LARGE_FUNCTIONS=1
```

`synapse-routing-valhalla`:

```text
ROUTING_PROXY_AUTH_TOKEN=<different random server-only token>
VERCEL_SUPPORT_LARGE_FUNCTIONS=1
```

`synapse-optimization-worker`:

```text
DATABASE_URL=<production Supabase pooler URL with sslmode=require>
WORKER_API_KEY=<different random server-only token>
WORKER_ID=vercel-worker-01
VALHALLA_URL=https://<synapse-routing-valhalla production domain>
VALHALLA_AUTH_TOKEN=<matching Valhalla proxy token>
VALHALLA_TILESET_VERSION=valhalla-bmr-2026-08-20-sha256-b41ce7d5c5f2782fe4af222efede4edab366822cec0c3ed47dbc5c503b429351
VALHALLA_OSM_CHANGESET=0
VERCEL_SUPPORT_LARGE_FUNCTIONS=1
```

The worker also accepts `POSTGRES_URL_NON_POOLING` and then `POSTGRES_URL` when
the Supabase Marketplace integration injects those values; explicit
`DATABASE_URL` takes precedence.

`mea-synapse-production`:

```text
ROUTING_ENGINE_URL=https://<synapse-routing-osrm production domain>
ROUTING_ENGINE_PROFILE=driving
ROUTING_ENGINE_DATA_VERSION=osm-bmr-2026-08-20-sha256-b41ce7d5c5f2782fe4af222efede4edab366822cec0c3ed47dbc5c503b429351
ROUTING_ENGINE_AUTH_TOKEN=<matching OSRM proxy token>
OPTIMIZATION_WORKER_URL=https://<synapse-optimization-worker production domain>
OPTIMIZATION_WORKER_AUTH_TOKEN=<matching worker token>
NEXT_PUBLIC_MAP_TILE_URL=https://synapse-map-tiles.vercel.app/bmr.pmtiles
NEXT_PUBLIC_MAP_ATTRIBUTION=&copy; OpenStreetMap contributors &middot; Protomaps
```

The basemap is the bounded vector extract built from the Protomaps 2026-09-15
daily build. New images seed from the immutable GitHub release asset and require
SHA-256
`e7ba2e62b8661e4f32e0dca7c1b4c7bb7a878fdfcae2a5b20379ac17ef3d7e45`,
so an upstream daily-build expiry or unexpected artifact change fails closed.
The image also verifies the archive structure and exact dataset metadata; the
service computes the deployed artifact SHA-256 for its health response and ETag,
and supports browser byte-range requests. It does not proxy or fall back to the
OpenStreetMap Foundation public tile service.

The dashboard refreshes an attested Valhalla heartbeat when an authenticated
operator reads transport readiness. Before queueing an optimization job it
refreshes that heartbeat again, lets the database enforce the exact locked-plan
gate, and invokes one worker iteration only after the idempotent job is accepted.

## Verification

Public health endpoints disclose no routing data and require no token:

```bash
curl -fsS https://<osrm-domain>/health
curl -fsS https://<valhalla-domain>/health
curl -fsS https://<worker-domain>/health
```

Engine and worker operations require their matching bearer token. Verify OSRM
Table + Route, Valhalla `/status`, `/sources_to_targets` and `/route`, then call
the worker heartbeat endpoint before the authenticated dashboard canary. Do not
create or lock a fictional replenishment plan merely to make the canary pass;
use an existing business-approved eligible plan or record the gate as blocked.

On a new container, authenticated routing requests wait up to 25 seconds for
the colocated engine to become ready. Public `/health` remains non-blocking and
returns 503 until the engine is ready, so platform health probes can observe the
cold-start state without exposing engine operations.
