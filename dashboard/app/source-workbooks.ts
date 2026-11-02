// Browser parsers for Stock.xlsx and อัตราการใช้งาน.xlsx.
//
// The rules mirror pipeline/src/synapse_pipeline/actual_workbooks.py so the
// web import and the governed Python promotion read the same files the same
// way: material codes are padded to 12 digits, plant and storage location to
// 4, "-" in monthly usage means zero, and CMP follows Business Rules v1:
// ROUND(AVERAGE(LY, 12M, 6M, 4M), 0) on non-negative summaries.
import { excelDate, readAllWorksheets } from "./sap-xlsx.ts";

export type SourceRow = { row_number: number; payload: Record<string, unknown> };
export type ParsedSource = {
  rows: SourceRow[];
  warnings: string[];
  sheet: string;
  metadata: Record<string, unknown>;
};

export const PLANT_TO_DISTRICT: Record<string, string> = {
  "5501": "5501", "5601": "5502", "5701": "5503", "5801": "5504",
  "5901": "5505", "6001": "5506", "6501": "5507", "6601": "5508",
  "6701": "5509", "6801": "5510", "6901": "5511", "7001": "5512",
  "7501": "5513", "7601": "5514", "7701": "5515", "7801": "5516",
  "7901": "5517", "8001": "5518",
};

// The daily SAP export has 6 columns; the older prepared workbook added
// value, stock in transfer and the snapshot date in K1.
const STOCK_HEADERS = [
  "โรงงาน", "ที่เก็บสินค้า", "วัสดุ", "คำอธิบายวัสดุ", "ไม่จำกัด", "หน่วยนับพื้นฐาน",
];
const STOCK_EXTENDED_HEADERS = [...STOCK_HEADERS, "ไม่จำกัดค่า", "การส่ง/การโอน"];
const USAGE_HEADERS = ["พัสดุ", "โรงงาน", "พัสดุ&โรงงาน", "CMP", "LY", "12", "6", "4"];

export function cleanIdentifier(value: unknown, width?: number): string {
  let cleaned = String(value ?? "").trim();
  // Google Sheets exports whole numbers as "5701.0" and long codes as
  // "6.21045006E11"; both are exact integers below 2^53.
  if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(cleaned)) {
    const expanded = Number(cleaned);
    if (Number.isSafeInteger(expanded)) cleaned = expanded.toFixed(0);
  }
  if (/^\d+\.0+$/.test(cleaned)) cleaned = cleaned.replace(/\.0+$/, "");
  if (width && /^\d+$/.test(cleaned) && cleaned.length <= width) {
    cleaned = cleaned.padStart(width, "0");
  }
  return cleaned;
}

/**
 * SAP material numbers appear as 12 digits, as 18 digits with leading zeros
 * (contract export) or as numbers that lost leading zeros (Excel). All are
 * normalized to the 12-digit form used everywhere else in Synapse.
 */
export function normalizeMaterial(value: unknown): string {
  const cleaned = cleanIdentifier(value);
  if (!/^\d+$/.test(cleaned)) return cleaned;
  const significant = cleaned.replace(/^0+(?=\d)/, "");
  return significant.length <= 12 ? significant.padStart(12, "0") : cleaned;
}

/**
 * Snapshot date from a file name such as "Stock_update_20.10.69.XLSX"
 * (day.month.Buddhist-year) or "..._20.10.2026.xlsx". Returns YYYY-MM-DD.
 */
