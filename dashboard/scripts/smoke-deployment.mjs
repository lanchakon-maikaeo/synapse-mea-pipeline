import assert from "node:assert/strict";

const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://mea-synapse-web.vercel.app").replace(
  /\/+$/,
  "",
);
const accessToken = process.env.SYNAPSE_ACCESS_TOKEN?.trim() ?? "";
const expectOperationalReady =
  process.env.SMOKE_EXPECT_OPERATIONAL_READY !== "false";
const expectTransportRouteReady =
  process.env.SMOKE_EXPECT_TRANSPORT_ROUTE_READY === "true";
const routingCanaryPlanId =
  process.env.ROUTING_CANARY_PLAN_ID?.trim() ?? "";
const expectedRoutingDataVersion =
  process.env.ROUTING_ENGINE_DATA_VERSION?.trim() ?? "";

if (
  expectTransportRouteReady &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    routingCanaryPlanId,
  )
) {
  throw new Error(
    "ROUTING_CANARY_PLAN_ID must be a UUID when transport route readiness is required",
  );
}

if (
  expectTransportRouteReady &&
  !/^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$/.test(
    expectedRoutingDataVersion,
  )
) {
  throw new Error(
    "ROUTING_ENGINE_DATA_VERSION must match <lowercase-label>-sha256-<64 lowercase hex>",
  );
}

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
  "/v1/admin/fifo-opening",
  "/v1/admin/packaging-profiles",
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
  "/v1/operations/readiness",
  "/v1/operations/alerts",
  "/v1/transport/warehouses",
  "/v1/transport/readiness",
  "/v1/transport/geo",
  "/v1/transport/vehicles",
  "/v1/transport/route-matrix",
  "/v1/transport/dispatch-queue",
  "/v1/transport/trips",
  "/v1/transport/trips/{trip_id}/status",
  "/v1/transport/optimize",
  "/v1/transport/optimization-jobs",
  "/v1/transport/optimization-jobs/{route_job_id}",
];

