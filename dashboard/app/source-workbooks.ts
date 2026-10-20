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

const STOCK_HEADERS = [
  "โรงงาน", "ที่เก็บสินค้า", "วัสดุ", "คำอธิบายวัสดุ", "ไม่จำกัด",
  "หน่วยนับพื้นฐาน", "ไม่จำกัดค่า", "การส่ง/การโอน",
];
const USAGE_HEADERS = ["พัสดุ", "โรงงาน", "พัสดุ&โรงงาน", "CMP", "LY", "12", "6", "4"];

export function cleanIdentifier(value: unknown, width?: number): string {
  let cleaned = String(value ?? "").trim();
  if (/^\d+\.0+$/.test(cleaned)) cleaned = cleaned.replace(/\.0+$/, "");
  if (width && /^\d+$/.test(cleaned) && cleaned.length <= width) {
    cleaned = cleaned.padStart(width, "0");
  }
  return cleaned;
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

function headerMatches(row: string[] | undefined, expected: string[]) {
  return expected.every((label, index) => (row?.[index] ?? "").trim() === label);
}

function findSheet(bytes: Uint8Array, expected: string[], preferredName: string) {
  const sheets = readAllWorksheets(bytes);
  const ordered = [
    ...sheets.filter((sheet) => sheet.name === preferredName),
    ...sheets.filter((sheet) => sheet.name !== preferredName),
  ];
  return ordered.find((sheet) => headerMatches(sheet.matrix[0], expected));
}

function monthPeriod(label: string): string | null {
  const cleaned = label.trim();
  if (!/^\d{6}$/.test(cleaned)) return null;
  const month = Number(cleaned.slice(0, 2));
  if (month < 1 || month > 12) return null;
  return `${cleaned.slice(2)}-${cleaned.slice(0, 2)}`;
}

export function parseStockMatrix(matrix: string[][], sheet = "update-stock"): ParsedSource {
  const header = matrix[0] ?? [];
  if (!headerMatches(header, STOCK_HEADERS)) {
    throw new Error("Stock: หัวตารางไม่ตรงกับไฟล์ update-stock ที่ส่งออกจาก SAP");
  }
  const snapshot = excelDate(String(header[10] ?? "").trim());
  if (!/^\d{4}-\d{2}-\d{2}/.test(snapshot)) {
    throw new Error("Stock: ช่อง K1 ต้องเป็นวันที่ของข้อมูล (snapshot date)");
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
    const material = cleanIdentifier(values[2], 12);
    if (!plant) throw new Error(`Stock แถว ${rowNumber}: ไม่มีรหัสโรงงาน`);
    if (material !== rawMaterial) paddedMaterials += 1;
    if (!storage) missingStorage += 1;
    const transfer = parseNumber(values[7]) ?? 0;
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
        unrestricted_value: parseNumber(values[6]),
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
      district_rows: rows.filter((row) => row.payload.district_id).length,
      warehouse_rows: rows.filter((row) => row.payload.warehouse_id).length,
      material_codes_padded_to_12_digits: paddedMaterials,
      duplicate_keys: duplicates,
    },
  };
}

export function parseUsageMatrix(matrix: string[][], sheet = "Check CMP"): ParsedSource {
  const header = (matrix[0] ?? []).map((value) => String(value ?? "").trim());
  if (!headerMatches(header, USAGE_HEADERS)) {
    throw new Error("อัตราการใช้งาน: ไม่พบชีท Check CMP ที่มีหัวตาราง พัสดุ / โรงงาน / CMP / LY / 12 / 6 / 4");
  }
  const months = header.flatMap((label, index) => {
    const period = monthPeriod(label);
    return period ? [{ index, period }] : [];
  });
  if (months.length !== 12) {
    throw new Error(`อัตราการใช้งาน: ต้องมีคอลัมน์ยอดใช้รายเดือน 12 เดือน (รูปแบบ MMYYYY) พบ ${months.length}`);
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
    const material = cleanIdentifier(values[0], 12);
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

export function readStockWorkbook(bytes: Uint8Array): ParsedSource {
  const sheet = findSheet(bytes, STOCK_HEADERS, "update-stock");
  if (!sheet) throw new Error("Stock: ไม่พบชีทที่มีหัวตาราง โรงงาน / ที่เก็บสินค้า / วัสดุ / ไม่จำกัด");
  return parseStockMatrix(sheet.matrix, sheet.name);
}

export function readUsageWorkbook(bytes: Uint8Array): ParsedSource {
  const sheet = findSheet(bytes, USAGE_HEADERS, "Check CMP");
  if (!sheet) throw new Error("อัตราการใช้งาน: ไม่พบชีท Check CMP");
  return parseUsageMatrix(sheet.matrix, sheet.name);
}
