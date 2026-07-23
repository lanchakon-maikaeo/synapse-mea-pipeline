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

test("same-origin OpenAPI exposes the 36-path production operations contract", () => {
  assert.equal(paths.length, 36);
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
    "36 same-origin API paths",
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
  assert.match(smoke, /api\/v1\/me", 401/);
  assert.match(smoke, /expectedPaths\.sort\(\)/);
  assert.match(smoke, /SYNAPSE_ACCESS_TOKEN/);
});
