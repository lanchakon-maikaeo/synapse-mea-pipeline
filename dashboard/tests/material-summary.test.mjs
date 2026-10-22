import test from "node:test";
import assert from "node:assert/strict";
import { buildMaterialSummary, materialCode } from "../app/material-summary.ts";

const contract = (po, line, qty, extra = {}) => ({
  material_code: "592034310000", item_description: "FUSE", unit: "EA",
  purchase_order: po, line_item: line, quantity: String(qty), ...extra,
});
const receipt = (po, poItem, qty, extra = {}) => ({
  material_code: "592034310000", purchase_order: po, po_item: poItem, quantity: String(qty),
  unit: "EA", posting_date: "2026-05-01", source_layout: "sap_105_13", ...extra,
});

test("installments link to 105 receipts by PO + material + งวด", () => {
  const { rows, totals } = buildMaterialSummary({
    stock: [{ material_id: "592034310000", sap_plant_code: "2401", storage_location_code: "0001",
      warehouse_id: "WH-KT", unrestricted_qty: 300, base_unit: "EA", material_name: "FUSE" }],
    usage: [
      { material_id: "592034310000", district_id: "5501", cmp_monthly: 60 },
      { material_id: "592034310000", district_id: "5502", cmp_monthly: 40 },
      { material_id: "592034310000", district_id: null, cmp_monthly: 999 },
    ],
    contracts: [
      contract("1400004186", "1", 100, { delivery_date: "2026-04-01" }),
      contract("1400004186", "2", 100, { delivery_date: "2026-06-01" }),
      contract("1400004186", "3", 100, { delivery_date: "2026-09-01" }),
      contract("1400004186", "4", 100, { delivery_date: "2026-03-01", acceptance_date: "2026-03-05" }),
      contract("1400004186", "5", 100, { delivery_date: "2026-12-01" }),
    ],
    receipts: [
      receipt("1400004186", "1", 100),
      receipt("1400004186", "2", 40),
      receipt("1300000000", "1", 7),
    ],
  }, "2026-10-22");
  const fuse = rows[0];
  assert.equal(fuse.stockQty, 300);
  assert.equal(fuse.districtCount, 2);
  assert.equal(fuse.cmpTotal, 100);
  assert.equal(fuse.monthsOfCover, 3);
  assert.deepEqual(fuse.installments.map((item) => item.status),
    ["complete", "partial", "overdue", "accepted", "pending"]);
  assert.equal(fuse.unmatchedReceipts, 1);
  assert.equal(totals.complete, 1);
  assert.equal(totals.partial, 1);
  assert.equal(totals.overdue, 1);
  assert.equal(totals.accepted, 1);
  assert.equal(totals.pending, 1);
  assert.equal(totals.matchedReceipts, 2);
  assert.equal(totals.unmatchedReceipts, 1);
  assert.ok(fuse.flags.includes("overdue"));
  assert.ok(fuse.flags.includes("receipt_without_contract"));
});

test("a unit difference is reported, never treated as received", () => {
  const { rows, totals } = buildMaterialSummary({
    stock: [], usage: [],
    contracts: [contract("1", "1", 10, { unit: "SET" })],
    receipts: [receipt("1", "1", 10, { unit: "EA" })],
  });
  assert.equal(rows[0].installments[0].status, "unit_mismatch");
  assert.equal(totals.unitMismatch, 1);
  assert.equal(totals.complete, 0);
});

test("material codes from every file meet on the 12-digit code", () => {
  assert.equal(materialCode("000000597031193600"), "597031193600");
  assert.equal(materialCode("20520508910"), "020520508910");
  const { rows } = buildMaterialSummary({
    stock: [{ material_id: "020520508910", warehouse_id: "WH-KT", unrestricted_qty: 5 }],
    usage: [], receipts: [],
    contracts: [{ material_code: "000000020520508910", purchase_order: "1", line_item: "1", quantity: "1", unit: "SET" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inStock, true);
  assert.equal(rows[0].installments.length, 1);
});
