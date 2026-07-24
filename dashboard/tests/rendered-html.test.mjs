import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renders the MEA Synapse operational workspace", async () => {
  const html = await readFile(new URL(".next/server/app/index.html", root), "utf8");
  assert.match(html, /MEA Synapse/);
  assert.match(html, /WAREHOUSE OPERATIONS/);
  assert.match(html, /SUPABASE AUTH · RBAC/);
  assert.match(html, /Sign in to MEA Synapse/);
  assert.match(html, /Username or email/);
  assert.match(html, /Application role and district scope/);
  assert.match(html, /PRODUCTION OPERATIONS/);
  assert.doesNotMatch(html, /Demo password|Select a role/);
  assert.doesNotMatch(html, /Your site is taking shape|Codex is working/);
});

test("keeps the UI aligned with the frozen production operations scope", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  for (const required of [
    "Weekly Plan",
    "District Response",
    "Planner",
    "Academic Officer",
    "Picker / Outsource",
    "Viewer",
    "Operations Center",
    "Quantity Recommendation Evidence",
    "Abnormal Request Review",
    "Issue Traceback",
    "OPENING_UNKNOWN",
    "Ad-hoc Issue",
    "37 same-origin API paths",
    "20 ordered Supabase migrations",
    "Production cutover is locked",
    "scope_excluded",
    "useSynapseBackend",
    "backend.createReplenishmentRun",
    "backend.respondReplenishment",
  ]) assert.match(page, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(layout, /MEA Synapse — Warehouse Operations/);
  assert.doesNotMatch(page, /Queue Forecast Run|สร้าง Route job|SYNAPSE AI ASSISTANT/);
});
