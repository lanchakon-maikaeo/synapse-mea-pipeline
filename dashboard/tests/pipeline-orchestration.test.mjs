import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiRoute = readFileSync("app/api/[...path]/route.ts", "utf8");
const hook = readFileSync("app/use-synapse-backend.ts", "utf8");
const openapi = readFileSync("app/m09-openapi.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const smoke = readFileSync("scripts/smoke-deployment.mjs", "utf8");
const productionRelease = readFileSync(
  "../.github/workflows/production-release.yml",
  "utf8",
);
const rootMakefile = readFileSync("../Makefile", "utf8");

const paths = [
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

test("same-origin OpenAPI exposes the 48-path production operations contract", () => {
  assert.equal(paths.length, 48);
  for (const path of paths) {
    assert.match(
      openapi,
      new RegExp(
        JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
  }
  for (const excluded of [
    '"/v1/forecasts',
    '"/v1/routes',
    '"/v1/jobs',
    '"/v1/wave3',
    '"/v1/rag',
  ]) {
    assert.ok(!openapi.includes(excluded), excluded);
  }
  assert.match(apiRoute, /m09_dispatch/);
  assert.match(apiRoute, /m10_input_dispatch/);
  assert.match(apiRoute, /m11_legacy_dispatch/);
  assert.match(apiRoute, /m13_transport_dispatch/);
  assert.match(apiRoute, /roadRequestFromCanonicalGate\(gate\.body\)/);
  assert.ok(!apiRoute.includes("optimizeRoadRoute(parsed.body)"));
  assert.match(apiRoute, /AbortSignal\.timeout/);
  assert.match(apiRoute, /await upstream\.body\?\.cancel\(\)/);
  assert.doesNotMatch(apiRoute, /const details = await upstream\.json/);
  assert.match(openapi, /\/v1\/transport\/readiness/);
  assert.match(openapi, /\/v1\/transport\/optimize/);
  assert.match(openapi, /\/v1\/transport\/optimization-jobs/);
  assert.match(openapi, /version: "1\.3\.0"/);
});

test("optimization queue OpenAPI declares idempotency and concrete job schemas", () => {
  for (const schema of [
    "QueueRouteOptimizationRequest",
    "RouteOptimizationJob",
    "RouteOptimizationJobError",
    "ApiError",
  ]) {
    assert.ok(openapi.includes(schema), schema);
  }
  assert.match(openapi, /name: "X-Request-ID"/);
  assert.match(openapi, /in: "header"/);
  assert.match(openapi, /required: true/);
  assert.match(openapi, /name: "route_job_id"[\s\S]*in: "path"/);
  assert.match(openapi, /"404": routeOptimizationNotFound/);
  assert.match(
    openapi,
    /\$ref: "#\/components\/schemas\/RouteOptimizationJob"/,
  );
  assert.match(openapi, /enum: \["queued", "running", "succeeded", "failed", "cancelled"\]/);
});

test("same-origin proxy pins a controlled Supabase origin and blocks redirects", () => {
  assert.match(apiRoute, /function controlledSupabaseOrigin\(\)/);
  assert.match(apiRoute, /process\.env\.NODE_ENV === "production"/);
  assert.match(apiRoute, /url\.protocol !== "https:"/);
  assert.match(apiRoute, /url\.username/);
  assert.match(apiRoute, /url\.password/);
  assert.match(apiRoute, /isLoopbackHost\(url\.hostname\)/);
  assert.match(apiRoute, /SUPABASE_ALLOWED_ORIGIN/);
  assert.match(apiRoute, /\[a-z0-9\]\{20\}\\\.supabase\\\.co/);
  assert.match(apiRoute, /hasValidSuppliedRequestId\(request\)/);
  assert.match(apiRoute, /A valid X-Request-ID header is required/);
  assert.equal(apiRoute.match(/redirect: "error"/g)?.length, 2);
  assert.doesNotMatch(
    apiRoute,
    /`\$\{publicConfig\.supabaseUrl\}\/rest\/v1\/rpc/,
  );
});

test("frontend orchestrates the frozen production workflow", () => {
  const requiredHookSignals = [
    "/v1/data-inputs/vmi/context?",
    '"/v1/data-inputs/vmi"',
    "/v1/replenishment/runs",
    "/v1/replenishment/items/${itemId}/respond",
    "/v1/replenishment/change-requests/${changeRequestId}/review",
    "/v1/replenishment/plans/${planId}/approve",
    "/v1/replenishment/plans/${planId}/cancel",
    "/v1/replenishment/plans/${planId}/version",
    "/v1/replenishment/plans/${planId}/issue",
    '"/v1/inventory/receipts"',
    "/v1/inventory/handling-units/${handlingUnitId}/reconcile",
    '"/v1/inventory/returns"',
    '"/v1/ad-hoc/issues"',
    "/v1/ad-hoc/issues/${adHocIssueId}/approve",
    "/v1/ad-hoc/issues/${adHocIssueId}/issue",
  ];
  for (const signal of requiredHookSignals) assert.ok(hook.includes(signal), signal);

  const requiredUiSignals = [
    "District → Planner → Academic → Lock",
    "Quantity Recommendation Evidence",
    "Abnormal Request Review",
    "FIFO, Pallets & Remaining Quantity",
    "Receive Traceable Handling Unit",
    "Ad-hoc Issue",
    "Issue Traceback",
    "APPEND-ONLY RETURN",
    "OPENING_UNKNOWN",
    "Publish governed input",
    "48 same-origin API paths",
    "Ordered Supabase migration chain",
    "Production cutover is locked",
  ];
  for (const signal of requiredUiSignals) assert.ok(page.includes(signal), signal);
});

test("excluded modules have no browser orchestration path", () => {
  for (const excluded of [
    "/v1/forecasts/",
    "/v1/routes/",
    "/v1/jobs",
    "/v1/wave3/",
    "/v1/rag/",
    "matrix_source",
  ]) {
    assert.ok(!hook.includes(excluded), excluded);
    assert.ok(!page.includes(excluded), excluded);
  }
});

test("deployment smoke covers public health, auth denial and full OpenAPI", () => {
  assert.match(smoke, /health\/ready/);
  assert.match(smoke, /database, "ready"/);
  assert.match(smoke, /SMOKE_EXPECT_OPERATIONAL_READY/);
  assert.match(smoke, /SMOKE_EXPECT_TRANSPORT_ROUTE_READY/);
  assert.match(smoke, /ROUTING_CANARY_PLAN_ID/);
  assert.match(smoke, /api\/v1\/me", 401/);
  assert.match(smoke, /expectedPaths\.sort\(\)/);
  assert.match(smoke, /SYNAPSE_ACCESS_TOKEN/);
});

test("release gates reject partial routing and validate every Compose profile", () => {
  assert.match(productionRelease, /and \.solver_status == "succeeded"/);
  assert.match(productionRelease, /and \.unserved_stop_count == 0/);
  assert.doesNotMatch(
    productionRelease,
    /\(\.solver_status == "succeeded" or \.solver_status == "partial"\)/,
  );
  assert.match(rootMakefile, /--profile '\*' --env-file/);
});

test("authenticated deployment smoke detects production-operations contract skew", () => {
  for (const path of [
    "/api/v1/traceability",
    "/api/v1/ad-hoc/issues",
    "/api/v1/inventory/fifo",
    "/api/v1/inventory/handling-units",
    "/api/v1/inventory/receipt-options",
    "/api/v1/replenishment/change-requests",
    "/api/v1/replenishment/recommendations",
    "/api/v1/replenishment/approvals",
  ]) {
    assert.ok(smoke.includes(path), path);
  }
  assert.match(smoke, /authenticatedRole !== "district"/);
  assert.match(smoke, /authenticatedRole === "admin" \|\| authenticatedRole === "picker"/);
  assert.match(smoke, /authenticatedChecks = 2 \+ authenticatedPaths\.length/);
  assert.match(smoke, /\/api\/v1\/transport\/optimize/);
  assert.match(smoke, /sourceChecksumSha256/);
});

test("dashboard reads remain bounded and preserve successful partial data", () => {
  assert.match(hook, /\/v1\/stock-health\?limit=250/);
  assert.match(hook, /const read = async <T,/);
  assert.match(hook, /โหลดสำเร็จบางส่วน/);
  assert.match(page, /ACTUAL WAREHOUSE SNAPSHOTS/);
  assert.match(page, /DATA SOURCE READINESS/);
});
