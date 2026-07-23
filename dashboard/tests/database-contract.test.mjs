import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaPath = new URL("../db/schema.ts", import.meta.url);
const foundationPath = new URL("../db/migrations/0000_famous_talos.sql", import.meta.url);
const guardsPath = new URL(
  "../db/migrations/0001_staging_baseline_views_and_guards.sql",
  import.meta.url,
);
const rulesPath = new URL("../docs/BUSINESS_RULES_V1.md", import.meta.url);

const [schema, foundation, guards, rules] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(foundationPath, "utf8"),
  readFile(guardsPath, "utf8"),
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

test("Business Rules v1 policy is seeded and Staging-only guard is documented", () => {
  assert.match(guards, /'BR-V1', 3\.5, 4, 3, 6, 9/);
  assert.match(rules, /Staging first/);
  assert.match(rules, /never run these migrations against Production/i);
});
