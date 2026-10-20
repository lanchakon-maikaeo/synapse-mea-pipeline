import { strFromU8, unzipSync } from "fflate";
import { parseSapMatrix, sapColumns, type SapKind, type SapRow } from "./sap-import.ts";

const receipt14 = ["โรงงาน", "SLoc", "MvT", "เลขที่จอง", "GR/GI Slip",
  "Mat. Doc.", "วัสดุ", "ผู้รับ", "ผู้ใช้", "ใบสั่งซื้อ",
  "ใบตราส่งสินค้า", "ว/ทเอกสาร", "Pstng Date", "Qty in UnE"];

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
  matrix: string[][]; layout: "standard" | "sap_105_14";
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
      (kind === "receipts_105" && matches(row ?? [], receipt14)));
    if (headerIndex < 0) continue;
    const header = matrix[headerIndex];
    const layout = matches(header, expected) ? "standard" : "sap_105_14";
    const width = layout === "standard" ? expected.length : receipt14.length;
    const selected = [header.slice(0, width), ...matrix.slice(headerIndex + 1).map((row) =>
      (row ?? []).slice(0, width))];
    const dateIndexes = layout === "standard"
      ? (kind === "contracts" ? [8, 10, 11, 12, 13, 14, 15] : [12, 13, 14])
      : [11, 12];
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
