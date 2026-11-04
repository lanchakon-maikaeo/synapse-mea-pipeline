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

test("stock requires a snapshot date from K1 or the operator", () => {
  assert.throws(
    () => parseStockMatrix([[...stockHeader.slice(0, 10), ""], ["5501", "1", "1", "x", "1", "EA"]]),
    /วันที่/,
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

test("daily SAP Stock export: 6 columns, date from file name, Google/Excel number forms", async () => {
  const { dateFromFileName, normalizeMaterial, cleanIdentifier } = await import("../app/source-workbooks.ts");
  assert.equal(dateFromFileName("Stock_update_20.10.69.XLSX"), "2026-10-20");
  assert.equal(dateFromFileName("รวมสัญญา_update_20.10.2026.xlsx"), "2026-10-20");
  assert.equal(dateFromFileName("Stock.xlsx"), null);
  assert.equal(dateFromFileName("x_31.02.69.xlsx"), null);
  assert.equal(normalizeMaterial("000000597031193600"), "597031193600");
  assert.equal(normalizeMaterial("20520508910"), "020520508910");
  assert.equal(cleanIdentifier("6.21045006E11"), "621045006000");
  assert.equal(cleanIdentifier("5701.0", 4), "5701");
  const parsed = parseStockMatrix([
    stockHeader.slice(0, 6),
    ["2401", "0001", "471050004000", "PVC", "27350", "EA"],
  ], "Sheet1", { snapshotDate: "2026-10-20" });
  assert.equal(parsed.rows[0].payload.snapshot_date, "2026-10-20");
  assert.equal(parsed.rows[0].payload.warehouse_id, "WH-KT");
  assert.equal(parsed.rows[0].payload.stock_in_transfer_qty, 0);
  assert.equal(parsed.metadata.layout, "sap_6_columns");
  assert.throws(() => parseStockMatrix([stockHeader.slice(0, 6), ["2401", "0001", "1", "x", "1", "EA"]]), /วันที่/);
});

test("usage accepts more than twelve months and Google Sheets header numbers", () => {
  const header = ["พัสดุ", "โรงงาน", "พัสดุ&โรงงาน", "CMP", "LY", "12.0", "6.0", "4.0", "", "", "2025",
    "092026", "082026", "072026", "062026", "052026", "042026", "032026", "022026", "012026",
    "122025", "112025", "102025", "092025", "082025", "072025", "062025", "052025"];
  const parsed = parseUsageMatrix([
    header,
    ["6.21045006E11", "5701.0", "", "32", "35", "30", "29", "35", "", "", "415", ...Array(17).fill("1")],
  ]);
  assert.equal(parsed.metadata.as_of_date, "2026-09-30");
  assert.equal(parsed.metadata.monthly_periods.length, 17);
  assert.equal(parsed.rows[0].payload.material_id, "621045006000");
  assert.equal(parsed.rows[0].payload.sap_plant_code, "5701");
  assert.equal(parsed.rows[0].payload.cmp_monthly, 32);
});

test("13-column 105 export keeps PO line, skips SAP subtotal rows", async () => {
  const { parseReceipt13, receipt13 } = await import("../app/sap-xlsx.ts");
  const parsed = parseReceipt13([
    receipt13,
    ["614513240100", "ROD", "1300116822", "1", "1700", "SET", "2401", "ฝพด.พัสดุกลาง",
      "2025-01-22", "2025-01-22", "2025-01-07", "3", "5000698546"],
    ["", "", "", "", "2975", "", "", "", "", "", "", "", ""],
  ]);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0].payload;
  assert.equal(row.purchase_order, "1300116822");
  assert.equal(row.po_item, "3");
  assert.equal(row.item, "1");
  assert.equal(row.material_document, "5000698546");
  assert.equal(row.unit, "SET");
  assert.ok(parsed.warnings[0].includes("ผลรวม"));
});

test("18-digit contract materials are normalized to 12 digits", async () => {
  const { parseSapMatrix, sapColumns } = await import("../app/sap-import.ts");
  const rows = parseSapMatrix([
    sapColumns.contracts.map(([label]) => label),
    ["000000597031193600", "TAPE", "EA", "MA9", "1300201763", "", "1", "Vendor", "", "1000", "", "", "", "", "", ""],
  ], "contracts");
  assert.equal(rows[0].payload.material_code, "597031193600");
  assert.equal(rows[0].payload.source_material_code, "000000597031193600");
});

test("warehouse workbook: headerless Stock sheet among many sheets, date from the card", () => {
  const cell = (ref, value) => typeof value === "number"
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const letters = "ABCDEFGHIJK";
  const row = (number, values) => `<row r="${number}">${values.map((value, index) =>
    value === "" ? "" : cell(`${letters[index]}${number}`, value)).join("")}</row>`;
  const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const bytes = zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="ตารางเดินรถ ต.ค." r:id="rId1"/><sheet name="Stock" r:id="rId2"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet(row(1, ["วัน", "รถ"]))),
    "xl/worksheets/sheet2.xml": strToU8(sheet(
      row(1, ["", "", "", "", "", "", "", "", "วัสดุ + โรงงาน", "วัสดุ + โรงงาน + ที่เก็บ"])
      + row(2, [5501, 1, 15800100148, "TR", 12, "EA", 100, 0, "158001001485501", "1580010014855011"])
      + row(3, [2401, 1, 592038410000, "Fuse", 655, "EA", 0, 4, "x", "y"]))),
  });
  assert.throws(() => readStockWorkbook(bytes), /วันที่/);
  const parsed = readStockWorkbook(bytes, { snapshotDate: "2026-10-31" });
  assert.equal(parsed.sheet, "Stock");
  assert.equal(parsed.metadata.layout, "warehouse_workbook_stock_sheet");
  assert.equal(parsed.metadata.snapshot_date, "2026-10-31");
  const [district, warehouse] = parsed.rows.map((r) => r.payload);
  assert.equal(district.district_id, "5501");
  assert.equal(district.material_id, "015800100148");
  assert.equal(district.unrestricted_qty, 12);
  assert.equal(warehouse.warehouse_id, "WH-KT");
  assert.equal(warehouse.stock_in_transfer_qty, 4);
});

