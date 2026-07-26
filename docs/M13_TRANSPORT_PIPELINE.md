# M13 — Transport / Route Dispatch Pipeline

> **Release status (26 July 2026): local candidate only.** The tracked M13–M13e
> migrations, dashboard changes and worker have not been applied or deployed to
> the live Supabase/Vercel Production environment. The last verified live
> database baseline remains M24 (`202607240024`). Passing local tests is release
> evidence for a candidate, not proof of live activation.

Connects the Transport module to Supabase as a first-class, governed pipeline,
following the same conventions as m09/m10/m11 and the target architecture in
`SYNAPSE_Open_Source_Pipeline_Improvement.md` (§4 M08, §9 Route Optimization,
Deployment Profile A — Free PoC).

## Scope and current safety status

M13 began as deterministic, worker-free route dispatch: reference masters + a
route-leg matrix + transactional trips, served through one security-definer
dispatcher. M13c–M13e turn that prototype into a fail-closed candidate: the web
preview may use a controlled OSRM-compatible road engine, while the operational
worker uses a verified Valhalla truck matrix, OR-Tools and immutable per-vehicle
road evidence.

The original seed coordinates and radial cost matrix are **legacy candidates,
not production route evidence**. They must not be used for road optimization
until a data owner verifies loading-gate coordinates. Monetary toll also remains
unavailable until a governed Thai tariff dataset is installed. See
`docs/SMART_LOGISTICS_PRODUCTION.md` for the target contract.

## Migration chain

The additive candidate chain, in order, is:

1. `202607250001_m13_transport_pipeline.sql` — original transport masters,
   legacy radial references, trips and dispatcher.
2. `202607250002_m13b_transport_replenishment_link.sql` — replenishment-plan
   linkage and dispatch queue.
3. `202607250003_m13_transport_hardening.sql` — authoritative coordinates,
   exact-plan preflight, readiness and fail-closed trip creation.
4. `202607250004_m13d_operational_integrity.sql` — candidate geocodes,
   immutable operational inputs, legacy-trip quarantine and stop provenance.
5. `202607250005_m13e_route_evidence.sql` — explicit fleet provenance,
   immutable Valhalla road evidence and fail-closed route review.

These are tracked migrations 28–32 in a clean workspace build. None is claimed
as applied to the live M24 Production database in this document.

Masters (schema `core`, RLS-locked, served only via the dispatcher):

- `core.transport_warehouses` — 3 legacy transport warehouse references
  (คลองเตย, บางพลี, เมืองใหม่); a reference is not a verified loading gate
- `core.transport_district_geo` — 18 checksum-traced district coordinates, the
  coordinate-verified Mueang Mai Bang Phli procurement record (`WH-MMBP`), and
  one quarantined legacy Khlong Toei depot candidate
- `core.transport_vehicles` — legacy 6-wheel fleet references; declared driver,
  capacity and fuel fields are not operational evidence until M13e provenance
  and current availability are supplied
- `core.transport_route_legs` — 54 warehouse→district legs (distance, toll, time,
  unload params); these remain legacy illustrative references, not road evidence

Transactional (schema `ops`):

- `ops.transport_trips` — historical planned/dispatched/completed/cancelled trip
  records. M13d marks existing evidence as `quarantined_legacy`; those records
  may be cancelled but may not be dispatched, retried or completed.

Analytics views: `analytics.v_transport_vehicle_status`,
`analytics.v_transport_route_matrix`, `analytics.v_transport_trip_summary`.

RLS: all tables `enable row level security` and revoke direct access from
`public/anon/authenticated`; reads and writes flow only through the
`security definer` dispatcher (owner = postgres bypasses RLS), matching the m09
pattern. No business data is exposed to the browser except through the API.

## API — `/v1/transport/*`

