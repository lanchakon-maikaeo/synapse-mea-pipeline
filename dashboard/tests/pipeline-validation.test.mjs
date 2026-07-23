import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVmiHistory,
  snapshotIso,
  toLocalDateTimeInput,
} from "../app/pipeline-validation.ts";

test("datetime-local conversion round-trips the source instant", () => {
  const source = new Date("2026-07-23T05:30:00.000Z");
  const localInput = toLocalDateTimeInput(source);
  assert.equal(new Date(localInput).toISOString(), source.toISOString());
});

test("VMI history parser creates the governed API payload shape", () => {
  assert.deepEqual(
    parseVmiHistory(
      "2026-01,120,0,7\n2026-02,98,1,7.5\n2026-03,105",
      "2026-07",
    ),
    [
      {
        period: "2026-01",
        demand_quantity: 120,
        stockout_days: 0,
        lead_time_days: 7,
      },
      {
        period: "2026-02",
        demand_quantity: 98,
        stockout_days: 1,
        lead_time_days: 7.5,
      },
      { period: "2026-03", demand_quantity: 105, stockout_days: 0 },
    ],
  );
});

test("VMI history parser rejects unsafe or ambiguous observations", () => {
  assert.throws(
    () => parseVmiHistory("2026-01,1\n2026-01,2\n2026-02,3", "2026-07"),
    /เดือนซ้ำ/,
  );
  assert.throws(
    () => parseVmiHistory("2026-01,1\n2026-02,2\n2026-08,3", "2026-07"),
    /อนาคต/,
  );
  assert.throws(
    () => parseVmiHistory("2026-01,1,32\n2026-02,2\n2026-03,3", "2026-07"),
    /0–31/,
  );
  assert.throws(
    () => parseVmiHistory("2026-01,1,0,-1\n2026-02,2\n2026-03,3", "2026-07"),
    /ต้องไม่ติดลบ/,
  );
  assert.throws(
    () => parseVmiHistory("2026-01,1,0,7,extra\n2026-02,2\n2026-03,3", "2026-07"),
    /ใช้รูปแบบ/,
  );
});

test("snapshot validation preserves valid local time and blocks future input", () => {
  const now = new Date("2026-07-23T06:00:00.000Z");
  assert.equal(
    snapshotIso(toLocalDateTimeInput(now), now),
    now.toISOString(),
  );
  assert.throws(
    () => snapshotIso(toLocalDateTimeInput(new Date(now.getTime() + 360_000)), now),
    /อนาคต/,
  );
});
