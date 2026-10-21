export type SapKind = "contracts" | "receipts_105";
export type SapRow = { row_number: number; payload: Record<string, string> };

export const sapColumns: Record<SapKind, Array<[string, string]>> = {
  contracts: [
    ["วัสดุ", "material_code"], ["รายการ", "item_description"],
    ["หน่วยนับ", "unit"], ["รหัสจัดหา", "procurement_code"],
    ["ใบสั่ง", "purchase_order"], ["สัญญา", "contract_number"],
    ["รายการที่", "line_item"], ["ผู้ขาย", "vendor"],
    ["วันเริ่มต้น", "start_date"], ["จำนวน", "quantity"],
    ["วันที่บันทึก", "record_date"], ["วันเปิดซอง", "bid_open_date"],
    ["วันส่งมอบ", "delivery_date"], ["วันผ่านตรวจรับ", "acceptance_date"],
    ["วันที่เอกสาร", "document_date"], ["วันสิ้นสุด", "end_date"],
  ],
  receipts_105: [
    ["วัสดุ", "material_code"], ["คำอธิบายวัสดุ", "item_description"],
    ["ใบสั่งซื้อ", "purchase_order"], ["รายการ", "item"],
    ["โรงงาน", "plant"], ["ชื่อ 1", "plant_name"],
    ["รก.", "storage_location"], ["GR/GI Slip", "gr_gi_slip"],
    ["เลขที่จอง", "reservation_number"], ["Mat. Doc.", "material_document"],
    ["Qty in UnE", "quantity"], ["BUn", "unit"],
    ["วันที่ผ่านรายการ", "posting_date"], ["บันทึกแล้ว", "entered_at"],
    ["ว/ทเอกสาร", "document_date"],
  ],
};

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("ไฟล์ CSV มีเครื่องหมายคำพูดเปิดค้าง");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function naturalKey(kind: SapKind, value: Record<string, string>): string {
  const fields = kind === "contracts"
    ? [value.material_code, value.purchase_order,
      value.line_item.replace(/^0+(?=\d)/, "")]
    : [value.material_document, value.material_code, value.purchase_order,
      value.gr_gi_slip, value.item, value.storage_location, value.posting_date,
      ...(value.source_layout === "sap_105_14" ? [value.quantity] : [])];
  return JSON.stringify(fields);
}

export function parseSapMatrix(matrix: string[][], kind: SapKind,
  extras?: Map<number, Record<string, string>>): SapRow[] {
  const columns = sapColumns[kind];
  const headers = matrix[0] ?? [];
  if (headers.length !== columns.length ||
      columns.some(([expected], index) => headers[index]?.trim() !== expected)) {
    throw new Error(`${kind === "contracts" ? "รวมสัญญา" : "รับเข้า 105"}: หัวตารางไม่ตรงกับไฟล์ที่ส่งออกจากชุด SAP ที่อนุมัติ`);
  }
  const seen = new Map<string, number>();
  const rows = matrix.slice(1).flatMap((values, index) => {
    if (!values.some(Boolean)) return [];
    const rowNumber = index + 2;
    if (values.length > columns.length && values.slice(columns.length).some(Boolean)) {
      throw new Error(`แถว ${rowNumber}: จำนวนคอลัมน์ไม่ตรงกับหัวตาราง`);
    }
    const payload = Object.fromEntries(columns.map(([, field], column) =>
      [field, values[column]?.trim() ?? ""])) as Record<string, string>;
    Object.assign(payload, extras?.get(rowNumber));
    // Contract exports carry 18-digit materials with leading zeros; Stock,
    // usage and 105 use 12 digits. Normalize so every file links on one code.
    if (/^0+\d{12}$/.test(payload.material_code ?? "")) {
      payload.source_material_code = payload.material_code;
      payload.material_code = payload.material_code.slice(-12);
    }
    const needed = kind === "contracts"
      ? ["purchase_order", "procurement_code", "line_item", "quantity", "unit"]
      : ["material_code", "purchase_order", "material_document", "quantity", "unit"];
    const missing = needed.filter((field) => !payload[field]);
    if (missing.length) {
      throw new Error(`แถว ${rowNumber}: ขาด ${missing.join(", ")}`);
    }
    const identifierFields = kind === "contracts"
      ? ["material_code", "purchase_order", "line_item"]
      : ["material_code", "purchase_order", "material_document"];
    if (identifierFields.some((field) =>
      !(kind === "contracts" && field === "material_code" && !payload[field]) &&
      !/^\d+$/.test(payload[field]))) {
      throw new Error(`แถว ${rowNumber}: รหัส SAP ต้องเป็นตัวเลขเต็ม ไม่ใช่รูปแบบยกกำลัง กรุณาส่งออก CSV ใหม่`);
    }
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(payload.quantity.replaceAll(",", ""))) {
      throw new Error(`แถว ${rowNumber}: จำนวนไม่ใช่ตัวเลข`);
    }
    const key = naturalKey(kind, payload);
    const first = seen.get(key);
    if (first) {
      throw new Error(`แถว ${rowNumber}: คีย์ SAP ซ้ำกับแถว ${first} ต้องตรวจต้นทางก่อนนำเข้า`);
    }
    seen.set(key, rowNumber);
    return [{ row_number: rowNumber, payload }];
  });
  if (!rows.length) throw new Error("ไฟล์ไม่มีรายการข้อมูล");
  return rows;
}

export function parseSapCsv(source: string, kind: SapKind): SapRow[] {
  return parseSapMatrix(parseCsv(source.replace(/^\uFEFF/, "")), kind);
}