Dispatcher `public.m13_transport_dispatch(text,text,jsonb,jsonb,text)`; the
dashboard same-origin API (`app/api/[...path]/route.ts`) routes any path under
`/v1/transport/` to it (alongside m09/m10/m11).

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/v1/transport/warehouses` | authenticated | Active transport references |
| GET | `/v1/transport/geo` | authenticated | District/warehouse map nodes |
| GET | `/v1/transport/vehicles` | authenticated | Active fleet references and evidence state |
| GET | `/v1/transport/route-matrix?warehouse=` | authenticated | Legacy radial references (optionally filtered) |
| GET | `/v1/transport/readiness` | authenticated | Coordinate, canonical-origin, tariff, compatible-worker and trip-persistence gates; admin/planner also receive current plan-scoped `optimization_eligible_plan_ids` |
| GET | `/v1/transport/dispatch-queue` | authenticated | Positive locked demand grouped by exact replenishment plan and district |
| GET | `/v1/transport/trips?limit=&status=` | authenticated | Trip history |
| POST | `/v1/transport/optimize` | admin/planner | Validate a locked latest plan, canonical depot origin and exact positive locked stops; return canonical coordinates for real-road preview |
| POST | `/v1/transport/optimization-jobs` | admin/planner | Queue a Valhalla-only operational solve for the exact locked latest plan; request-ID idempotent per requester |
| GET | `/v1/transport/optimization-jobs/{uuid}` | requesting planner or admin | Read job/route-plan status; planners see their own jobs, admins may inspect any |
| POST | `/v1/transport/trips` | admin/planner | `410 road_route_evidence_not_persistable`; M13e stores route-plan evidence but does not implement the separate reviewed route-plan→trip activation contract |
| POST | `/v1/transport/trips/{uuid}/status` | admin/planner | Legal transition for a verified trip; a `quarantined_legacy` trip may only be cancelled |

`POST /v1/transport/optimize` ignores client coordinates and returns only
checksum-traced canonical coordinates. `avoidTolls` must be a JSON boolean.
Client distance, duration, toll and geometry are never accepted for persistence.
Existing trip history remains readable. Legacy trip dispatch, retry and
completion fail with `409 road_evidence_not_verified`; cancellation remains the
only permitted legacy transition.

## M13c — Authoritative geo and road-evidence safety

`supabase/migrations/202607250003_m13_transport_hardening.sql` registers version
`202607250003`. The accepted coordinate source is
`data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv`, SHA-256
`fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a`.

- The 18 coded records map stably from route refs `5501, 5601, …, 8001` to
  canonical district IDs `5501–5518`, with exact physical CSV row provenance.
- The blank-code final record is the coordinate-verified transport record
  `WH-MMBP`, with lossless coordinates `13.55760333, 100.77072260`; it is not
  yet an approved canonical loading-gate origin.
- The same 18 district coordinates are synchronized to
  `core.location_geocodes` for M08; existing time windows and service minutes
  are preserved.
- Khlong Toei remains quarantined. Bang Phli has no warehouse geocode because
  the CSV identifies it only as a district. `WH-MMBP` is not route-eligible
  until an active canonical `core.warehouses`/`core.locations` origin is
  configured—no plant or storage identifier is invented.
- Optimization requires a UUID `replenishment_plan_id`, a locked latest active
  lineage version, a canonical depot matching `origin_location_id`, and positive
  locked demand for every stop in that exact plan.
- The dispatch queue resolves its depot only through the plan's
  `origin_location_id` and the active canonical location/warehouse mapping. It
  never chooses a depot from legacy route-leg distance. Its
  `suggested_distance_km` is therefore null until authenticated road evidence is
  available, and a quarantined or unmapped origin remains ineligible.
- M13c labelled every route-matrix row
  `legacy_illustrative_not_road_evidence` and gated eligibility on canonical,
  verified endpoints. M13d supersedes that interim rule: `route_eligible` is
  always false and reports endpoint readiness in a separate field.
- Trip creation fails closed with HTTP 410 because the legacy radial matrix
  cannot be persisted as if it were an authenticated OSRM/road result.

## M13d — Operational integrity

`supabase/migrations/202607250004_m13d_operational_integrity.sql` registers
version `202607250004` and closes evidence gaps without promoting legacy data:

- geocode state is exactly `candidate`, `verified` or `quarantined`, with
  candidate-provider fields kept separate from owner verification;
- every legacy radial-matrix row has `route_eligible=false`; endpoint geocode
  readiness is exposed separately and never turns radial metrics into road
  evidence;
- completed usage/stock observations, replenishment input snapshots/hashes and
  run-attempt audit are immutable/append-only;
- route stops preserve exact coordinate source checksum, source row and
  eight-decimal precision; and
- historical trips default to `quarantined_legacy` and may only be cancelled.

## M13e — Fleet and immutable real-road evidence

`supabase/migrations/202607250005_m13e_route_evidence.sql` registers version
`202607250005`. It deliberately seeds **no** transport-to-canonical vehicle
mapping and promotes no legacy capacity or availability claim.

Approval requires all of the following to agree exactly:

- owner-approved canonical vehicle mapping, verified weight/pallet capacity and
  non-expired availability evidence, each with attributable provenance;
- the exact locked latest replenishment plan and all positive locked demand;
- a verified Valhalla matrix for the canonical origin and served stops;
- successful OR-Tools output with no unserved stops;
- one immutable truck-profile Valhalla `LineString` per planned vehicle,
  ordered depot→stops→depot waypoints, road distance/duration, engine and
  canonical digest-bound tileset ID, secondary numeric operator dataset ID,
  status/request/response hashes and current fleet snapshots; and
- plan/vehicle totals equal to the persisted road evidence.

`analytics.v_route_plan_geojson` emits only evidenced road `LineString` features
and verified stop points; it never manufactures straight connectors. The
Valhalla `has_toll` flag may be null and is not a Thai-baht tariff. M13e does not
enable direct transport trip creation: reviewed route-plan→trip activation
remains a separate fail-closed gate.

The M13e dispatcher queues operational work only for admin/planner callers when
Production writes are enabled and the exact locked latest plan has a verified
canonical origin, stops and eligible fleet. `matrix_source` is fixed to
`valhalla`; the caller's bounded request ID is the per-user idempotency key.
Readiness is data- and heartbeat-aware: it remains blocked for locked
operational writes, missing exact-plan/depot/fleet evidence or no healthy worker
heartbeat in the last ten minutes. A ready queue reports
`ready_valhalla_exact_locked_plan_queue`, while trip persistence independently
reports `blocked_route_plan_to_trip_activation_not_configured`.

For `admin`/`planner`, readiness returns `optimization_eligible_plan_ids` only
when the global route and compatible-worker gates are ready. Each UUID is scoped
to the exact locked latest plan and its current origin, stop, packaging and fleet
evidence. The UI must require the selected plan to appear in this attested list;
the POST rechecks the plan and `ops.has_recent_compatible_route_worker()` so a
stale or forged client cannot queue work.

A compatible `healthy` heartbeat proves more than process liveness: the worker
has validated a controlled non-community Valhalla URL and `/status`, truck
profile, exact canonical `VALHALLA_TILESET_VERSION`, numeric
`VALHALLA_OSM_CHANGESET`/operator dataset ID, engine/tile timestamp, status
response SHA-256 and validation time. The numeric dataset ID must match status
and route responses, but is secondary metadata rather than cryptographic proof;
the digest-bound tileset and recorded hashes provide cryptographic binding.

## Frontend

`dashboard/app/transport.tsx` is API-first and has no demo-data fallback. Empty
live queues render an explicit zero state; API/configuration errors remain
visible. The Leaflet map draws a route only from returned road GeoJSON, never a
dashed straight-line approximation. Community OpenStreetMap tiles are allowed
for local development only; Production requires an approved HTTPS tile template
and visible attribution.

The UI is role-aware: only `admin`/`planner` see the planning/queue controls;
other roles retain read-only transport views while authorization remains
enforced by the dispatcher. Queue state is resumable within the browser session
and keyed by actor UUID + plan UUID. It stores only opaque request/job IDs and
status, reuses the same `X-Request-ID` when a submitting response was lost,
polls the actor-owned job, and requires a new ID after failed/cancelled terminal
state. JWTs, profiles, payloads and route evidence are never stored there.

For a custom Production Supabase domain, the same-origin server must pin the
exact HTTPS origin in server-only `SUPABASE_ALLOWED_ORIGIN`; standard
20-character `*.supabase.co` project origins need no override. Credentials,
paths, queries, fragments, loopback origins and client-visible pins are rejected.

## CI/CD

- Contract: `supabase/tests/m13_transport_verify.sql` covers M13–M13d and
  `supabase/tests/m13e_route_evidence_verify.sql` covers M13e's fleet, matrix,
  immutable evidence, approval and truthful GeoJSON gates. Both run from
  `scripts/test_supabase_migrations_local.sh` after the M24 verification.
- `supabase/tests/local_schema_contract_verify.sql` migration count updated
  to 32.
- Run locally / in CI: `make database-contract-local` (clean PostgreSQL 17 applies
  all migrations in filename order and runs every contract verify) and
  `cd dashboard && npm run verify` (lint + build + rendered/DB contract).

These commands are release prerequisites. They do not imply that the migrations,
worker, routing services or web candidate have been deployed.

## Activation blockers and release order

Do not apply or deploy M13 merely because local tests pass. Production remains
blocked until owners provide and approve:

- a canonical warehouse/location mapping for the verified `WH-MMBP` coordinate
  (or another verified physical loading-gate origin); Khlong Toei stays
  quarantined and no mapping is inferred;
- canonical vehicle identity, measured weight/pallet capacity, driver/shift and
  current availability evidence;
- physical packaging/UOM evidence for routed materials;
- controlled Production tile, OSRM-compatible preview and private Valhalla truck
  endpoints bound to IDs matching
  `<lowercase-label>-sha256-<64 lowercase hex>`, plus the expected nonnegative
  secondary Valhalla operator dataset ID (`VALHALLA_OSM_CHANGESET`);
- governed EXAT/BEM/DOH/M-Flow tariff and road/plaza mapping if a monetary toll
  is to be displayed; and
- protected GitHub environments/reviewers, release runner, OIDC receivers,
  artifact promotion and authenticated canary configuration.

After those gates and change approval: build immutable artifacts once, back up
and migrate staging, run the locked-plan→matrix→solve→geometry→review
smoke, promote the same digests, apply additive Production migrations before
web/worker cutover, then run authenticated transport/inventory canaries. No step
in that sequence has been executed against a live target by this workspace task.

## M13b — Historical replenishment link

`supabase/migrations/202607250002_m13b_transport_replenishment_link.sql` (version
`202607250002`, module `M13b`) introduced the plan link and dispatch-queue
inputs. Its browser/Haversine concept is superseded by the M13c–M13e controls.

- **District mapping:** `core.transport_district_geo.district_id` maps each route
  node to a real `core.districts` id (5501–5518), backfilled by order and guarded
  so the clean-CI database (no seeded districts) does not fail the FK.
- **Dispatch queue:** `analytics.v_transport_dispatch_queue` aggregates **locked**
  replenishment-plan demand per district. M13c supersedes M13b's nearest-leg
  suggestion: the queue now preserves the plan's exact active canonical origin,
  reports no distance without road evidence, and fails closed for missing or
  quarantined depot geocodes. Exposed at `GET /v1/transport/dispatch-queue`.
- **Plan linkage:** `ops.transport_trips.replenishment_plan_id` records the plan a
  historical trip was intended to fulfil. New trip writes remain disabled until
  a reviewed route-plan→trip activation contract is implemented.

**Road preview:** the same-origin server requests a complete asymmetric
distance/time table from an OSRM-compatible road engine, applies
nearest-neighbour + 2-opt, then requests the full depot→stops→depot road
geometry. It rejects null/unreachable cells. This is a bounded heuristic preview,
not equivalent to the constrained M08 Valhalla + OR-Tools solver.

**Operational solver:** M08 remains the capacity/time-window/multi-vehicle path.
It requires a private truck-profile Valhalla service and a separately deployed
worker. Haversine is never an allowed production fallback.

Production never permits a Haversine fallback. The current preview is
OSRM-compatible road routing; the operational solver is Valhalla truck routing
plus OR-Tools and M13e evidence controls.
