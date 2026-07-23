# Incident: OPERATIONS and WAREHOUSE pages did not render live data

- Date: 23 July 2026
- Affected target: <https://mea-synapse-staging.vercel.app>
- Supabase project: `mklnbumfwojxhqscthjd`
- Status: resolved

## Impact

After authentication, the dashboard requested 19 read endpoints concurrently.
Vercel logs showed the requests returning `200`, but the page waited for every
response before committing any data and attempted to render the complete
stock-health analytical cube.

The database contained real source-backed data:

| Object | Rows |
|---|---:|
| `core.materials` | 1,043 |
| `core.stock_snapshots` | 462 |
| `core.usage_rates` | 5,926 |
| `analytics.v_stock_health` | 16,758 |
| `core.contracts` | 2,857 |
| `core.contract_items` | 6,305 |

Operational event tables such as Handling Units, FIFO allocations, movements
and alerts were empty because no actual receipt/issue workflow had been
recorded. The UI did not distinguish this legitimate empty workflow state from
missing source data.

## Root cause

`GET /v1/stock-health` returned all 16,758 rows in one JSON array. The measured
database payload was 9,701,976 bytes. The frontend used one `Promise.all` for
all reads and rendered every returned stock row, causing a long blocked render
and making otherwise successful OPERATIONS and WAREHOUSE data appear absent.

## Recovery

Before migration, schema `synapse_backup_20260723_pre015` captured the migration
register and the exact dispatcher definition. The dispatcher definition
SHA-256 was:

`027f2d65f3e6c6cec4802cfea881cd54fff1066f2c47523a749427948ad424d8`

Canonical migration
`supabase/migrations/202607230015_dashboard_read_resilience.sql` (SHA-256
`0d836d6d02d231d994652f80520e7df450c06742210f69a24c7a7b05299d0db4`)
was applied through the Supabase SQL Editor.

Migration 015:

- limits stock-health reads to 250 rows by default and 500 maximum;
- supports non-negative `offset`;
- preserves application-role and district scoping;
- protects the previous v14 dispatcher from direct authenticated execution;
- delegates all unrelated API paths to the verified v14 dispatcher.

The dashboard now requests a bounded page, preserves successful responses when
another endpoint fails, and surfaces actual warehouse snapshots and source
readiness instead of showing a blank operational area.

## Verification

Authenticated dispatcher verification proved:

- latest migration is `202607230015`;
- default and second-page stock-health reads both return `200` and 250 rows;
- default payload is 167,728 bytes instead of 9,701,976 bytes;
- `limit=501` returns `422`;
- delegated operations-health returns `200`;
- authenticated users can execute only the bounded wrapper.

The database still reports no Handling Units or movements. The web application
therefore labels the 462 actual warehouse snapshots as opening stock awaiting
real Handling Unit registration; it does not fabricate pallet, contract or
movement history.
