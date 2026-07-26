# M13 Production Activation — 26 July 2026

Record of the work that resolved the `Transport API path not found` failure
(request `18f64262-d741-4f37-96a6-02ca12355c4e`) and brought Supabase Production
to the M13e head.

## Root cause

The dashboard and API were deployed from a tree containing M13c–M13e, but
Supabase Production was still at head `202607250002` (M13b). The deployed
`public.m13_transport_dispatch` was the 8,210-character M13b build, which routed
only:

`warehouses` · `geo` · `vehicles` · `route-matrix` · `dispatch-queue` ·
`trips` · `trips/{id}/status`

`dashboard/app/transport.tsx:447` issues `GET /v1/transport/readiness` as the
first call in its `Promise.all`. That path only exists from M13c, so the
dispatcher fell through to its terminal
`m09_error(404, 'not_found', 'Transport API path not found', …)`. The whole
transport screen failed on its first request. `optimize` and `optimization-jobs`
were unreachable for the same reason.

This was a **deployment-order defect**, not a code defect: web and database were
promoted independently and drifted three migrations apart.

## Changes applied to Supabase Production `fvdfduuanfrncrwuareb`

| Migration | Module | Applied (UTC) |
|---|---|---|
| `202607250003` | M13c | 2026-07-26 06:33:55 |
| `202607250004` | M13d | 2026-07-26 06:40:38 |
| `202607250005` | M13e | 2026-07-26 10:51:31 |

Each file was applied as a single transaction, byte-verified against its source
SHA-256 before execution:

- M13c `cccc9c0a8ac5493fdca102dd41a1353c0f10932587f594ef2b4986ec191964fd`
- M13d `bd3bcc1a0390767d2dd812fdb85f30b8a061f396ed46b055053effcae1252896`
- M13e `0da0a89187f7fcc45db23d73c0d219bc4d78b9a7f516b3c7591044b4f55440bd`

### Data change required to clear an M13c guard

M13c's first attempt rolled back cleanly on its own fail-closed guard:

```
ERROR: M13c cannot enforce vehicle availability:
       duplicate active vehicle/day assignments exist
```

It builds a unique index of one active trip per vehicle per day. Two trips
violated it — the only two trips in the database, both created minutes after the
original M13/M13b deploy, both `planned`, both with `replenishment_plan_id`
null and no `depart_time`:

| trip_code | vehicle | date | created (UTC) |
|---|---|---|---|
| `TRP-20260725-462949` | V707 | 2026-07-25 | 04:24:56 |
| `TRP-20260725-b321ca` | V707 | 2026-07-25 | 04:26:39 |

Both were transitioned `planned → cancelled` with an explanatory note, on owner
approval. **No rows were deleted**; the audit history is intact.

### Coordinate provenance verified

`data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv` hashes to
`fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a`, which is
exactly the checksum M13c records as the source of its coordinates. The 18
district coordinates and the WH-MMBP depot (`13.55760333, 100.7707226`) in
Production are therefore traceable to the owner-supplied file.

## Verification

Authenticated dispatcher probe (admin JWT claims, request `verify-20260726`):

| Endpoint | Before | After |
|---|---|---|
| `GET /v1/transport/readiness` | 404 `not_found` | **200** |
| `GET /v1/transport/geo` | 200 | 200 |
| `GET /v1/transport/vehicles` | 200 | 200 |
| `GET /v1/transport/warehouses` | 200 | 200 |
| `GET /v1/transport/route-matrix` | 200 | 200 |
| `GET /v1/transport/dispatch-queue` | 200 | 200 |
| `GET /v1/transport/trips` | 200 | 200 |
| `GET /v1/transport/does-not-exist` | 404 | 404 (correct) |

Live web target `https://mea-synapse-production.vercel.app`:

- `/api/health` → `{"status":"ok","service":"synapse-api","version":"v1"}`
- `/api/health/ready` → `operational_ready: true`, `readiness_status: operational`,
  `project_ref: fvdfduuanfrncrwuareb`
- `/api/openapi.json` → SYNAPSE API `1.3.0`, 48 paths

Database posture: 0 tables without RLS; all 59 `security definer` functions pin
an explicit `search_path`.

## Initial post-migration state — before owner evidence import

Immediately after M13e, `GET /v1/transport/readiness` answered truthfully instead
of 404, but the source-readiness gate was still closed:

```json
{
  "route_ready": false,
  "route_readiness_status": "blocked_verified_depot_missing_canonical_origin",
  "optimization_worker_ready": false,
  "trip_persistence_ready": false,
  "trip_persistence_status": "blocked_route_plan_to_trip_activation_not_configured",
  "verified_district_geocodes": 18,
  "verified_warehouse_geocodes": 1,
  "quarantined_geocodes": 1,
  "verified_depots_missing_canonical_origin": 1,
  "optimization_eligible_plan_ids": [],
  "monetary_toll_estimate_available": false,
  "verified_current_toll_tariffs": 0
}
```

Per-depot:

| Depot | Geocode | Canonical warehouse | Route eligible |
|---|---|---|---|
| คลองเตย | quarantined (legacy seed) | `WH-KT` | no |
| เมืองใหม่ | **verified** | *missing* | no |
| บางพลี | missing | *missing* | no |

Fleet: 6 vehicles, all `vehicle_mapping_status = unmapped`,
`availability_evidence_status = unknown`. M13e refused to map the illustrative
seed data, as designed.

## Owner-attested evidence import (26 July 2026, later same day)

Source: `data/fleet_evidence/MEA_Fleet_Evidence_Template.xlsx`,
SHA-256 `89c8d4bdfb39c17fb1d634deea221a058fc9548b7c5d2cf83438cd2678b1517b`.
Approved by the admin account `f3d9caa2-9549-42a1-a63d-becf2bf83f08` under
ticket `OWNER-ATTEST-20260726-ADMIN`.

**Depots.** Created canonical warehouses `WH-MN` (คลังเมืองใหม่) and `WH-BP`
(คลังบางพลี) with matching `core.locations` WAREHOUSE rows, geocoded all three
depots in `core.location_geocodes`, and linked every
`core.transport_warehouses.canonical_warehouse_id`. The คลองเตย depot geocode
was moved `quarantined → verified` on the owner's attestation that the depot
gate and the district office share a location.

| Depot | Canonical | Coordinate | Geocode |
|---|---|---|---|
| เมืองใหม่ | `WH-MN` | 13.55760333, 100.77072260 | verified |
| บางพลี | `WH-BP` | 13.64160000, 100.71325000 | verified |
| คลองเตย | `WH-KT` | 13.72156000, 100.55539000 | verified |

**Fleet.** `V707`→`707` and `V708`→`708` are mapped, capacity-verified and
available for 30 days. `core.vehicles` capacity for both was aligned to the
submitted figures (5000 kg / 24.2 m³ / 12 pallets), replacing the earlier
`ALGORITHM.md` values of 10000 kg / 40 m³ and 6000 kg / 24 m³.

> **Provenance caveat.** These capacity figures are recorded as
> **owner-asserted**, not measured. No weighbridge record, vehicle registration
> book or asset register was supplied, and the workbook left `plate`,
> `asset_code`, `driver_employee_ref` and `shift` blank. `V701`, `V702`, `V703`
> and `V706` were not submitted and remain `unmapped` / `unknown`.

**Resulting readiness:** `route_ready: true`, `route_readiness_status: "ready"`,
`quarantined_geocodes: 0`, `verified_warehouse_geocodes: 3`,
`verified_depots_missing_canonical_origin: 0`.

## Remaining blockers, in dependency order

~~1. Canonical warehouse for WH-MMBP~~ — **cleared**, see the evidence import
above. `route_readiness_status` is now `ready`.

1. **Routing services — the current wall.** No `ROUTING_ENGINE_URL`
   (OSRM-compatible) and no private Valhalla truck profile are deployed, and the
   OR-Tools worker is not running. Until these exist, no road route can be
   computed at all, whatever the data says. Haversine is never an allowed
   fallback.
2. **Locked replenishment plan.** `core.replenishment_plans` and
   `ops.replenishment_runs` are both empty, so `optimization_eligible_plan_ids`
   is `[]` and `optimization_worker_status` reports
   `blocked_no_exact_locked_plan_with_verified_depot_and_fleet`. The inputs are
   present (10,093 stock snapshots, 8,738 usage rates, 5,466 materials, 6,305
   contract items; latest stock 2026-07-21), so a run can be created via
   `POST /v1/replenishment/runs` — but that issues a real weekly plan to
   districts and is a business decision, not a technical one.
3. **Packaging/UOM.** `core.material_packaging` is empty, so OR-Tools cannot
   verify weight/volume/pallet feasibility per line.
4. **Remaining fleet.** `V701`, `V702`, `V703`, `V706` are still unmapped;
   `V702`/`V703`/`V706` sit at เมืองใหม่ and `V701` at บางพลี, both of which now
   have canonical warehouses, so they only need evidence rows.
5. **Toll tariffs.** Schema exists; 0 verified EXAT/BEM/DOH/M-Flow tariffs, so no
   baht figure can be shown.
6. **route-plan → transport-trip activation** contract is still unimplemented;
   `POST /v1/transport/trips` answers 410 by design and
   `trip_persistence_status` stays
   `blocked_route_plan_to_trip_activation_not_configured`.

## Documentation corrected in this pass

References to the retired host `synapse-mea.vercel.app` (which now returns an
empty response) now cite `mea-synapse-production.vercel.app`. Stale claims that
the live head was M24, that the API had 37 paths, and that M13–M13e were
unapplied local candidates were corrected across the root and operational
documentation. The deployment smoke script default was corrected to probe the
same canonical host.

## Not done

No controlled release workflow was run: no staging artifact promotion, no
pre-migration database backup, no OIDC deployment, no authenticated canary.
Migrations were applied directly to Production via the Supabase management API
under explicit owner approval. `scripts/deploy_database_migrations.sh` remains
the governed path and has still never been executed against a live target.
