# MEA Synapse — Production Pipeline Integration

Status: deployed; managed Supabase migration `202607230015` verified
23 July 2026

- Canonical repository: `lanchakon-maikaeo/synapse-mea-pipeline`
- Release branch: `main`
- Vercel workspace/project: `synapse-mea/mea-synapse-staging`
- Vercel Root Directory: `dashboard`
- Web target: <https://mea-synapse-staging.vercel.app>
Supabase project: `mklnbumfwojxhqscthjd`

The managed database and web API are aligned at Production Operations v1.
Eight authenticated paths that previously returned `404` were verified as
`200` after migration 014. Incident evidence is in
[`docs/incidents/2026-07-23-supabase-contract-sync.md`](../../docs/incidents/2026-07-23-supabase-contract-sync.md).

Migration 015 bounds `/v1/stock-health` to 250 rows by default (maximum 500)
and the dashboard preserves successful endpoint data when a separate read
fails. This replaced the previous 16,758-row / 9.7 MB initial response. See the
[dashboard-read incident record](../../docs/incidents/2026-07-23-dashboard-read-resilience.md).

## Runtime topology

```text
Browser
  -> Supabase Auth (publishable browser key)
  -> /api/* on the same Vercel origin
  -> public.m09_dispatch()
  -> RLS-protected operational functions and views
```

No service-role key, JWT secret or database credential is sent to the browser.

## Active API contract

The dashboard publishes 36 OpenAPI paths covering:

- identity, contracts, data quality and material/district references;
- warehouse stock, stock health and governed VMI input;
- weekly replenishment, quantity evidence and District responses;
- Planner review, Planner/Academic approvals, locking, cancellation and versioning;
- FIFO, Handling Units, receipt, opening reconciliation, issue and return;
- ad-hoc request/approval/issue and issue traceback;
- operational health and alerts.

District data scope is applied by the database/API. Hiding a row or menu in the
browser is never treated as authorization.

Forecasting, routing, and RAG are excluded. They have no dashboard navigation,
no published OpenAPI paths and no browser calls. Direct legacy requests to
forecast, route, background-job, Wave 3 or RAG namespaces fail closed with
`410 scope_excluded`.

## Business contract

- Khlong Toei warehouse: Plant `2401`, Storage Location `0001`.
- Stock uses Unrestricted only; transfer stock is excluded.
- A missing Material + Plant row is assumed zero and visibly source-missing.
- `CMP = ROUND(AVERAGE(LY, 12M, 6M, 4M), 0)`.
- Trigger 3.5 months, MIN 4, reference 3, MAX 6.
- Above 6 months is a warning; above 9 requires Academic approval with a note.
- Official plans are weekly. Daily calculations are alert/exception evidence.
- Approval order is District -> Planner -> Academic -> Lock.
- FIFO uses accepted date, PO, item/installment and source order; an opened
  Handling Unit is exhausted before another unit in the same lot.
- Inventory movements and approvals are append-only.

The complete frozen rule set is in
[`BUSINESS_RULES_V1.md`](./BUSINESS_RULES_V1.md).

## Environment configuration

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_BASE_URL=
```

Leave `NEXT_PUBLIC_API_BASE_URL` blank to use `/api` on the same Vercel
origin. Secrets must be stored in Supabase/Vercel secret management and must
never use a `NEXT_PUBLIC_*` name.

## Verification and release

Run locally or in CI:

```bash
npm ci
npm run verify
npm audit --omit=dev
```

After Vercel reaches `READY`:

```bash
SMOKE_BASE_URL='https://mea-synapse-staging.vercel.app' \
SYNAPSE_ACCESS_TOKEN='<temporary-masked-token>' \
npm run smoke:deployment
```

The smoke suite checks the public shell, health/readiness, unauthenticated
denial, all 36 OpenAPI paths and 11–14 role-aware authenticated read-only
checks. The role-aware set includes every path involved in the 2026-07-23
contract-skew incident. Revoke a temporary access token after evidence is
captured.

The managed database must be migrated first with the guarded root deployment
script. It creates a backup and records release evidence before the web version
is promoted. See
[`docs/PRODUCTION_OPERATIONS_V1.md`](../../docs/PRODUCTION_OPERATIONS_V1.md).

Public smoke checks alone cannot detect a stale dispatcher because protected
paths return `401` before database dispatch. Every database-contract release
therefore requires an authenticated read-only smoke run or an equivalent
authenticated dispatcher verification.

The separate URL
`https://synapse-mea-dashboard.lanchakon0.chatgpt.site` is a ChatGPT
Sites-hosted snapshot. It is not the Vercel release target and must not be used
as deployment evidence for this repository.

The former `lanchakon-maikaeo/synapse-mea-dashboard` repository is an archived
deployment-migration record only. Do not push releases to it or reconnect it to
Vercel.
