import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseSapCsv, parseSapMatrix, sapColumns } from "../app/sap-import.ts";
import { parseReceipt14, readSapWorkbook } from "../app/sap-xlsx.ts";

const csvLine = (values) => values.map((value) =>
  `"${String(value).replaceAll('"', '""')}"`).join(",");
const source = (kind, rows) => [
  csvLine(sapColumns[kind].map(([label]) => label)),
  ...rows.map(csvLine),
].join("\r\n");

test("contract installments remain separate rows under one procurement code", () => {
  const base = ["614507415400", "Item, 1", "EA", "PROC-1", "1400004829", "C-1"];
  const rows = parseSapCsv(source("contracts", [
    [...base, "0001", "Vendor", "", "10", "", "", "", "", "", ""],
    [...base, "0002", "Vendor", "", "20", "", "", "", "", "", ""],
  ]), "contracts");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.item_description, "Item, 1");
  assert.equal(rows[1].payload.line_item, "0002");
});

test("duplicate contract business key is rejected, not merged by row number", () => {
  const row = ["614507415400", "Item", "EA", "PROC-1", "1400004829",
    "C-1", "0001", "Vendor", "", "10", "", "", "", "", "", ""];
  assert.throws(() => parseSapCsv(source("contracts", [row, row]), "contracts"),
    /คีย์ SAP ซ้ำ/);
});

test("105 storage fields distinguish warehouse receipts without inventing a lot", () => {
  const base = ["614507415400", "Item", "1400004829"];
  const rows = parseSapCsv(source("receipts_105", [
    [...base, "0001", "2401", "คลองเตย", "00001", "DDS68215", "0", "5000739160", "65", "EA", "2026-09-30", "", ""],
    [...base, "0002", "2401", "คลองเตย", "00002", "DDS68215", "0", "5000739160", "70", "EA", "2026-09-30", "", ""],
  ]), "receipts_105");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.storage_location, "00001");
});

test("scientific-notation SAP identifier is rejected", () => {
  const row = ["6.145074154E+11", "Item", "EA", "PROC-1", "1400004829",
    "C-1", "0001", "Vendor", "", "10", "", "", "", "", "", ""];
  assert.throws(() => parseSapCsv(source("contracts", [row]), "contracts"),
    /รูปแบบยกกำลัง/);
});

test("contract service rows without material are retained separately", () => {
  const rows = parseSapCsv(source("contracts", [
    ["", "Installation", "LE", "PROC-1", "1400004829", "C-1", "0001", "Vendor", "", "1", "", "", "", "", "", ""],
    ["", "Commissioning", "LE", "PROC-1", "1400004829", "C-1", "0002", "Vendor", "", "1", "", "", "", "", "", ""],
  ]), "contracts");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.material_code, "");
});

const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function worksheet(headers, values) {
  const rowXml = [headers, values].map((row, rowIndex) =>
    `<row r="${rowIndex + 1}">${row.map((value, index) => {
      const column = String.fromCharCode(65 + index);
      return `<c r="${column}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("")}</row>`).join("");
  return strToU8(`<worksheet><sheetData>${rowXml}</sheetData></worksheet>`);
}
function workbook(headers, values) {
  return zipSync({ "xl/worksheets/sheet1.xml": worksheet(headers, values) });
}

test("one prepared workbook exposes both contract and 105 sheets", () => {
  const contracts = ["614507415400", "Item", "EA", "PROC-1", "1400004829",
    "C-1", "0001", "Vendor", "", "100", "", "", "", "", "", ""];
  const receipts = ["614507415400", "Item", "1400004829", "0001", "2401",
    "คลองเตย", "00001", "DDS68215", "0", "5000739160", "65", "EA",
    "2026-09-30", "", ""];
  const bytes = zipSync({
    "xl/worksheets/sheet1.xml": worksheet(
      sapColumns.contracts.map(([label]) => label), contracts),
    "xl/worksheets/sheet2.xml": worksheet(
      sapColumns.receipts_105.map(([label]) => label), receipts),
  });
  const contractSheet = readSapWorkbook(bytes, "contracts");
  const receiptSheet = readSapWorkbook(bytes, "receipts_105");
  assert.equal(parseSapMatrix(contractSheet.matrix, "contracts").length, 1);
  assert.equal(parseSapMatrix(receiptSheet.matrix, "receipts_105").length, 1);
});

test("raw 14-column SAP 105 workbook maps without treating SLoc as warehouse location", () => {
  const headers = ["โรงงาน", "SLoc", "MvT", "เลขที่จอง", "GR/GI Slip", "Mat. Doc.",
    "วัสดุ", "ผู้รับ", "ผู้ใช้", "ใบสั่งซื้อ", "ใบตราส่งสินค้า", "ว/ทเอกสาร",
    "Pstng Date", "Qty in UnE"];
  const file = readSapWorkbook(workbook(headers,
    ["2401", "00001", "105", "0", "DDS68215", "5000739160", "614507415400",
      "", "", "1400004829", "", "2026-09-30", "2026-09-30", "65"]), "receipts_105");
  assert.equal(file.layout, "sap_105_14");
  const contracts = parseSapMatrix([
    sapColumns.contracts.map(([label]) => label),
    ["614507415400", "Item", "EA", "PROC-1", "1400004829", "C-1", "0001", "Vendor", "", "100", "", "", "", "", "", ""],
  ], "contracts");
  const parsed = parseReceipt14(file.matrix, contracts);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].payload.unit, "EA");
  assert.equal(parsed.rows[0].payload.sap_sloc, "00001");
  assert.equal(parsed.rows[0].payload.storage_location, "");
});
