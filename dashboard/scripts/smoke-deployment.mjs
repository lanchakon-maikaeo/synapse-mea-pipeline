import assert from "node:assert/strict";

const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://mea-synapse-staging.vercel.app").replace(
  /\/+$/,
  "",
);
const accessToken = process.env.SYNAPSE_ACCESS_TOKEN?.trim() ?? "";

if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(baseUrl)) {
  throw new Error("SMOKE_BASE_URL must be an HTTPS origin without a path");
}

const expectedPaths = [
  "/health",
  "/health/ready",
  "/v1/me",
  "/v1/contracts",
  "/v1/data-quality",
  "/v1/reference/materials",
  "/v1/warehouse-stock",
  "/v1/data-sources/legacy/status",
  "/v1/admin/import/legacy",
  "/v1/reference/districts",
  "/v1/data-inputs/vmi",
  "/v1/data-inputs/vmi/context",
  "/v1/stock-health",
  "/v1/replenishment/queue",
  "/v1/replenishment/recommendations",
  "/v1/replenishment/change-requests",
  "/v1/replenishment/approvals",
  "/v1/replenishment/runs",
  "/v1/replenishment/items/{item_id}/respond",
  "/v1/replenishment/change-requests/{change_request_id}/review",
  "/v1/replenishment/plans/{plan_id}/approve",
  "/v1/replenishment/plans/{plan_id}/cancel",
  "/v1/replenishment/plans/{plan_id}/version",
  "/v1/replenishment/plans/{plan_id}/issue",
  "/v1/inventory/fifo",
  "/v1/inventory/handling-units",
  "/v1/inventory/receipt-options",
  "/v1/inventory/receipts",
  "/v1/inventory/returns",
  "/v1/inventory/handling-units/{handling_unit_id}/reconcile",
  "/v1/ad-hoc/issues",
  "/v1/ad-hoc/issues/{ad_hoc_issue_id}/approve",
  "/v1/ad-hoc/issues/{ad_hoc_issue_id}/issue",
  "/v1/traceability",
  "/v1/operations/health",
  "/v1/operations/alerts",
];

async function request(path, expectedStatus, token = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${path}: expected ${expectedStatus}, received ${response.status}: ${body.slice(0, 300)}`,
  );
  return {
    body,
    headers: response.headers,
    json: () => JSON.parse(body),
  };
}

const home = await request("/", 200);
assert.match(home.body, /MEA Synapse/i, "Homepage does not identify the expected app");

const health = (await request("/api/health", 200)).json();
assert.equal(health.status, "ok");
assert.equal(health.service, "synapse-api");

const readiness = (await request("/api/health/ready", 200)).json();
assert.equal(readiness.status, "ok");
assert.equal(readiness.database, "ready");

const unauthorized = (await request("/api/v1/me", 401)).json();
assert.equal(unauthorized.error?.code, "unauthorized");
assert.ok(unauthorized.error?.request_id);

const openapi = (await request("/api/openapi.json", 200)).json();
assert.equal(openapi.openapi, "3.1.0");
assert.deepEqual(Object.keys(openapi.paths).sort(), expectedPaths.sort());

let authenticatedRole = null;
if (accessToken) {
  const identity = (await request("/api/v1/me", 200, accessToken)).json();
  assert.match(identity.role, /^(admin|planner|academic|picker|viewer|district)$/);
  authenticatedRole = identity.role;

  for (const path of [
    "/api/v1/reference/materials?limit=1",
    "/api/v1/reference/districts",
    "/api/v1/data-inputs/vmi?limit=1",
    "/api/v1/stock-health",
    "/api/v1/replenishment/queue",
    "/api/v1/replenishment/recommendations",
    "/api/v1/replenishment/change-requests",
    "/api/v1/traceability",
  ]) {
    const result = (await request(path, 200, accessToken)).json();
    assert.ok(Array.isArray(result), `${path}: expected an array`);
  }
}

console.log(
  JSON.stringify({
    base_url: baseUrl,
    public_checks: 5,
    openapi_paths: expectedPaths.length,
    authenticated_checks: accessToken ? 9 : 0,
    authenticated_role: authenticatedRole,
    status: "passed",
  }),
);
