import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiRoute = readFileSync("app/api/[...path]/route.ts", "utf8");
const hook = readFileSync("app/use-synapse-backend.ts", "utf8");
const openapi = readFileSync("app/m09-openapi.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const smoke = readFileSync("scripts/smoke-deployment.mjs", "utf8");

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

test("same-origin OpenAPI keeps the complete 29-path backend contract", () => {
  assert.equal(paths.length, 29);
  for (const path of paths) {
    assert.match(openapi, new RegExp(JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(apiRoute, /m09_dispatch/);
  assert.match(apiRoute, /m10_input_dispatch/);
  assert.match(apiRoute, /m11_legacy_dispatch/);
});

test("frontend orchestrates every operational read/write stage", () => {
  const requiredHookSignals = [
    "/v1/data-inputs/vmi/context?",
    '"/v1/data-inputs/vmi"',
    "/v1/replenishment/runs",
    "/v1/replenishment/items/${itemId}/confirm",
    "/v1/replenishment/plans/${planId}/approve",
    "/v1/forecasts/runs",
    "/v1/jobs/${jobId}",
    "/v1/routes/jobs",
    "/v1/routes/plans/${routePlanId}",
    "/v1/routes/plans/${routePlanId}/review",
  ];
  for (const signal of requiredHookSignals) assert.ok(hook.includes(signal), signal);

  const requiredUiSignals = [
    "Publish governed input",
    "อนุมัติแผน",
    "Queue Forecast Run",
    "สร้าง Route job",
    "ROUTE REVIEW",
    "JOB DETAIL",
    "ROUTE PLAN + GEOJSON",
  ];
  for (const signal of requiredUiSignals) assert.ok(page.includes(signal), signal);
  assert.match(page, /plan_status\)\.toLowerCase\(\)==="approved"/);
  assert.match(page, /row\.status\)\.toLowerCase\(\)!=="draft"/);
});

test("production route jobs cannot select the development Haversine fallback", () => {
  assert.match(page, /matrix_source:"valhalla"/);
  assert.doesNotMatch(page, /matrix_source:"haversine-test"/);
});

test("deployment smoke covers public health, auth denial and the full contract", () => {
  assert.match(smoke, /health\/ready/);
  assert.match(smoke, /database, "ready"/);
  assert.match(smoke, /api\/v1\/me", 401/);
  assert.match(smoke, /expectedPaths\.sort\(\)/);
  assert.match(smoke, /SYNAPSE_ACCESS_TOKEN/);
});
