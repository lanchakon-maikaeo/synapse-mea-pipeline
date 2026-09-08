const nullableString = (description) => ({
  type: ["string", "null"],
  description,
});

const fn = (name, description, properties) => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

export const CHAT_TOOLS = [
  fn("get_stock_status", "อ่านสต็อกล่าสุดของวัสดุหนึ่งรายการที่คลังคลองเตยหรือเขต", {
    material_id: nullableString("รหัสวัสดุที่ผู้ใช้ระบุ"),
    scope: { type: ["string", "null"], enum: ["warehouse", "district", null] },
    district_id: nullableString("รหัสเขต 5501-5518; null เมื่อถามคลังหรือเขตของตนเอง"),
  }),
  fn("get_replenishment_recommendation", "อ่านคำแนะนำเติมวัสดุตามผล Business Rules v1 ที่บันทึกในฐานข้อมูล", {
    material_id: nullableString("รหัสวัสดุที่ผู้ใช้ระบุ"),
    district_id: nullableString("รหัสเขต 5501-5518; null เมื่อผู้ใช้ถามเขตของตนเอง"),
  }),
  fn("get_plan_status", "อ่านสถานะและหลักฐานอนุมัติของแผนเติมของจาก UUID", {
    plan_id: nullableString("UUID ของแผน"),
  }),
  fn("get_contract_status", "อ่านสถานะสัญญาและรายการวัสดุด้วยเลขสัญญาหรือเลข PO ที่ตรงกัน", {
    contract_number: nullableString("เลขสัญญา หรือ null เมื่อค้นด้วย PO"),
    purchase_order: nullableString("เลข PO เป็นตัวเลข หรือ null เมื่อค้นด้วยเลขสัญญา"),
  }),
  fn("get_traceability", "สอบกลับ ISSUE ไปยัง HU, Lot, PO และสัญญาด้วยตัวระบุหนึ่งค่า", {
    issue_reference: nullableString("เลขอ้างอิงการจ่าย"),
    handling_unit_code: nullableString("รหัส Handling Unit"),
    purchase_order: nullableString("เลข PO เป็นตัวเลข"),
    material_id: nullableString("รหัสวัสดุ"),
  }),
  fn("clarify", "ขอข้อมูลที่จำเป็นเพิ่มเมื่อยังไม่มีรหัสหรือขอบเขตที่แน่นอน", {
    question: { type: "string" },
  }),
  fn("unsupported", "ใช้เมื่อคำถามอยู่นอกสต็อก การเติมวัสดุ แผน สัญญา หรือการสอบกลับ VMI ปัจจุบัน", {
    reason: { type: "string" },
  }),
];

const DB_TOOLS = new Set(CHAT_TOOLS.slice(0, 5).map((tool) => tool.name));
const districtPattern = /^55(0[1-9]|1[0-8])$/;
const materialPattern = /^[A-Za-z0-9._/-]{1,100}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const poPattern = /^[0-9]{1,19}$/;

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

export function parseToolDecision(providerResponse) {
  const calls = Array.isArray(providerResponse?.candidates)
    ? providerResponse.candidates.flatMap((candidate) => candidate?.content?.parts ?? [])
      .map((part) => part?.functionCall)
      .filter(Boolean)
    : [];
  if (calls.length !== 1 || typeof calls[0].name !== "string" ||
      !calls[0].args || typeof calls[0].args !== "object" || Array.isArray(calls[0].args)) {
    throw new Error("provider_tool_call_invalid");
  }
  return validateDecision({ name: calls[0].name, args: calls[0].args });
}

