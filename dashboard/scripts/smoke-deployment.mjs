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
  "/v1/replenishment/runs",
  "/v1/replenishment/items/{item_id}/confirm",
  "/v1/replenishment/plans/{plan_id}/approve",
  "/v1/forecasts/latest",
  "/v1/forecasts/monitoring",
  "/v1/forecasts/runs",
  "/v1/jobs",
  "/v1/jobs/{job_id}",
  "/v1/routes/jobs",
  "/v1/routes/plans",
  "/v1/routes/plans/{route_plan_id}",
  "/v1/routes/plans/{route_plan_id}/review",
  "/v1/wave3/readiness",
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
  assert.match(identity.role, /^(admin|planner|viewer|district)$/);
  authenticatedRole = identity.role;

  for (const path of [
    "/api/v1/reference/materials?limit=1",
    "/api/v1/reference/districts",
    "/api/v1/data-inputs/vmi?limit=1",
    "/api/v1/stock-health",
    "/api/v1/replenishment/queue",
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
    authenticated_checks: accessToken ? 6 : 0,
    authenticated_role: authenticatedRole,
    status: "passed",
  }),
);
