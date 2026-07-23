import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renders the MEA Synapse operational workspace", async () => {
  const html = await readFile(new URL(".next/server/app/index.html", root), "utf8");
  assert.match(html, /MEA Synapse/);
  assert.match(html, /WAREHOUSE OPERATIONS/);
  assert.match(html, /STAGING · SUPABASE AUTH/);
  assert.match(html, /Sign in to MEA Synapse/);
  assert.match(html, /Username or email/);
  assert.match(html, /Supabase backend/);
  assert.match(html, /1\.0\.0-NON-AI/);
  assert.doesNotMatch(html, /Demo password|Select a role/);
  assert.doesNotMatch(html, /Your site is taking shape|Codex is working/);
});

test("keeps the UI aligned with the non-AI project status and operational gates", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  for (const required of [
    "คำนวณการจ่าย",
    "ประวัติแผนการจ่าย",
    "ยืนยันรายการพัสดุ",
    "วางแผนขนส่ง",
    "Planner",
    "Viewer",
    "System Administration",
    "3.5 เดือน",
    "6,305",
    "1,043",
    "48,259",
    "District Stock source",
    "12 / 14 months",
    "0 verified geocodes",
    "M11 RAG / MCP / AI",
    "Operations Center",
    "API, Web Input & Security",
    "Quantity Suggestions",
    "Abnormal Request Review",
    "Issue Traceback",
    "LIVE POLICY DATA",
    "M06 MAX GUARD ACTIVE",
    "End-to-end allocation ยัง Data gated",
    "29 unique paths",
    "15 ordered migrations",
    "Wave 2/3 readiness notes",
    "useSynapseBackend",
    "backend.createReplenishmentRun",
    "backend.confirmReplenishment",
  ]) assert.match(page, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(layout, /MEA Synapse — Warehouse Operations/);
  assert.doesNotMatch(page, /SYNAPSE AI ASSISTANT|312 plan lines|4 VRP trips|฿1,245\.6M/);
});
