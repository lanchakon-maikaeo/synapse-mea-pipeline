// Parser for the legacy distribution workbook (Google Sheet export):
//   "History จ่ายได้ตามแผน", "History ไม่รับของ" and the 18 district sheets
//   (rows not yet moved to History). Produces normalized issue-history rows
//   plus review flags; pending rows (no status yet) are counted, not imported.

import { excelDate } from "./sap-xlsx.ts";

export type LegacyOutcome = "issued" | "adjusted" | "refused";
export type LegacyFillType = "vmi" | "passed_test" | "district_request" | "unknown";

export type LegacyFlag =
  | "missing_issued_qty"
  | "qty_differs_but_marked_full"
  | "actual_before_plan"
  | "missing_plan_date"
  | "duplicate_in_file"
  | "unknown_unit";

export type LegacyHistoryRow = {
  district_id: string;
  district_name: string;
  material_id: string;
  material_name: string;
  unit: string;
  plan_date: string | null;
  actual_date: string | null;
  planned_qty: number | null;
  issued_qty: number | null;
  outcome: LegacyOutcome;
  fill_type: LegacyFillType;
  lot_size_text: string;
  note: string;
  refused_by: string;
  review_flags: LegacyFlag[];
  source_sheet: string;
  source_row: number;
};

export type LegacyParseResult = {
  rows: LegacyHistoryRow[];
  pending: number;
  unknownDistrictSheets: string[];
  sheetsRead: string[];
  warnings: string[];
};

export const LEGACY_DISTRICTS: Record<string, string> = {
  นวลจันทร์: "5501", สามเสน: "5601", นนทบุรี: "5701", ธนบุรี: "5801",
  บางใหญ่: "5901", ลาดกระบัง: "6001", บางนา: "6501", วัดเลียบ: "6601",
  คลองเตย: "6701", ราษฎร์บูรณะ: "6801", ยานนาวา: "6901", บางขุนเทียน: "7001",
  บางบัวทอง: "7501", บางกะปิ: "7601", สมุทรปราการ: "7701", บางพลี: "7801",
  มีนบุรี: "7901", บางเขน: "8001",
};

export const FLAG_LABELS: Record<LegacyFlag, string> = {
  missing_issued_qty: "จ่ายแล้วแต่ไม่มีจำนวนจ่ายจริง",
  qty_differs_but_marked_full: "จำนวนจ่ายไม่ตรงแผน แต่สถานะ 'จ่ายได้ตามแผน'",
  actual_before_plan: "วันจ่ายจริงก่อนวันแผน",
  missing_plan_date: "ไม่มีวันแผน",
  duplicate_in_file: "ซ้ำในไฟล์ (เขต+พัสดุ+วัน+จำนวน)",
  unknown_unit: "หน่วยไม่ถูกต้อง (#N/A)",
};

const OUTCOMES: Record<string, LegacyOutcome> = {
  จ่ายได้ตามแผน: "issued",
  ปรับจำนวน: "adjusted",
  ไม่รับของ: "refused",
};

const FILL_TYPES: Record<string, LegacyFillType> = {
  "จ่ายตาม VMI": "vmi",
  ของผ่านทดสอบ: "passed_test",
  เขตแจ้งใช้: "district_request",
};

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

function districtName(value: string) {
  return clean(value).replace(/^เขต/, "");
}

function material(value: string) {
  const text = clean(value);
  const expanded = /^\d+(\.\d+)?e\+?\d+$/i.test(text) ? Number(text).toFixed(0) : text;
  const digits = expanded.replace(/\.0+$/, "").replace(/\D/g, "");
  return digits.length > 12 ? digits.slice(-12) : digits;
}

