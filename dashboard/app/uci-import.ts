// Reads the "DATA" sheet of UCI DATA งานกองคลังพัสดุ (CSV or .xlsx export):
// one row per material + contract + installment, with the vendor's packing
// ("Lot Size ในการเบิก") and the receiving / test status.

export type UciRow = {
  row: number;
  material_id: string;
  material_name: string;
  unit: string;
  contract_no: string;
  purchase_order: string;
  vendor: string;
  installment: string;
  delivered_qty: number | null;
  delivered_on: string;
  accepted_on: string;
  test_result: string; // ผ่าน / ไม่ผ่าน / ไม่ทดสอบ / ""
  keyed_105: string;
  process: string;
  lot_size: string;
};

export type ParsedLot = {
  package_type: "BOX" | "CRATE" | "BUNDLE" | "FULL_PALLET" | "LOOSE" | "LONG_MATERIAL";
  label: string; // the packing page's kind label
  word: string; // the container word as written, normalised
  units_per_package: number;
  units_per_pallet: number | null;
  boxes_per_layer: number | null;
  stack_layers: number | null;
  inner: string | null; // a second level, kept as text
};

const HEADERS: Record<keyof Omit<UciRow, "row">, RegExp> = {
  material_id: /^รหัส$/,
  material_name: /^รายการพัสดุ$/,
  unit: /^หน่วย$/,
  contract_no: /^เลขสัญญา$/,
  purchase_order: /^เลขใบสั่ง$/,
  vendor: /^บริษัท$/,
  installment: /^งวดที่$/,
  delivered_qty: /^จำนวนที่ส่งจริง$/,
  delivered_on: /^วันที่ส่งจริง/,
  accepted_on: /^วันที่ตรวจรับ/,
  test_result: /^ผลทดสอบ$/,
  keyed_105: /^คีร์ 105$|^คีย์ 105$/,
  process: /^Process$/,
  lot_size: /^Lot Size/,
};

const clean = (value: string | undefined) => String(value ?? "").replace(/\s+/g, " ").trim();
const number = (value: string) => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
};

export function readUciMatrix(matrix: string[][]): { rows: UciRow[]; missing: string[] } {
  const headerAt = matrix.findIndex((line) => line.some((cell) => /^Lot Size/.test(clean(cell))));
  if (headerAt < 0) return { rows: [], missing: ["Lot Size ในการเบิก (งานจ่าย)"] };
  const header = matrix[headerAt].map(clean);
  const index = {} as Record<keyof typeof HEADERS, number>;
  const missing: string[] = [];
  (Object.keys(HEADERS) as Array<keyof typeof HEADERS>).forEach((key) => {
    index[key] = header.findIndex((cell) => HEADERS[key].test(cell));
    if (index[key] < 0 && key !== "purchase_order" && key !== "keyed_105") missing.push(String(HEADERS[key].source));
  });
  const codeFallback = header.findIndex((cell) => cell === "รหัสพัสดุ");
  const rows: UciRow[] = [];
  matrix.slice(headerAt + 1).forEach((line, offset) => {
    const at = (key: keyof typeof HEADERS) => (index[key] >= 0 ? clean(line[index[key]]) : "");
    const code = (at("material_id") || clean(line[codeFallback])).replace(/\D/g, "");
    if (!code) return;
    const delivered = number(at("delivered_qty"));
    rows.push({
      row: headerAt + offset + 2,
      material_id: code,
      material_name: at("material_name"),
      unit: at("unit"),
      contract_no: at("contract_no"),
      purchase_order: at("purchase_order").replace(/\D/g, ""),
      vendor: at("vendor"),
      installment: at("installment"),
      delivered_qty: Number.isFinite(delivered) && delivered > 0 ? delivered : null,
      delivered_on: at("delivered_on"),
      accepted_on: at("accepted_on"),
      test_result: at("test_result"),
      keyed_105: at("keyed_105"),
      process: at("process"),
      lot_size: at("lot_size"),
    });
  });
  return { rows, missing };
}