export function dateFromFileName(name: string): string | null {
  const match = /(\d{1,2})[._-](\d{1,2})[._-](\d{2}|\d{4})(?!\d)/.exec(name);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (match[3].length === 2) year += year >= 40 ? 2500 - 543 : 2000;
  else if (year > 2400) year -= 543;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseNumber(value: unknown, dashIsZero = false): number | null {
  const cleaned = String(value ?? "").trim().replaceAll(",", "");
  if (!cleaned) return null;
  if (cleaned === "-") return dashIsZero ? 0 : null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Excel ROUND to 0 digits, half away from zero. Rounds the shortest decimal
 * form of the number, exactly like the pipeline's Decimal(str(value)).
 */
export function excelRound(value: number): number {
  const text = String(Math.abs(value));
  if (!/^\d+(\.\d+)?$/.test(text)) return Math.sign(value) * Math.round(Math.abs(value));
  const [whole, fraction = ""] = text.split(".");
  const rounded = Number(whole) + (Number(fraction[0] ?? "0") >= 5 ? 1 : 0);
  return value < 0 ? -rounded : rounded;
}

function headerCell(value: unknown) {
  const cleaned = String(value ?? "").trim();
  return /^\d+\.0+$/.test(cleaned) ? cleaned.replace(/\.0+$/, "") : cleaned;
}

function headerMatches(row: string[] | undefined, expected: string[]) {
  return expected.every((label, index) => headerCell(row?.[index]) === label);
}

function findSheet(
  bytes: Uint8Array,
  expected: string[],
  preferredName: string,
  accept: (row: string[] | undefined, name: string) => boolean = () => false,
) {
  const sheets = readAllWorksheets(bytes);
  const ordered = [
    ...sheets.filter((sheet) => sheet.name === preferredName),
    ...sheets.filter((sheet) => sheet.name !== preferredName),
  ];
  return ordered.find((sheet) => headerMatches(sheet.matrix[0], expected))
    ?? ordered.find((sheet) => accept(sheet.matrix[0], sheet.name));
}

/**
 * ชีท "Stock" ในไฟล์คลังคลองเตย.xlsx: วางยอดจาก SAP ไว้โดยไม่มีหัวคอลัมน์ A–H
 * (มีแค่ I = วัสดุ + โรงงาน, J = วัสดุ + โรงงาน + ที่เก็บ) คอลัมน์เรียงแบบเดียวกับไฟล์ SAP
 * 8 คอลัมน์: โรงงาน / ที่เก็บ / วัสดุ / คำอธิบาย / ไม่จำกัด / หน่วย / ไม่จำกัดค่า / การส่ง/การโอน
 */
export function isHeaderlessStockSheet(row: string[] | undefined, name = "Stock") {
  if (!/^stock$/i.test(name.trim())) return false;
  const cells = (row ?? []).map((cell) => headerCell(cell));
  return cells.slice(0, 8).every((cell) => cell === "") && cells[8] === "วัสดุ + โรงงาน";
}

function monthPeriod(label: string): string | null {
  const cleaned = label.trim();
  if (!/^\d{6}$/.test(cleaned)) return null;
  const month = Number(cleaned.slice(0, 2));
  if (month < 1 || month > 12) return null;
  return `${cleaned.slice(2)}-${cleaned.slice(0, 2)}`;
}

export function parseStockMatrix(
  matrix: string[][],
  sheet = "update-stock",
  options: { snapshotDate?: string | null } = {},
): ParsedSource {
  const header = matrix[0] ?? [];
  const headerless = isHeaderlessStockSheet(header, sheet);
  if (!headerless && !headerMatches(header, STOCK_HEADERS)) {
    throw new Error("Stock: หัวตารางไม่ตรงกับไฟล์ Stock ที่ส่งออกจาก SAP (โรงงาน / ที่เก็บสินค้า / วัสดุ / คำอธิบายวัสดุ / ไม่จำกัด / หน่วยนับพื้นฐาน)");
  }
  const extended = headerless || headerMatches(header, STOCK_EXTENDED_HEADERS);
  const fileDate = excelDate(String(header[10] ?? "").trim());
  const snapshot = /^\d{4}-\d{2}-\d{2}/.test(fileDate) ? fileDate : (options.snapshotDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(snapshot)) {
    throw new Error("Stock: ไม่พบวันที่ของข้อมูล กรุณาระบุวันที่ Stock ในการ์ดก่อนตรวจไฟล์");
  }
  const rows: SourceRow[] = [];
  const seen = new Map<string, number>();
  const planningDuplicates: string[] = [];
  let duplicates = 0;
  let missingStorage = 0;
  let transferRows = 0;
  let paddedMaterials = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const rawMaterial = cleanIdentifier(values[2]);
    if (!rawMaterial) continue;
    const rowNumber = index + 1;
    const plant = cleanIdentifier(values[0], 4);
    const storage = cleanIdentifier(values[1], 4);
    const material = normalizeMaterial(values[2]);
    if (!plant) throw new Error(`Stock แถว ${rowNumber}: ไม่มีรหัสโรงงาน`);
    if (material !== rawMaterial) paddedMaterials += 1;
    if (!storage) missingStorage += 1;
    const transfer = extended ? parseNumber(values[7]) ?? 0 : 0;
    if (transfer !== 0) transferRows += 1;
    // SAP occasionally exports the same plant+storage+material twice (seen
    // for scrap material at plant 2402). Each occurrence is kept as its own
    // row in file order and flagged, instead of silently summing or dropping.
    const key = `${plant}|${storage || "<missing>"}|${material}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if (occurrence > 1) {
      duplicates += 1;
      if (PLANT_TO_DISTRICT[plant] || (plant === "2401" && storage === "0001")) {
        planningDuplicates.push(`${key} (แถว ${rowNumber})`);
      }
    }
    rows.push({
      row_number: rowNumber,
      payload: {
        sap_plant_code: plant,
        storage_location_code: storage,
        material_id: material,
        source_material_code: rawMaterial,
        material_name: String(values[3] ?? "").trim(),
        unrestricted_qty: parseNumber(values[4]) ?? 0,
        base_unit: String(values[5] ?? "").trim(),
        unrestricted_value: extended ? parseNumber(values[6]) : null,
        stock_in_transfer_qty: transfer,
        district_id: PLANT_TO_DISTRICT[plant] ?? null,
        warehouse_id: plant === "2401" && storage === "0001" ? "WH-KT" : null,
        snapshot_date: snapshot.slice(0, 10),
        ...(occurrence > 1 ? { duplicate_occurrence: occurrence } : {}),
      },
    });
  }
  if (!rows.length) throw new Error("Stock: ไม่พบรายการข้อมูล");
  const warnings: string[] = [];
  if (missingStorage) warnings.push(`Stock ${missingStorage} แถวไม่มีที่เก็บสินค้า: เก็บไว้ด้วยรหัส <missing>`);
  if (duplicates) {
    warnings.push(`Stock ${duplicates} แถวมี โรงงาน+ที่เก็บ+วัสดุ ซ้ำกับแถวก่อนหน้า: เก็บแยกเป็นรายการลำดับที่ 2, 3, … ตามลำดับในไฟล์`);
  }
  if (planningDuplicates.length) {
    warnings.push(`Stock รายการซ้ำอยู่ในโรงงานเขตหรือคลังคลองเตย ต้องตรวจก่อนใช้คำนวณ: ${planningDuplicates.slice(0, 5).join(", ")}${planningDuplicates.length > 5 ? " …" : ""}`);
  }
  if (transferRows) warnings.push(`Stock ${transferRows} แถวมียอด การส่ง/การโอน: เก็บเป็นหลักฐาน แต่ไม่นับเป็นยอดคงเหลือ (ใช้ ไม่จำกัด เท่านั้น)`);
  return {
    rows,
    warnings,
    sheet,
    metadata: {
      snapshot_date: snapshot.slice(0, 10),
      quantity_rule: "Unrestricted only; stock in transfer retained as evidence",
      snapshot_date_source: /^\d{4}-\d{2}-\d{2}/.test(fileDate) ? "workbook K1" : "operator / file name",
      layout: headerless ? "warehouse_workbook_stock_sheet" : extended ? "prepared_11_columns" : "sap_6_columns",
      district_rows: rows.filter((row) => row.payload.district_id).length,
      warehouse_rows: rows.filter((row) => row.payload.warehouse_id).length,
      material_codes_padded_to_12_digits: paddedMaterials,
      duplicate_keys: duplicates,
    },
  };
}

export function parseUsageMatrix(matrix: string[][], sheet = "Check CMP"): ParsedSource {
  const header = (matrix[0] ?? []).map(headerCell);
  if (!headerMatches(header, USAGE_HEADERS)) {
    throw new Error("อัตราการใช้งาน: ไม่พบชีท Check CMP ที่มีหัวตาราง พัสดุ / โรงงาน / CMP / LY / 12 / 6 / 4");
  }
  const months = header.flatMap((label, index) => {
    const period = monthPeriod(label);
    return period ? [{ index, period }] : [];
  });
  if (months.length < 12) {
    throw new Error(`อัตราการใช้งาน: ต้องมีคอลัมน์ยอดใช้รายเดือนอย่างน้อย 12 เดือน (รูปแบบ MMYYYY) พบ ${months.length}`);
  }
  const latest = months.map((month) => month.period).sort().at(-1) ?? "";
  const [latestYear, latestMonth] = latest.split("-").map(Number);
  const asOfDate = new Date(Date.UTC(latestYear, latestMonth, 0)).toISOString().slice(0, 10);
  const totalIndex = header.findIndex((label, index) => index > 7 && /^\d{4}$/.test(label));

  const rows: SourceRow[] = [];
  const seen = new Map<string, number>();
  let unmapped = 0;
  let mismatches = 0;
  let negativeCells = 0;
  let dashCells = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    const material = normalizeMaterial(values[0]);
    const plant = cleanIdentifier(values[1], 4);
    if (!material || !plant) continue;
    const rowNumber = index + 1;
    const key = `${material}|${plant}`;
    const first = seen.get(key);
    if (first) {
      throw new Error(`อัตราการใช้งาน แถว ${rowNumber}: พัสดุ+โรงงาน ซ้ำกับแถว ${first} ต้องตรวจต้นทางก่อนนำเข้า`);
    }
    seen.set(key, rowNumber);
    const districtId = PLANT_TO_DISTRICT[plant] ?? null;
    if (!districtId) unmapped += 1;
    const history: Record<string, string | number> = {};
    for (const { index: column, period } of months) {
      const raw = String(values[column] ?? "").trim();
      if (raw === "-") dashCells += 1;
      const quantity = parseNumber(raw, true);
      if (quantity !== null && quantity < 0) negativeCells += 1;
      history[period] = raw === "" ? 0 : raw === "-" ? "-" : (quantity ?? raw);
    }
    const summaries = {
      avg_ly_raw: parseNumber(values[4], true) ?? 0,
      avg_12m_raw: parseNumber(values[5], true) ?? 0,
      avg_6m_raw: parseNumber(values[6], true) ?? 0,
      avg_4m_raw: parseNumber(values[7], true) ?? 0,
    };
    const rawValues = Object.values(summaries);
    const calculatedRaw = excelRound(rawValues.reduce((sum, value) => sum + value, 0) / 4);
    const cmp = excelRound(rawValues.reduce((sum, value) => sum + Math.max(value, 0), 0) / 4);
    const sourceCmp = parseNumber(values[3], true) ?? 0;
    if (sourceCmp !== calculatedRaw) mismatches += 1;
    rows.push({
      row_number: rowNumber,
      payload: {
        material_id: material,
        sap_plant_code: plant,
        district_id: districtId,
        source_cmp: sourceCmp,
        calculated_cmp_raw: calculatedRaw,
        cmp_monthly: Math.max(cmp, 0),
        ...summaries,
        source_year_total: totalIndex >= 0 ? parseNumber(values[totalIndex], true) : null,
        monthly_usage: history,
        as_of_date: asOfDate,
      },
    });
  }
  if (!rows.length) throw new Error("อัตราการใช้งาน: ไม่พบรายการข้อมูล");
  const warnings: string[] = [];
  if (unmapped) warnings.push(`อัตราการใช้งาน ${unmapped} แถวเป็นโรงงานที่ไม่ใช่ 18 เขต: เก็บประวัติไว้ แต่ไม่ใช้คำนวณแผนเขต`);
  if (mismatches) warnings.push(`อัตราการใช้งาน ${mismatches} แถวมีค่า CMP ในไฟล์ไม่ตรงกับสูตร ROUND(AVERAGE(LY,12,6,4),0): ระบบเก็บทั้งค่าในไฟล์และค่าที่คำนวณตามกติกา`);
  if (negativeCells) warnings.push(`อัตราการใช้งาน ${negativeCells} ช่องรายเดือนติดลบ: เก็บค่าดิบไว้ และคิด CMP จากค่าที่ไม่ติดลบ`);
  return {
    rows,
    warnings,
    sheet,
    metadata: {
      as_of_date: asOfDate,
      monthly_periods: months.map((month) => month.period),
      cmp_rule: "ROUND(AVERAGE(non-negative LY, 12M, 6M, 4M), 0)",
      dash_cells_normalized_to_zero: dashCells,
      source_cmp_vs_rule_mismatches: mismatches,
      district_rows: rows.filter((row) => row.payload.district_id).length,
    },
  };
}

export function readStockWorkbook(
  bytes: Uint8Array,
  options: { snapshotDate?: string | null } = {},
): ParsedSource {
  const sheet = findSheet(bytes, STOCK_HEADERS, "update-stock", isHeaderlessStockSheet);
  if (!sheet) throw new Error("Stock: ไม่พบชีทที่มีหัวตาราง โรงงาน / ที่เก็บสินค้า / วัสดุ / ไม่จำกัด หรือชีท Stock ของไฟล์คลังคลองเตย");
  return parseStockMatrix(sheet.matrix, sheet.name, options);
}

export function readUsageWorkbook(bytes: Uint8Array): ParsedSource {
  const sheet = findSheet(bytes, USAGE_HEADERS, "Check CMP");
  if (!sheet) throw new Error("อัตราการใช้งาน: ไม่พบชีท Check CMP");
  return parseUsageMatrix(sheet.matrix, sheet.name);
}
