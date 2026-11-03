import { strFromU8, unzipSync } from "fflate";
import { parseSapMatrix, sapColumns, type SapKind, type SapRow } from "./sap-import.ts";

const receipt14 = ["โรงงาน", "SLoc", "MvT", "เลขที่จอง", "GR/GI Slip",
  "Mat. Doc.", "วัสดุ", "ผู้รับ", "ผู้ใช้", "ใบสั่งซื้อ",
  "ใบตราส่งสินค้า", "ว/ทเอกสาร", "Pstng Date", "Qty in UnE"];

// SAP 105 export with PO (2026-10): 13 columns, plus SAP subtotal rows at
// the end that carry only a quantity.
export const receipt13 = ["วัสดุ", "คำอธิบายวัสดุ", "ใบสั่งซื้อ", "รายการในเอกสารวัสดุ",
  "ปริมาณในหน่วยบันทึก", "หน่วยนับพื้นฐาน", "โรงงาน", "ชื่อ 1", "วันที่ผ่านรายการ",
  "วันที่บันทึก", "วันที่ในเอกสาร", "รายการ", "เอกสารทางวัสดุ"];

// SAP 105 export (2026-11): the 13-column layout with GR/GI slip, reservation,
// order and movement type added; material document moves to column 15.
export const receipt17 = [...receipt13.slice(0, 12), "ใบรับ/เบิกจ่ายสินค้า", "เลขที่จอง",
  "เอกสารทางวัสดุ", "ใบสั่ง", "ประเภทการเคลื่อนย้าย"];

function xmlText(value: string): string {
  return value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,
    (match, numeric: string | undefined, named: string | undefined) => {
      if (numeric) {
        const code = numeric[0].toLowerCase() === "x"
          ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named?.toLowerCase() ?? ""] ?? match;
    });
}

function attr(source: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] ?? "";
}

function stringValue(xml: string): string {
  return Array.from(xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g),
    (match) => xmlText(match[1])).join("");
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "";
  return Array.from(letters).reduce((value, letter) =>
    value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function excelDate(value: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return value;
  const serial = Number(value);
  if (serial < 1 || serial > 300000) return value;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000)
    .toISOString().slice(0, 10);
}

function readWorksheet(xml: string, shared: string[]): string[][] {
  const matrix: string[][] = [];
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(row[1], "r"));
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 100000) continue;
    const values: string[] = [];
    for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const index = columnIndex(attr(cell[1], "r"));
      if (index < 0 || index > 100) continue;
      const type = attr(cell[1], "t");
      const body = cell[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
      values[index] = type === "s" ? (shared[Number(raw)] ?? "")
        : type === "inlineStr" ? stringValue(body) : xmlText(raw);
    }
    matrix[rowNumber - 1] = values.map((value) => value?.trim() ?? "");
  }
  return matrix;
}

export { excelDate };

/** Every worksheet in an .xlsx with its tab name, as raw text matrices. */
export function readAllWorksheets(bytes: Uint8Array): Array<{ name: string; matrix: string[][] }> {
  const files = unzipSync(bytes);
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = sharedXml ? Array.from(strFromU8(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
    (match) => stringValue(match[1])) : [];
  const workbookXml = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const relsXml = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const targets = new Map(Array.from(relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g), (match) =>
    [attr(match[1], "Id"), attr(match[1], "Target").replace(/^\/?(xl\/)?/, "xl/")]));
  const sheets = Array.from(workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g), (match) => ({
    name: xmlText(attr(match[1], "name")),
    path: targets.get(attr(match[1], "r:id")) ?? "",
  })).filter((sheet) => files[sheet.path]);
  const listed = sheets.length ? sheets : Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map((path) => ({ name: path, path }));
  return listed.map((sheet) => ({
    name: sheet.name,
    matrix: readWorksheet(strFromU8(files[sheet.path]), shared),
  }));
}

function matches(headers: string[], expected: string[]): boolean {
  return expected.every((heading, index) => headers[index]?.trim() === heading);
}