test("stock scope: warehouse card keeps plant 2401, district card keeps the 18 district plants", () => {
  const matrix = [
    stockHeader,
    ["5501", "1", "15800100148", "TR", "12", "EA", "100", "0"],
    ["2401", "0001", "592038410000", "Fuse", "655", "EA", "", "0"],
    ["2401", "0002", "592038410000", "Fuse", "5", "EA", "", "0"],
    ["9999", "", "1", "Other", "3", "EA", "", "0"],
  ];
  const wh = parseStockMatrix(matrix, "update-stock", { scope: "warehouse" });
  assert.deepEqual(wh.rows.map((r) => r.payload.sap_plant_code), ["2401", "2401"]);
  const district = parseStockMatrix(matrix, "update-stock", { scope: "district" });
  assert.deepEqual(district.rows.map((r) => r.payload.district_id), ["5501"]);
  assert.equal(district.metadata.scope, "district");
  assert.throws(() => parseStockMatrix([stockHeader, ["2401", "0001", "1", "x", "1", "EA"]], "s", { scope: "district" }), /Stock เขต/);
});

test("Material Master reads MASTER and marks codes listed in the VMI sheet", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const { readMaterialWorkbook } = await import("../app/source-workbooks.ts");
  const sheetXml = (rows) => strToU8(`<worksheet><sheetData>${rows.map((row, r) =>
    `<row r="${r + 1}">${row.map((value, c) =>
      `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`);
  const bytes = zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="MASTER" r:id="rId1"/><sheet name="VMI คลองเตย" r:id="rId2"/><sheet name="อื่น" r:id="rId3"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": sheetXml([
      ["รหัส", "InventoryName", "UNIT", "กลุ่ม", "MP / MA", "CONNECTORS"],
      ["560500440200", "MACHINE BOLT 1/2X2 IN", "EA", "1", "MA Q", "MACHINE BOLT"],
      ["560500150800", "ANCHOR ROD", "EA", "3", "MP", "POLE LINE"],
      ["560500150800", "ANCHOR ROD dup", "EA", "3", "MP", "POLE LINE"],
    ]),
    "xl/worksheets/sheet2.xml": sheetXml([
      ["26/10/2026"],
      ["รหัสพัสดุ", "ชื่อพัสดุ", "STOCK"],
      ["560500440200", "MACHINE BOLT", "10"],
      ["471050004000", "PVC CONDUIT", "5"],
    ]),
    "xl/worksheets/sheet3.xml": sheetXml([["x"]]),
  });
  const parsed = readMaterialWorkbook(bytes);
  const byCode = Object.fromEntries(parsed.rows.map((row) => [row.payload.material_id, row.payload]));
  assert.equal(parsed.rows.length, 3);
  assert.equal(byCode["560500440200"].is_vmi, true);
  assert.equal(byCode["560500150800"].is_vmi, false);
  assert.equal(byCode["471050004000"].in_master, false);
  assert.equal(parsed.metadata.vmi_materials, 2);
  assert.ok(parsed.warnings.some((warning) => warning.includes("รหัสซ้ำ")));
});