function quantity(value: string): number | null {
  const text = clean(value).replace(/,/g, "");
  if (!text || /^#/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function date(value: string): string | null {
  const text = clean(value);
  if (!text) return null;
  const converted = excelDate(text.replace(/\.0+$/, ""));
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(converted);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const thai = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (thai) {
    const year = Number(thai[3]) > 2400 ? Number(thai[3]) - 543 : Number(thai[3]);
    return `${year}-${thai[2].padStart(2, "0")}-${thai[1].padStart(2, "0")}`;
  }
  return null;
}

function headerIndex(matrix: string[][]) {
  for (let index = 0; index < Math.min(matrix.length, 12); index += 1) {
    const row = (matrix[index] ?? []).map(clean);
    if (row.includes("รหัสพัสดุ") && row.includes("สถานะการจ่าย")) return index;
  }
  return -1;
}

function columns(header: string[]) {
  const find = (label: string, from = 0) => header.findIndex((cell, index) => index >= from && clean(cell) === label);
  const unit = find("หน่วย");
  return {
    sourceSheet: find("SourceSheet"),
    material: find("รหัสพัสดุ"),
    name: find("รายการพัสดุ"),
    planned: find("จำนวนการเติมเต็มพัสดุ"),
    unit,
    lotSize: find("Lot Size"),
    planDate: find("แผนวันที่จ่ายพัสดุ"),
    status: find("สถานะการจ่าย"),
    actualDate: find("วันที่จ่ายพัสดุจริง"),
    issued: find("จำนวนที่จ่ายได้จริง"),
    unit2: find("หน่วย", unit + 1),
    fillType: find("ประเภทการเติมของ"),
    note: find("หมายเหตุ"),
    refusedBy: find("ใครยืนยันไม่รับ"),
  };
}

export function parseLegacyWorkbook(
  sheets: Array<{ name: string; matrix: string[][] }>,
): LegacyParseResult {
  const rows: LegacyHistoryRow[] = [];
  const sheetsRead: string[] = [];
  const warnings: string[] = [];
  const unknownDistrictSheets: string[] = [];
  let pending = 0;

  const lookup = { ...LEGACY_DISTRICTS };
  const master = sheets.find((sheet) => sheet.name === "M_Districts");
  master?.matrix.slice(1).forEach((row) => {
    const code = clean(row?.[0]).replace(/\.0+$/, "");
    const name = districtName(row?.[1] ?? "");
    if (/^\d{4}$/.test(code) && name) lookup[name] = code;
  });

  const historySheets = ["History จ่ายได้ตามแผน", "History ไม่รับของ"];
  const districtSheets = sheets.filter((sheet) => lookup[sheet.name] !== undefined);

  for (const sheet of [
    ...sheets.filter((item) => historySheets.includes(item.name)),
    ...districtSheets,
  ]) {
    const isHistory = historySheets.includes(sheet.name);
    const headerRow = isHistory ? 0 : headerIndex(sheet.matrix);
    if (headerRow < 0) {
      warnings.push(`ชีท ${sheet.name}: ไม่พบหัวตาราง (รหัสพัสดุ / สถานะการจ่าย)`);
      continue;
    }
    const col = columns(sheet.matrix[headerRow] ?? []);
    if (col.material < 0 || col.status < 0) {
      warnings.push(`ชีท ${sheet.name}: คอลัมน์ไม่ครบ`);
      continue;
    }
    sheetsRead.push(sheet.name);
    sheet.matrix.slice(headerRow + 1).forEach((row, offset) => {
      if (!row) return;
      const materialId = material(row[col.material] ?? "");
      if (!materialId) return;
      const status = clean(row[col.status]);
      const outcome = OUTCOMES[status];
      if (!outcome) {
        pending += 1;
        return;
      }
      const sourceDistrict = isHistory ? districtName(row[col.sourceSheet] ?? "") : sheet.name;
      const districtId = lookup[sourceDistrict];
      if (!districtId) {
        if (!unknownDistrictSheets.includes(sourceDistrict)) unknownDistrictSheets.push(sourceDistrict);
        return;
      }
      const plannedQty = quantity(row[col.planned] ?? "");
      const issuedRaw = col.issued >= 0 ? quantity(row[col.issued] ?? "") : null;
      const issuedQty = outcome === "refused" ? 0 : issuedRaw;
      const planDate = date(row[col.planDate] ?? "");
      const actualDate = outcome === "refused" ? null : date(row[col.actualDate] ?? "");
      const unitRaw = clean(row[col.unit] ?? "") || clean(col.unit2 >= 0 ? row[col.unit2] : "");
      const flags: LegacyFlag[] = [];
      if (outcome !== "refused" && issuedRaw === null) flags.push("missing_issued_qty");
      if (outcome === "issued" && issuedRaw !== null && plannedQty !== null && issuedRaw !== plannedQty) {
        flags.push("qty_differs_but_marked_full");
      }
      if (planDate && actualDate && actualDate < planDate) flags.push("actual_before_plan");
      if (!planDate) flags.push("missing_plan_date");
      if (!unitRaw || /^#/.test(unitRaw)) flags.push("unknown_unit");
      rows.push({
        district_id: districtId,
        district_name: `เขต${sourceDistrict}`,
        material_id: materialId,
        material_name: clean(row[col.name]),
        unit: /^#/.test(unitRaw) ? "" : unitRaw,
        plan_date: planDate,
        actual_date: actualDate,
        planned_qty: plannedQty,
        issued_qty: issuedQty,
        outcome,
        fill_type: FILL_TYPES[clean(row[col.fillType])] ?? "unknown",
        lot_size_text: clean(row[col.lotSize]),
        note: clean(row[col.note]),
        refused_by: clean(row[col.refusedBy]),
        review_flags: flags,
        source_sheet: sheet.name,
        source_row: headerRow + offset + 2,
      });
    });
  }

  // Same district + material + dates + quantities + outcome = one event.
  const seen = new Map<string, LegacyHistoryRow>();
  const unique: LegacyHistoryRow[] = [];
  for (const row of rows) {
    const key = [row.district_id, row.material_id, row.plan_date, row.actual_date,
      row.planned_qty, row.issued_qty, row.outcome].join("|");
    const first = seen.get(key);
    if (first) {
      if (!first.review_flags.includes("duplicate_in_file")) first.review_flags.push("duplicate_in_file");
      continue;
    }
    seen.set(key, row);
    unique.push(row);
  }

  if (!sheetsRead.length) {
    warnings.push("ไม่พบชีท History หรือชีทเขตในไฟล์นี้");
  }
  return { rows: unique, pending, unknownDistrictSheets, sheetsRead, warnings };
}
