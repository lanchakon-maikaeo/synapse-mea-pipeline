import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaPath = new URL("../db/schema.ts", import.meta.url);
const foundationPath = new URL("../db/migrations/0000_famous_talos.sql", import.meta.url);
const guardsPath = new URL(
  "../db/migrations/0001_staging_baseline_views_and_guards.sql",
  import.meta.url,
);
const operationsPath = new URL(
  "../db/migrations/0002_wise_jamie_braddock.sql",
  import.meta.url,
);
const migrationJournalPath = new URL(
  "../db/migrations/meta/_journal.json",
  import.meta.url,
);
const rulesPath = new URL("../docs/BUSINESS_RULES_V1.md", import.meta.url);

const [schema, foundation, guards, operations, migrationJournal, rules] =
  await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(foundationPath, "utf8"),
    readFile(guardsPath, "utf8"),
    readFile(operationsPath, "utf8"),
    readFile(migrationJournalPath, "utf8"),
    readFile(rulesPath, "utf8"),
  ]);

test("foundation creates the four protected data schemas and 18 tables", () => {
  for (const name of ["raw", "core", "ops", "audit"]) {
    assert.match(foundation, new RegExp(`CREATE SCHEMA "${name}"`));
  }
  assert.equal(foundation.match(/CREATE TABLE/g)?.length, 18);
});

test("stock and usage rules are represented explicitly", () => {
  assert.match(schema, /unrestrictedQty/);
  assert.doesNotMatch(schema, /stockInTransfer|transferQty/);
  assert.match(schema, /sourceWasDash/);
  assert.match(schema, /sourceMissing/);
});

test("handling-unit and immutable movement foundations exist", () => {
  for (const unit of ["FULL_PALLET", "BOX", "CRATE", "BUNDLE", "LOOSE", "LONG_MATERIAL"]) {
    assert.match(schema, new RegExp(`"${unit}"`));
  }
  assert.match(guards, /inventory_movements_append_only/);
  assert.match(guards, /source_rows_append_only/);
  assert.match(guards, /v_fifo_queue/);
  assert.match(guards, /v_traceability_coverage/);
});

test("production operations extension adds six governed workflow tables", () => {
  assert.match(migrationJournal, /0002_wise_jamie_braddock/);
  assert.equal(operations.match(/CREATE TABLE/g)?.length, 6);
  for (const table of [
    "replenishment_plans",
    "replenishment_plan_items",
    "quantity_recommendations",
    "district_change_requests",
    "plan_approvals",
    "fifo_allocations",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(operations, new RegExp(`CREATE TABLE "ops"\\."${table}"`));
  }
  assert.match(operations, /quantity_recommendations_append_only/);
  assert.match(operations, /plan_approvals_append_only/);
  assert.match(operations, /fifo_allocations_append_only/);
  assert.match(operations, /v_issue_traceback/);
  assert.match(operations, /v_quantity_suggestion_evidence/);
  assert.match(operations, /v_abnormal_request_queue/);
});

test("Business Rules v1 policy is seeded and production deployment is documented", () => {
  assert.match(guards, /'BR-V1', 3\.5, 4, 3, 6, 9/);
  assert.match(rules, /Production deployment/i);
  assert.match(rules, /forecasting, routing, and RAG/i);
  assert.match(rules, /backup/i);
});