/** Plain CSV (Google Sheets: File > Download > .csv of the DATA tab). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Container words as typed in UCI, typos included ("กล่่อง", "ลููก").
const WORDS: Array<[RegExp, ParsedLot["package_type"], string, string]> = [
  [/^กล่อง/, "BOX", "กล่อง", "กล่อง"],
  [/^(box|ctn|carton)$/i, "BOX", "กล่อง", "กล่อง"],
  [/^ลัง/, "CRATE", "ลัง", "ลัง"],
  [/^กระสอบ|^ถุง/, "BUNDLE", "กระสอบ", "กระสอบ"],
  [/^พาเลท|^พาเท|^pallet$/i, "FULL_PALLET", "มาทั้งพาเลท", "พาเลท"],
  [/^ท่อน|^เส้น|^ต้น/, "LONG_MATERIAL", "ชิ้นยาว (ท่อ/เสา)", "ท่อน"],
  [/^มัด|^bundle$/i, "BUNDLE", "มัด / ขด / ม้วน", "มัด"],
  [/^ขด|^ม้วน|^ลู|^reel$|^drum$/i, "BUNDLE", "มัด / ขด / ม้วน", "ลูก"],
  [/^ตั้ง|^ห่อ|^แพ็ค|^pack$/i, "BUNDLE", "มัด / ขด / ม้วน", ""],
];

function wordOf(raw: string) {
  const found = WORDS.find(([pattern]) => pattern.test(raw));
  if (!found) return null;
  const [, type, label, word] = found;
  return { type, label, word: word || raw };
}

/** "กล่องละ 25 EA (พาเลทละ 1,000 EA) 4*10*25", "500 m/REEL", "@ 1 EA" … */
export function parseLotSize(input: string): ParsedLot | null {
  // collapse repeated Thai marks: "กล่่อง" -> "กล่อง", "ลููก" -> "ลูก"
  const text = input
    .normalize("NFC")
    .replace(/([ัิ-ฺ็-๎])\1+/g, "$1")
    // "19 กระสอบ ๆ ละ 20" -> "กระสอบละ 20"
    .replace(/([ก-๙]+)\s*ๆ\s*ละ/g, "$1ละ")
    // "กล่องเล็ก 50 EA (กล่องใหญ่ 250 EA)" -> "กล่องละ 250 … (ห่อละ 50)"
    .replace(/กล่องเล็ก\s*(?:ละ)?\s*/g, "ห่อละ ")
    .replace(/กล่องใหญ่\s*(?:ละ)?\s*/g, "กล่องละ ")
    // "ลูก 1,000 M" -> "ลูกละ 1,000 M"
    .replace(/^(ลูก|ม้วน|ขด|มัด|กล่อง|ลัง|กระสอบ)\s+(?=[0-9])/, "$1ละ ")
    // "1 EA/ลัง" -> "ลังละ 1 EA"
    .replace(/([0-9][0-9,]*)\s*[A-Za-z]+\s*\/\s*(ลัง|กล่อง|กระสอบ|มัด|ลูก)/g, "$2ละ $1")
    // "1p=2160 ea" -> "พาเลทละ 2160"
    .replace(/1\s*p\s*=\s*([0-9][0-9,]*)/i, "พาเลทละ $1")
    .trim();
  if (!text) return null;
  const pairs: Array<{ word: string; qty: number }> = [];
  for (const match of text.matchAll(/([ก-๙A-Za-z]+)\s*ละ\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)) {
    pairs.push({ word: match[1], qty: number(match[2]) });
  }
  for (const match of text.matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*[A-Za-z]+\s*\/\s*([A-Za-z]+)/g)) {
    pairs.push({ word: match[2], qty: number(match[1]) });
  }
  const loose = text.match(/^@\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  const known = pairs
    .map((pair) => ({ ...pair, kind: wordOf(pair.word) }))
    .filter((pair) => pair.kind && pair.qty > 0);
  const pallet = known.find((pair) => pair.kind!.type === "FULL_PALLET");
  const packs = known.filter((pair) => pair.kind!.type !== "FULL_PALLET").sort((a, b) => b.qty - a.qty);
  const layers = text.match(/(\d+)\s*\*\s*(\d+)\s*\*\s*([0-9][0-9,]*)\s*$/);

  let result: ParsedLot | null = null;
  if (loose && !packs.length) {
    const qty = number(loose[1]);
    if (qty > 0) {
      result = {
        package_type: "LOOSE",
        label: "ชิ้นเปล่า ไม่มีบรรจุภัณฑ์",
        word: "ชิ้น",
        units_per_package: qty,
        units_per_pallet: pallet?.qty ?? null,
        boxes_per_layer: null,
        stack_layers: null,
        inner: null,
      };
    }
  } else if (packs.length) {
    const outer = packs[0];
    result = {
      package_type: outer.kind!.type,
      label: outer.kind!.label,
      word: outer.kind!.word,
      units_per_package: outer.qty,
      units_per_pallet: pallet?.qty ?? null,
      boxes_per_layer: null,
      stack_layers: null,
      inner: packs[1] ? `${packs[1].kind!.word}ละ ${packs[1].qty.toLocaleString("en-US")}` : null,
    };
  } else if (pallet) {
    result = {
      package_type: "FULL_PALLET",
      label: "มาทั้งพาเลท",
      word: "พาเลท",
      units_per_package: pallet.qty,
      units_per_pallet: pallet.qty,
      boxes_per_layer: null,
      stack_layers: null,
      inner: null,
    };
  }
  if (result && layers && number(layers[3]) === result.units_per_package) {
    result.boxes_per_layer = Number(layers[1]);
    result.stack_layers = Number(layers[2]);
  }
  return result;
}

/** A row has passed and is waiting for 105: test passed (or no test) and accepted. */
export function passedAwaiting105(row: UciRow) {
  const passed = row.test_result === "ผ่าน" || row.test_result === "ไม่ทดสอบ";
  return passed && Boolean(row.accepted_on) && !row.keyed_105 && (row.delivered_qty ?? 0) > 0;
}
