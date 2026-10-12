import { parseSapCsv, parseSapMatrix, type SapKind, type SapRow } from "./sap-import";
import { parseReceipt14, readSapWorkbook } from "./sap-xlsx";

export async function readSourceFile(file: File, kind: SapKind, contractRows: SapRow[] = []) {
  const xlsx = file.name.toLowerCase().endsWith(".xlsx");
  if (!xlsx && !file.name.toLowerCase().endsWith(".csv")) {
    throw new Error("รองรับไฟล์ SAP .xlsx หรือไฟล์ CSV ที่ส่งออกจากชุดตรวจสอบเท่านั้น");
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error(`${file.name}: ไฟล์ใหญ่เกิน 20 MB`);
  }
  const bytes = await file.arrayBuffer();
  let rows: SapRow[];
  let warnings: string[] = [];
  if (xlsx) {
    const workbook = readSapWorkbook(new Uint8Array(bytes), kind);
    if (workbook.layout === "sap_105_14") {
      const parsed = parseReceipt14(workbook.matrix, contractRows);
      rows = parsed.rows;
      warnings = parsed.warnings;
    } else {
      rows = parseSapMatrix(workbook.matrix, kind);
    }
  } else {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = parseSapCsv(source, kind);
  }
  if (kind === "contracts") {
    const noMaterial = rows.filter((row) => !row.payload.material_code).length;
    if (noMaterial) warnings.push(`รวมสัญญา ${noMaterial} แถวไม่มีรหัสวัสดุ (เช่น งานบริการ): เก็บประวัติไว้ แต่ไม่ใช้จับคู่วัสดุ`);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return { rows, sha256, warnings };
}
