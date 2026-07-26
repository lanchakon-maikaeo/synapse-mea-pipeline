# SYNAPSE routing runtimes on Vercel

These are new runtimes for the `synapse-mea` Vercel team. They do not deploy,
call, or modify the unrelated `mea-vrp-solver` project.

Create three Git-backed Vercel projects from this repository:

| Project | Root Directory | Purpose |
| --- | --- | --- |
| `synapse-routing-osrm` | `deploy/vercel/osrm` | authenticated OSRM Table + Route preview |
| `synapse-routing-valhalla` | `deploy/vercel/valhalla` | authenticated truck matrix and route evidence |
| `synapse-optimization-worker` | `intelligence` | authenticated on-demand OR-Tools worker |

Both routing images download the immutable Geofabrik Thailand snapshot
`thailand-260725.osm.pbf`, verify its SHA-256 digest, clip it to the reviewed MEA
service-area bounding box (`100.2,13.4,101.0,14.1`), and verify the clipped
input digest before building. The runtime images and build tools are also
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
VALHALLA_TILESET_VERSION=valhalla-bmr-2026-07-26-sha256-fc817b0f2c3ada5e8c2d7b99b6276818bf00c7af9d10ee1fcdddf54cac6f3eea
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
ROUTING_ENGINE_DATA_VERSION=osm-bmr-2026-07-26-sha256-fc817b0f2c3ada5e8c2d7b99b6276818bf00c7af9d10ee1fcdddf54cac6f3eea
ROUTING_ENGINE_AUTH_TOKEN=<matching OSRM proxy token>
OPTIMIZATION_WORKER_URL=https://<synapse-optimization-worker production domain>
OPTIMIZATION_WORKER_AUTH_TOKEN=<matching worker token>
```

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