export function validateDecision({ name, args }) {
  if (name === "clarify") {
    if (!exactKeys(args, ["question"]) || !clean(args.question)) throw new Error("provider_tool_arguments_invalid");
    return { name, args: { question: clean(args.question).slice(0, 180) } };
  }
  if (name === "unsupported") {
    if (!exactKeys(args, ["reason"]) || !clean(args.reason)) throw new Error("provider_tool_arguments_invalid");
    return { name, args: { reason: clean(args.reason).slice(0, 180) } };
  }
  if (!DB_TOOLS.has(name)) throw new Error("provider_tool_not_allowed");

  if (name === "get_stock_status") {
    const material_id = clean(args?.material_id);
    const scope = clean(args?.scope);
    const district_id = clean(args?.district_id);
    if (!exactKeys(args, ["material_id", "scope", "district_id"]) ||
        !materialPattern.test(material_id ?? "") || !["warehouse", "district"].includes(scope) ||
        (district_id && !districtPattern.test(district_id))) throw new Error("provider_tool_arguments_invalid");
    return { name, args: { material_id, scope, ...(district_id ? { district_id } : {}) } };
  }
  if (name === "get_replenishment_recommendation") {
    const material_id = clean(args?.material_id);
    const district_id = clean(args?.district_id);
    if (!exactKeys(args, ["material_id", "district_id"]) ||
        !materialPattern.test(material_id ?? "") || (district_id && !districtPattern.test(district_id))) {
      throw new Error("provider_tool_arguments_invalid");
    }
    return { name, args: { material_id, ...(district_id ? { district_id } : {}) } };
  }
  if (name === "get_plan_status") {
    const plan_id = clean(args?.plan_id);
    if (!exactKeys(args, ["plan_id"]) || !uuidPattern.test(plan_id ?? "")) throw new Error("provider_tool_arguments_invalid");
    return { name, args: { plan_id } };
  }
  if (name === "get_contract_status") {
    const contract_number = clean(args?.contract_number);
    const purchase_order = clean(args?.purchase_order);
    if (!exactKeys(args, ["contract_number", "purchase_order"]) ||
        Number(Boolean(contract_number)) + Number(Boolean(purchase_order)) !== 1 ||
        (purchase_order && !poPattern.test(purchase_order))) throw new Error("provider_tool_arguments_invalid");
    return { name, args: contract_number ? { contract_number } : { purchase_order } };
  }

  const allowed = ["issue_reference", "handling_unit_code", "purchase_order", "material_id"];
  const selected = Object.fromEntries(allowed.map((key) => [key, clean(args?.[key])]).filter(([, value]) => value));
  if (!exactKeys(args, allowed) || Object.keys(selected).length !== 1 ||
      (selected.purchase_order && !poPattern.test(selected.purchase_order)) ||
      (selected.material_id && !materialPattern.test(selected.material_id))) {
    throw new Error("provider_tool_arguments_invalid");
  }
  return { name, args: selected };
}

export function bindDistrictScope(decision, scope) {
  if (!DB_TOOLS.has(decision.name)) return decision;
  if (!["get_stock_status", "get_replenishment_recommendation"].includes(decision.name)) return decision;
  const needsDistrict = decision.name === "get_replenishment_recommendation" || decision.args.scope === "district";
  if (!needsDistrict || decision.args.district_id) return decision;
  if (scope?.role === "district" && districtPattern.test(scope?.district_id ?? "")) {
    return { ...decision, args: { ...decision.args, district_id: scope.district_id } };
  }
  return { name: "clarify", args: { question: "กรุณาระบุรหัสเขต 5501–5518 ที่ต้องการตรวจสอบ" } };
}

export function buildProviderBody(question, temperature) {
  return {
    systemInstruction: { parts: [{ text: [
        "คุณเป็นตัวเลือกเครื่องมือสำหรับระบบ SYNAPSE VMI เท่านั้น",
        "เลือก function เพียงหนึ่งรายการจากคำถามภาษาไทยหรืออังกฤษ ห้ามสร้างรหัส วัสดุ PO แผน เขต หรือข้อเท็จจริงที่ผู้ใช้ไม่ได้ให้",
        "คลองเตย/คลังกลาง/คลัง หมายถึง stock scope warehouse; เขตหมายถึง scope district",
        "คำถามข้อมูลปัจจุบันเท่านั้น คำถามย้อนหลัง ช่วงวันที่ งานเขียนข้อมูล การอนุมัติ การจ่าย หรือโดเมนอื่นให้ unsupported",
        "ถ้าขาดรหัสที่จำเป็นหรือคำถามกำกวมให้ clarify",
        "อย่าตอบตัวเลขหรือข้อความเอง เพราะ server จะอ่านฐานข้อมูลและจัดคำตอบ",
      ].join("\n") }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    tools: [{ functionDeclarations: CHAT_TOOLS.map(({ name, description, parameters }) => ({
      name,
      description,
      parametersJsonSchema: parameters,
    })) }],
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    generationConfig: { maxOutputTokens: 400, temperature },
  };
}

const number = (value, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(parsed)
    : "—";
};
const date = (value) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok",
  }).format(parsed);
};
const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);