export function readSapWorkbook(bytes: Uint8Array, kind: SapKind): {
  matrix: string[][]; layout: "standard" | "sap_105_14" | "sap_105_13" | "sap_105_17";
} {
  const files = unzipSync(bytes);
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = sharedXml ? Array.from(strFromU8(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
    (match) => stringValue(match[1])) : [];
  const sheetNames = Object.keys(files).filter((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const expected = sapColumns[kind].map(([label]) => label);
  for (const name of sheetNames) {
    const matrix = readWorksheet(strFromU8(files[name]), shared);
    const headerIndex = matrix.findIndex((row) => matches(row ?? [], expected) ||
      (kind === "receipts_105" && (matches(row ?? [], receipt14) || matches(row ?? [], receipt13) ||
        matches(row ?? [], receipt17))));
    if (headerIndex < 0) continue;
    const header = matrix[headerIndex];
    const layout = matches(header, expected) ? "standard"
      : matches(header, receipt17) ? "sap_105_17"
      : matches(header, receipt13) ? "sap_105_13" : "sap_105_14";
    const width = layout === "standard" ? expected.length
      : layout === "sap_105_17" ? receipt17.length
      : layout === "sap_105_13" ? receipt13.length : receipt14.length;
    const selected = [header.slice(0, width), ...matrix.slice(headerIndex + 1).map((row) =>
      (row ?? []).slice(0, width))];
    const dateIndexes = layout === "standard"
      ? (kind === "contracts" ? [8, 10, 11, 12, 13, 14, 15] : [12, 13, 14])
      : layout === "sap_105_13" || layout === "sap_105_17" ? [8, 9, 10] : [11, 12];
    for (const row of selected.slice(1)) {
      for (const index of dateIndexes) row[index] = excelDate(row[index] ?? "");
    }
    return { matrix: selected, layout };
  }
  throw new Error(`${kind === "contracts" ? "รวมสัญญา" : "รับเข้า 105"}: ไม่พบชีทที่มีหัวตาราง SAP ตามรูปแบบที่รองรับ`);
}

export function parseReceipt14(matrix: string[][], contractRows: SapRow[]): {
  rows: SapRow[]; warnings: string[];
} {
  if (!matches(matrix[0] ?? [], receipt14)) throw new Error("หัวตารางรับเข้า 105 แบบ 14 ช่องไม่ถูกต้อง");
  const exact = new Map<string, Set<string>>();
  const material = new Map<string, Set<string>>();
  for (const { payload } of contractRows) {
    const code = payload.material_code;
    const order = payload.purchase_order;
    const unit = payload.unit;
    if (!code || !unit) continue;
    if (!exact.has(`${code}|${order}`)) exact.set(`${code}|${order}`, new Set());
    if (!material.has(code)) material.set(code, new Set());
    exact.get(`${code}|${order}`)?.add(unit);
    material.get(code)?.add(unit);
  }
  const warnings: string[] = [];
  const standard = [sapColumns.receipts_105.map(([label]) => label)];
  const extras = new Map<number, Record<string, string>>();
  for (const [index, row] of matrix.slice(1).entries()) {
    if (!row?.some(Boolean)) { standard.push([]); continue; }
    const number = index + 2;
    if (row[2] !== "105") throw new Error(`แถว ${number}: MvT ไม่ใช่ 105`);
    const code = row[6] ?? "";
    const order = row[9] ?? "";
    const exactUnits = exact.get(`${code}|${order}`);
    const fallbackUnits = material.get(code);
    const units = exactUnits?.size === 1 ? exactUnits : fallbackUnits;
    if (units?.size !== 1) throw new Error(`แถว ${number}: ไม่พบหน่วยนับที่ยืนยันได้จากรวมสัญญา (${code})`);
    if (exactUnits?.size !== 1) warnings.push(`แถว ${number}: เทียบหน่วยนับด้วยรหัสวัสดุ เนื่องจากไม่พบใบสั่งซื้อเดียวกันในสัญญา`);
    standard.push([code, "", order, "", row[0] ?? "", "", "",
      row[4] ?? "", row[3] ?? "", row[5] ?? "", row[13] ?? "",
      [...units][0], row[12] ?? "", "", row[11] ?? ""]);
    extras.set(number, { source_layout: "sap_105_14", sap_sloc: row[1] ?? "",
      movement_type: row[2] ?? "", recipient: row[7] ?? "", user: row[8] ?? "",
      delivery_note: row[10] ?? "" });
  }
  const rows = parseSapMatrix(standard, "receipts_105", extras);
  return { rows, warnings };
}

/**
 * 13-column 105 export. The PO line ("รายการ") and material-document item
 * are kept separately; material document + item identifies the receipt.
 * SAP subtotal rows (no material) are skipped.
 */
export function parseReceipt13(matrix: string[][]): { rows: SapRow[]; warnings: string[] } {
  if (!matches(matrix[0] ?? [], receipt13)) throw new Error("หัวตารางรับเข้า 105 แบบ 13 ช่องไม่ถูกต้อง");
  const standard = [sapColumns.receipts_105.map(([label]) => label)];
  const extras = new Map<number, Record<string, string>>();
  let subtotalRows = 0;
  for (const [index, row] of matrix.slice(1).entries()) {
    const number = index + 2;
    if (!row?.some(Boolean)) { standard.push([]); continue; }
    if (!row[0]) {
      // SAP appends per-unit subtotal lines that carry only a quantity.
      subtotalRows += 1;
      standard.push([]);
      continue;
    }
    standard.push([row[0] ?? "", row[1] ?? "", row[2] ?? "", row[3] ?? "", row[6] ?? "",
      row[7] ?? "", "", "", "", row[12] ?? "", row[4] ?? "", row[5] ?? "",
      row[8] ?? "", row[9] ?? "", row[10] ?? ""]);
    extras.set(number, { source_layout: "sap_105_13", po_item: row[11] ?? "",
      material_document_item: row[3] ?? "" });
  }
  const rows = parseSapMatrix(standard, "receipts_105", extras);
  const warnings = subtotalRows
    ? [`รับเข้า 105: ข้ามแถวผลรวมท้ายไฟล์ของ SAP ${subtotalRows} แถว (ไม่มีรหัสวัสดุ)`]
    : [];
  return { rows, warnings };
}

/**
 * 17-column 105 export: read as the 13-column layout (same receipt keys, so
 * a receipt imported from either export is the same row) and keep the extra
 * columns. Rows that are not movement type 105 are skipped.
 */
export function parseReceipt17(matrix: string[][]): { rows: SapRow[]; warnings: string[] } {
  if (!matches(matrix[0] ?? [], receipt17)) throw new Error("หัวตารางรับเข้า 105 แบบ 17 ช่องไม่ถูกต้อง");
  const extras = new Map<number, Record<string, string>>();
  let otherMovement = 0;
  const as13 = [receipt13, ...matrix.slice(1).map((row, index) => {
    if (!row?.[0]) return row ?? [];
    const movement = (row[16] ?? "").trim();
    if (movement && movement !== "105") {
      otherMovement += 1;
      return [];
    }
    extras.set(index + 2, { source_layout: "sap_105_17", gr_gi_slip_no: row[12] ?? "",
      reservation_no: row[13] ?? "", order_number: row[15] ?? "", movement_type: movement });
    return [...row.slice(0, 12), row[14] ?? ""];
  })];
  const parsed = parseReceipt13(as13);
  for (const row of parsed.rows) Object.assign(row.payload, extras.get(row.row_number));
  const warnings = [...parsed.warnings];
  if (otherMovement) warnings.push(`รับเข้า 105: ข้าม ${otherMovement} แถวที่ประเภทการเคลื่อนย้ายไม่ใช่ 105`);
  return { rows: parsed.rows, warnings };
}
