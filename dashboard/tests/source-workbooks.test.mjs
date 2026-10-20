import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  excelRound,
  parseStockMatrix,
  parseUsageMatrix,
  readStockWorkbook,
} from "../app/source-workbooks.ts";

const stockHeader = [
  "โรงงาน", "ที่เก็บสินค้า", "วัสดุ", "คำอธิบายวัสดุ", "ไม่จำกัด", "หน่วยนับพื้นฐาน",
  "ไม่จำกัดค่า", "การส่ง/การโอน", "วัสดุ + โรงงาน", "วัสดุ + โรงงาน + ที่เก็บ", "46224",
];
const usageHeader = [
  "พัสดุ", "โรงงาน", "พัสดุ&โรงงาน", "CMP", "LY", "12", "6", "4", "", "", "2025",
  "042026", "032026", "022026", "012026", "122025", "112025",
  "102025", "092025", "082025", "072025", "062025", "052025",
];

test("stock keeps Unrestricted, pads codes and maps districts and Khlong Toei", () => {
  const parsed = parseStockMatrix([
    stockHeader,
    ["5501", "1", "15800100148", "TR", "12", "EA", "100", "0"],
    ["2401", "0001", "592038410000", "Fuse", "655", "EA", "", "4"],
    ["9999", "", "1", "Other", "3", "EA", "", "0"],
  ]);
  assert.equal(parsed.metadata.snapshot_date, "2026-07-21");
  assert.equal(parsed.rows.length, 3);
  const [district, warehouse, other] = parsed.rows.map((row) => row.payload);
  assert.equal(district.material_id, "015800100148");
  assert.equal(district.storage_location_code, "0001");
  assert.equal(district.district_id, "5501");
  assert.equal(district.unrestricted_qty, 12);
  assert.equal(warehouse.warehouse_id, "WH-KT");
  assert.equal(warehouse.stock_in_transfer_qty, 4);
  assert.equal(other.district_id, null);
  assert.equal(other.storage_location_code, "");
  assert.ok(parsed.warnings.some((warning) => warning.includes("การส่ง/การโอน")));
});

test("duplicate stock rows are kept in file order and flagged", () => {
  const parsed = parseStockMatrix([
    stockHeader,
    ["2402", "1001", "990161550302", "Scrap", "84301", "KG", "0", "0"],
    ["2402", "1001", "990161550302", "Scrap", "83689", "KG", "0", "0"],
  ]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].payload.duplicate_occurrence, undefined);
  assert.equal(parsed.rows[1].payload.duplicate_occurrence, 2);
  assert.equal(parsed.metadata.duplicate_keys, 1);
  assert.ok(parsed.warnings.some((warning) => warning.includes("ซ้ำ")));
});

test("stock requires the snapshot date in K1", () => {
  assert.throws(
    () => parseStockMatrix([[...stockHeader.slice(0, 10), ""], ["5501", "1", "1", "x", "1", "EA"]]),
    /K1/,
  );
});

test("CMP follows Business Rules v1 and dash means zero usage", () => {
  const months = ["8", "-", "20", "5", "95", "32", "15", "10", "9", "9", "46", "19"];
  const parsed = parseUsageMatrix([
    usageHeader,
    ["621045006000", "5701", "6210450060005701", "26", "35", "24", "30", "13", "", "", "415", ...months],
    ["1", "2401", "x", "3", "-4", "6", "6", "6", "", "", "0", ...months],
  ]);
  const [row, negative] = parsed.rows.map((item) => item.payload);
  assert.equal(parsed.metadata.as_of_date, "2026-04-30");
  assert.equal(row.cmp_monthly, 26);
  assert.equal(row.district_id, "5503");
  assert.equal(row.monthly_usage["2026-03"], "-");
  assert.equal(row.monthly_usage["2026-04"], 8);
  // Signed summaries stay raw; CMP uses non-negative values: (0+6+6+6)/4.
  assert.equal(negative.calculated_cmp_raw, 4);
  assert.equal(negative.cmp_monthly, 5);
  assert.equal(negative.district_id, null);
  assert.ok(parsed.warnings.some((warning) => warning.includes("18 เขต")));
});

test("usage rejects files without twelve monthly columns or with duplicate keys", () => {
  assert.throws(() => parseUsageMatrix([usageHeader.slice(0, 20), ["1", "5501"]]), /12/);
  const months = Array(12).fill("1");
  assert.throws(() => parseUsageMatrix([
    usageHeader,
    ["1", "5501", "", "1", "1", "1", "1", "1", "", "", "1", ...months],
    ["1", "5501", "", "1", "1", "1", "1", "1", "", "", "1", ...months],
  ]), /ซ้ำ/);
});

test("Excel rounding is half away from zero", () => {
  assert.equal(excelRound(2.5), 3);
  assert.equal(excelRound(-2.5), -3);
  assert.equal(excelRound(10.4999999999999), 10);
});

test("stock workbook is found by header, not by sheet position", () => {
  const cell = (ref, value) => /^\d+(\.\d+)?$/.test(value)
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const letters = "ABCDEFGHIJK";
  const row = (number, values) => `<row r="${number}">${values.map((value, index) =>
    cell(`${letters[index]}${number}`, value)).join("")}</row>`;
  const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const bytes = zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="notes" r:id="rId1"/><sheet name="update-stock" r:id="rId2"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet(row(1, ["hello"]))),
    "xl/worksheets/sheet2.xml": strToU8(sheet(row(1, stockHeader) + row(2, ["5501", "1", "15800100148", "TR", "1", "EA", "0", "0"]))),
  });
  const parsed = readStockWorkbook(bytes);
  assert.equal(parsed.sheet, "update-stock");
  assert.equal(parsed.rows[0].payload.material_id, "015800100148");
});