export function renderToolResult(envelope) {
  const status = envelope?.status;
  if (status === "no_data") return "ไม่พบข้อมูลที่ตรงกับรหัสและขอบเขตที่ระบุ";
  if (status === "forbidden") return "บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลส่วนนี้";
  if (status === "invalid_input") return "ข้อมูลที่ใช้ค้นหาไม่ครบหรือรูปแบบไม่ถูกต้อง กรุณาตรวจรหัสแล้วลองอีกครั้ง";
  if (status !== "ok") return "ระบบข้อมูลไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง";
  const rows = Array.isArray(envelope.data) ? envelope.data : [];
  if (!rows.length) return "ไม่พบข้อมูลที่ตรงกับรหัสและขอบเขตที่ระบุ";
  const first = rows[0];
  if (envelope.tool === "get_stock_status") {
    if (first.location_id) {
      const lines = rows.slice(0, 8).map((row) => `• ${text(row.location_name_th, row.location_id)}: ${number(row.quantity_on_hand)} ${text(row.unit)}`);
      return [`สต็อกคลังของ ${text(first.material_name)} (${text(first.material_id)})`, ...lines,
        `ข้อมูลล่าสุด ${date(first.snapshot_at)}`].join("\n");
    }
    return [`สต็อก ${text(first.material_name)} (${text(first.material_id)}) เขต ${text(first.district_id)}`,
      `คงเหลือ ${number(first.current_stock_qty)} ${text(first.unit)} · CMP ${number(first.cmp_monthly)} ${text(first.unit)}/เดือน`,
      `ใช้ได้ประมาณ ${number(first.months_available)} เดือน · สถานะ ${text(first.health_band)}`,
      `ข้อมูลล่าสุด ${date(first.snapshot_at)}`].join("\n");
  }
  if (envelope.tool === "get_replenishment_recommendation") {
    const recommendation = first.recommended_qty === null
      ? "ยังไม่มีปริมาณแนะนำจากกฎที่บันทึกไว้"
      : `แนะนำเติม ${number(first.recommended_qty)} ${text(first.unit)}`;
    return [`คำแนะนำ ${text(first.material_name)} (${text(first.material_id)}) เขต ${text(first.district_id)}`,
      `${recommendation} · คงเหลือ ${number(first.current_stock_qty)} ${text(first.unit)}`,
      `CMP ${number(first.cmp_monthly)} ${text(first.unit)}/เดือน · Rule ${text(first.rule_version)}`,
      `สร้างเมื่อ ${date(first.created_at)}`].join("\n");
  }
  if (envelope.tool === "get_plan_status") {
    const approvals = rows.filter((row) => row.approval_stage).slice(0, 5)
      .map((row) => `• ${text(row.approval_stage)}: ${text(row.decision)} (${date(row.acted_at)})`);
    return [`แผน ${text(first.plan_number)} · สถานะ ${text(first.plan_status)}`,
      `สัปดาห์ ${text(first.week_start_date)} · รุ่น ${text(first.version_no)}`,
      ...(approvals.length ? ["หลักฐานอนุมัติ", ...approvals] : ["ยังไม่มีหลักฐานการอนุมัติ"]),
      `อัปเดต ${date(first.updated_at)}`].join("\n");
  }
  if (envelope.tool === "get_contract_status") {
    const lines = rows.filter((row) => row.material_id).slice(0, 6)
      .map((row) => `• ${text(row.material_id)} ${text(row.item_description, "")} ${number(row.quantity)} ${text(row.unit)}`.trim());
    return [`สัญญา ${text(first.contract_number)} · PO ${text(first.purchase_order)}`,
      `สถานะ ${text(first.contract_status)} · ผู้ขาย ${text(first.vendor_name)}`,
      ...(lines.length ? ["รายการวัสดุ", ...lines] : ["ไม่พบรายการวัสดุที่เปิดเผยได้"]),
      `อัปเดต ${date(first.updated_at)}`].join("\n");
  }
  const lines = rows.slice(0, 6).map((row) =>
    `• ISSUE ${text(row.issue_reference)} · ${text(row.material_id)} ${number(row.issued_qty)} ${text(row.unit)} · HU ${text(row.handling_unit_code)} · Lot ${text(row.lot_code)} · PO ${text(row.purchase_order)}`,
  );
  return ["ผลการสอบกลับจากรายการจ่ายที่มีหลักฐาน", ...lines,
    `รายการล่าสุด ${date(first.occurred_at)}`].join("\n");
}