async function request(path, expectedStatus, token = "", init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
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

const readiness = (
  await request("/api/health/ready", expectOperationalReady ? 200 : 503)
).json();
assert.equal(
  readiness.status,
  expectOperationalReady ? "ok" : "not_ready",
);
assert.equal(readiness.database, "ready");
assert.equal(readiness.operational_ready, expectOperationalReady);

const unauthorized = (await request("/api/v1/me", 401)).json();
assert.equal(unauthorized.error?.code, "unauthorized");
assert.ok(unauthorized.error?.request_id);

const openapi = (await request("/api/openapi.json", 200)).json();
assert.equal(openapi.openapi, "3.1.0");
assert.deepEqual(Object.keys(openapi.paths).sort(), expectedPaths.sort());

let authenticatedRole = null;
let authenticatedChecks = 0;
if (accessToken) {
  const identity = (await request("/api/v1/me", 200, accessToken)).json();
  assert.match(identity.role, /^(admin|planner|academic|picker|viewer|district)$/);
  authenticatedRole = identity.role;

  const authenticatedPaths = [
    "/api/v1/reference/materials?limit=1",
    "/api/v1/reference/districts",
    "/api/v1/data-inputs/vmi?limit=1",
    "/api/v1/stock-health",
    "/api/v1/replenishment/queue",
    "/api/v1/replenishment/recommendations",
    "/api/v1/replenishment/change-requests",
    "/api/v1/replenishment/approvals",
    "/api/v1/ad-hoc/issues",
    "/api/v1/traceability",
    "/api/v1/operations/readiness",
    "/api/v1/transport/warehouses",
    "/api/v1/transport/geo",
    "/api/v1/transport/vehicles",
    "/api/v1/transport/dispatch-queue",
  ];

  if (authenticatedRole !== "district") {
    authenticatedPaths.push(
      "/api/v1/inventory/fifo",
      "/api/v1/inventory/handling-units",
    );
  }

  if (authenticatedRole === "admin" || authenticatedRole === "picker") {
    authenticatedPaths.push("/api/v1/inventory/receipt-options?limit=1");
  }

  for (const path of authenticatedPaths) {
    const result = (await request(path, 200, accessToken)).json();
    assert.ok(Array.isArray(result), `${path}: expected an array`);
  }
  const transportReadiness = (
    await request("/api/v1/transport/readiness", 200, accessToken)
  ).json();
  assert.equal(typeof transportReadiness.route_ready, "boolean");
  assert.equal(
    transportReadiness.monetary_toll_estimate_available,
    false,
  );
  authenticatedChecks = 2 + authenticatedPaths.length;

  if (expectTransportRouteReady) {
    assert.match(
      authenticatedRole,
      /^(admin|planner)$/,
      "Transport canary requires an admin or planner smoke identity",
    );
    assert.equal(
      transportReadiness.route_ready,
      true,
      "Transport readiness must attest a canonical route-ready depot",
    );
    const dispatchQueue = (
      await request(
        "/api/v1/transport/dispatch-queue",
        200,
        accessToken,
      )
    ).json();
    const canaryRows = dispatchQueue
      .filter(
        (row) =>
          row.replenishment_plan_id === routingCanaryPlanId &&
          row.route_eligible === true,
      )
      .slice(0, 18);
    assert.ok(
      canaryRows.length > 0,
      "Routing canary plan has no eligible locked demand",
    );
    const originWarehouse = canaryRows[0].suggested_warehouse;
    assert.ok(originWarehouse, "Routing canary has no canonical origin warehouse");
    assert.ok(
      canaryRows.every(
        (row) => row.suggested_warehouse === originWarehouse,
      ),
      "Routing canary demand spans multiple origin warehouses",
    );
    const optimized = (
      await request(
        "/api/v1/transport/optimize",
        200,
        accessToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            replenishment_plan_id: routingCanaryPlanId,
            depot: { id: originWarehouse },
            stops: canaryRows.map((row) => ({ id: row.district_ref })),
            objective: "duration",
            avoidTolls: false,
          }),
        },
      )
    ).json();
    assert.equal(optimized.provider, "osrm");
    assert.equal(optimized.engineMode, "configured");
    assert.equal(optimized.geometry?.type, "LineString");
    assert.ok(optimized.geometry.coordinates.length >= 2);
    assert.ok(
      optimized.geometry.coordinates.every(
        (position) =>
          Array.isArray(position) &&
          position.length === 2 &&
          Number.isFinite(position[0]) &&
          Number.isFinite(position[1]),
      ),
      "Routing canary geometry contains an invalid coordinate",
    );
    assert.ok(optimized.distanceKm > 0);
    assert.ok(optimized.durationMinutes > 0);
    assert.equal(optimized.replenishmentPlanId, routingCanaryPlanId);
    assert.equal(optimized.order.length, canaryRows.length);
    assert.deepEqual(
      new Set(optimized.order),
      new Set(canaryRows.map((row) => row.district_ref)),
    );
    assert.equal(
      optimized.dataVersion,
      expectedRoutingDataVersion,
      "Routing canary does not match the release-bound road dataset",
    );
    assert.match(
      optimized.coordinateProvenance?.depot?.sourceChecksumSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      optimized.coordinateProvenance?.stops?.[0]?.sourceChecksumSha256 ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(optimized.monetaryTollEstimateAvailable, false);
    authenticatedChecks += 2;
  }
}

console.log(
  JSON.stringify({
    base_url: baseUrl,
    public_checks: 5,
    openapi_paths: expectedPaths.length,
    authenticated_checks: authenticatedChecks,
    authenticated_role: authenticatedRole,
    transport_route_canary: expectTransportRouteReady,
    routing_data_version: expectTransportRouteReady
      ? expectedRoutingDataVersion
      : null,
    status: "passed",
  }),
);
