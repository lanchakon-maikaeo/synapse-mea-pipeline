import { bindDistrictScope, buildProviderBody, parseToolDecision, renderToolResult, wantsSources, CONVERSATION_REPLIES, CHAT_TOOLS, annotateStockFreshness } from "./tools.mjs";

export const HARNESS_VERSION = "v6";
export const MAX_READS = 6;
// How many of the model's calls a run sends back with what was wrong before giving up on it.
const MAX_CORRECTIONS = 2;
const CALL_ONE_FUNCTION = "ตอบด้วยการเรียก function หนึ่งรายการเท่านั้น ห้ามตอบเป็นข้อความ: ทักทายหรือถามความสามารถใช้ conversation, คำสั่งที่ทำไม่ได้ใช้ unsupported, คำถามข้อมูลให้ค้นด้วยเครื่องมือ";
const CORRECTIONS = {
  provider_tool_arguments_invalid: name => `argument ของ ${name} ไม่ผ่านการตรวจ ใช้ชนิดและรูปแบบตาม schema และคำอธิบายของ function; ถ้ายังไม่มีรหัสในรูปแบบที่ถูกต้อง ให้ค้นด้วย discover_database ก่อน`,
  provider_tool_not_allowed: name => `${name} ใช้ไม่ได้ในระบบนี้ ให้เลือก function อื่นที่มีให้`,
};
// Greetings, thanks, goodbyes and questions about the assistant itself; anything else asks for data.
const CONVERSATIONAL = /สวัสดี|หวัดดี|ขอบคุณ|ขอบใจ|ลาก่อน|บ๊?าย|ไว้คุยกัน|ช่วยอะไร|ทำอะไรได้|ความสามารถ|ใช้งาน(อย่างไร|ยังไง)|คุณ(คือ|เป็น)ใคร|\b(hello|hi|hey|thanks?|thank you|thx|bye|goodbye)\b/i;
const SEARCH_FIRST = "ข้อความนี้ถามข้อมูลในระบบ ไม่ใช่คำทักทาย ขอบคุณ ลา หรือถามความสามารถ ให้ค้นด้วย discover_database หรือเครื่องมืออ่านข้อมูลก่อนตอบ";
const REPEATED_CALL = "เรียก function นี้ด้วย argument เดิมไปแล้ว ผลอยู่ด้านบนและจะไม่เปลี่ยน: ถ้าข้อมูลพอให้ finish; ถ้าผลเป็น invalid_input ให้แก้ตาม problems; ถ้า no_data มี hints ให้แก้ตาม hints; ถ้า no_data หรือผล aggregate เป็น null แปลว่าไม่มีแถวตรงเงื่อนไข ให้เปลี่ยน filters เช่น ใช้คอลัมน์รหัสกับรหัสจากคำถาม หรือ contains แทน eq";
const CODE_ARGS = ["material_id", "district_id", "plan_id", "contract_number", "purchase_order", "issue_reference", "handling_unit_code"];

// A code the model passes must appear in what the user wrote (question, history, scope) or in data already read; the catalog does not count.
// So must a piece of a code given to contains. Letters alone turn up somewhere in any data read ("T" for transformer),
// so a piece taken from data must hold a digit.
function unsourcedCode({ name, args }, said, read) {
  const codes = name === "query_database"
    ? args.filters.filter(f => ["eq", "contains"].includes(f.operator) && f.value && /(^|_)(id|number|no|code)$/.test(f.column)).map(f => [f.column, f.value, f.operator])
    : CODE_ARGS.filter(key => typeof args[key] === "string").map(key => [key, args[key], "eq"]);
  const plain = text => text.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50)).toLowerCase();
  const user = plain(said.join("\n")), data = plain(read);
  return codes.find(([, value, operator]) => {
    const code = String(value).toLowerCase();
    return !user.includes(code) && !(data.includes(code) && (operator === "eq" || /\d/.test(code)));
  });
}

// A comparison casts its value to the column's type. Name only values the type surely cannot read (Postgres input syntax).
const INTEGER = { smallint: 32767n, integer: 2147483647n, bigint: 9223372036854775807n };
function castHint(value, type) {
  const text = value.trim(); const base = type.match(/^[a-z]+( precision)?/)?.[0] ?? "";
  if (Object.hasOwn(INTEGER, base)) {
    const ok = /^[+-]?\d+$/.test(text) && BigInt(text.replace(/^\+/, "")) <= INTEGER[base] && BigInt(text.replace(/^\+/, "")) >= -INTEGER[base] - 1n;
    return ok ? undefined : "ใส่จำนวนเต็มล้วน เช่น 10";
  }
  if (["numeric", "decimal", "real", "double precision"].includes(base)) {
    return (text !== "" && Number.isFinite(Number(text))) || /^[+-]?(nan|inf|infinity)$/i.test(text) ? undefined : "ใส่ตัวเลขล้วน ไม่มีหน่วยหรือจุลภาค เช่น 10000";
  }
  if (/^(date|timestamp|time)/.test(base)) return /\d/.test(text) || /^(today|yesterday|tomorrow|now|epoch|-?infinity)$/i.test(text) ? undefined : "ใช้วันที่ ISO เช่น 2026-11-25";
  if (base === "boolean") return /^(t|tr|tru|true|y|ye|yes|on|1|f|fa|fal|fals|false|n|no|of|off|0)$/i.test(text) ? undefined : "ใช้ true หรือ false";
  if (base === "uuid") return /^[0-9a-f]{32}$/i.test(text.replace(/[{}-]/g, "")) ? undefined : "ใส่ UUID เต็ม";
  return undefined;
}
const COMPARISONS = ["eq", "ne", "gt", "gte", "lt", "lte"];
const twice = list => [...new Set(list.filter((item, i) => list.indexOf(item) !== i))];
const metricName = m => `${m.function}_${m.column === "*" ? "rows" : m.column}`;
// The database cannot say why; the model must not take an empty list for "nothing wrong" and resend the query.
const UNEXPLAINED = "ฐานข้อมูลปฏิเสธ query นี้แต่ระบบระบุสาเหตุไม่ได้ ให้ลดเงื่อนไขเหลือเท่าที่จำเป็น เช่น ใช้ search แทน filter แล้วลองอีกครั้ง ห้ามส่ง query เดิมซ้ำ";

// vmi_chat_database answers only invalid_input; name the rules of its checks that the query broke.
// `discovered` is every source discovery returned, so a column the source lacks can point to the source that has it.
function queryProblems(args, schema, discovered) {
  const problems = explainRejection(args, schema, discovered);
  return problems.length ? problems : [UNEXPLAINED];
}
function explainRejection({ source_id, columns, filters, group_by, metrics, order_column }, schema, discovered) {
  const returned = metrics.length ? [...group_by, ...metrics.map(metricName)] : columns.length ? columns : Object.keys(schema).sort().slice(0, 16);
  const used = [...columns, ...filters.map(f => f.column), ...group_by, ...metrics.map(m => m.column).filter(column => column !== "*"),
    ...(order_column ? [order_column] : [])];
  return [
    ...filters.filter(f => COMPARISONS.includes(f.operator) && typeof f.value === "string" && schema[f.column]).flatMap(f => {
      const hint = castHint(f.value, schema[f.column]);
      return hint ? [`filter ${f.column} ${f.operator}: "${f.value}" ไม่ใช่ค่าที่คอลัมน์ ${schema[f.column]} รับได้ ${hint}; ถ้าค่าเป็นชื่อหรือข้อความ ให้ใช้ search`] : [];
    }),
    ...(metrics.length ? [] : twice(columns)).map(column => `columns มี ${column} ซ้ำ ให้ใส่แต่ละคอลัมน์ครั้งเดียว`),
    ...twice(group_by).map(column => `group_by มี ${column} ซ้ำ ให้ใส่แต่ละคอลัมน์ครั้งเดียว`),
    ...twice(metrics.map(metricName)).map(name => `metrics ให้ผล ${name} ซ้ำ ให้ขอแต่ละ metric ครั้งเดียว`),
    ...[...new Set(used)].filter(column => !Object.hasOwn(schema, column)).map(column => {
      const elsewhere = [...discovered].filter(([id, other]) => id !== source_id && Object.hasOwn(other, column)).map(([id]) => id).slice(0, 3);
      // Facts without a column of their own (a contact phone) are written in the source's notes.
      const notes = Object.keys(schema).filter(name => /_notes?$/.test(name));
      return elsewhere.length ? `ไม่มีคอลัมน์ ${column} ใน ${source_id} แต่มีใน ${elsewhere.join(", ")} ให้ query แหล่งนั้นแทน`
        : notes.length ? `ไม่มีคอลัมน์ ${column} ในแหล่งนี้และแหล่งที่ค้นได้ ข้อมูลที่ไม่มีคอลัมน์ของตัวเองอาจเขียนอยู่ในคอลัมน์บันทึก: ${notes.join(", ")} ให้เลือกคอลัมน์เหล่านี้แทน`
        : `ไม่มีคอลัมน์ ${column} ในแหล่งนี้และแหล่งที่ค้นได้ ให้ตัดออกหรือเลือกจาก columns; ถ้าคำถามต้องใช้ข้อมูลนี้ ให้ค้น discover_database ใหม่ด้วยชนิดข้อมูลที่ต้องการ`;
    }),
    ...filters.filter(f => !["is_null", "not_null"].includes(f.operator) && f.value == null)
      .map(f => `filter ${f.column} ${f.operator} ต้องมี value; ถ้าไม่ต้องการค่าให้ใช้ is_null หรือ not_null`),
    ...(group_by.length && !metrics.length ? ["group_by ใช้ได้เมื่อมี metrics เท่านั้น"] : []),
    ...(metrics.length && columns.length ? ["เมื่อมี metrics ระบบไม่คืน columns คืนเฉพาะ group_by และผล metric; ถ้าต้องการรายละเอียดของแถวที่ค่ามากสุดหรือน้อยสุด ให้ตัด metrics แล้วใช้ columns กับ order_column และ limit"] : []),
    ...metrics.filter(m => ["sum", "avg"].includes(m.function) && schema[m.column] && !/^(smallint|integer|bigint|numeric|real|double precision)/.test(schema[m.column]))
      .map(m => `${m.function} ใช้กับคอลัมน์ตัวเลขเท่านั้น แต่ ${m.column} เป็น ${schema[m.column]}`),
    ...(order_column && !returned.includes(order_column) ? [`order_column ${order_column} ต้องเป็นคอลัมน์ที่ query คืน: ${returned.join(", ")}`] : []),
  ];
}

// The database answers no_data without saying why; name the filters that most often remove every row.
function emptyHints({ filters }, schema) {
  return [
    ...filters.filter(f => f.operator === "is_null")
      .map(f => `filter ${f.column} is_null เลือกเฉพาะแถวที่ ${f.column} ว่าง ถ้าคำถามไม่ได้ถามหาแถวที่ไม่มีค่า ให้ตัด filter นี้`),
    ...filters.filter(f => f.operator === "eq" && /^(text|character varying)/.test(schema[f.column] ?? "") && !/(^|_)(id|number|no|code)$/.test(f.column))
      .map(f => `filter ${f.column} eq ต้องตรงทุกตัวอักษร ถ้าค่าเป็นชื่อหรือข้อความบางส่วน ให้ใช้ search หรือ contains`),
  ];
}

// Model decisions are proposals. This loop owns execution, budgets and completion.
export async function runAgent({ message, history = /** @type {{ role: string, text: string }[]} */ ([]), temperature, scope, signal, generate, read, hiddenTools = /** @type {string[]} */ ([]) }) {
  const body = buildProviderBody(message, temperature, history);
  // A provider without a capability (e.g. embeddings) never sees that tool.
  const declarations = body.tools[0].functionDeclarations.filter(fn => !hiddenTools.includes(fn.name));
  const evidence = [];
  const trace = [];
  const seen = new Set();
  // source_id -> its columns, as discover_database returned them.
  const discovered = new Map();
  let stopReason = "step_limit";
  let terminalAnswer;
  let terminalStatus;
  let reminded = false;
  let corrections = 0;
  // The model's call goes back as its tool result, so it sees its own call next to what was wrong.
  const correct = (content, name, reason, message) => {
    body.contents.push(content, { role: "user", parts: [{ functionResponse: { name, response: { status: "rejected", reason, message } } }] });
    corrections++;
  };
  for (let step = 0; step <= MAX_READS; step++) {
    const canFinish = evidence.some(x => x.tool !== "discover_database" && ["ok", "no_data"].includes(x.status));
    body.tools[0].functionDeclarations = declarations
      .filter(fn => (fn.name !== "query_database" || discovered.size > 0) && (fn.name !== "finish" || canFinish))
      .map(fn => fn.name === "query_database" ? { ...fn, parametersJsonSchema: {
        ...fn.parametersJsonSchema, properties: { ...fn.parametersJsonSchema.properties,
          source_id: { type: "string", enum: [...discovered.keys()] },
        },
      } } : fn);
    let response;
    try {
      signal?.throwIfAborted();
      response = await generate(body).catch(error => {
        // A text reply instead of a call: with nothing read yet, ask once more for a function call.
        if (error.message !== "provider_text_reply" || canFinish || reminded) throw error;
        reminded = true;
        return generate({ ...body, contents: [...body.contents, { role: "user", parts: [{ text: CALL_ONE_FUNCTION }] }] });
      });
    } catch (error) {
      // With evidence read, a text reply means the model is done; the server still writes the answer from evidence.
      if (error.message === "provider_text_reply" && canFinish) { stopReason = "complete"; break; }
      if (!evidence.length) throw error;
      stopReason = signal?.aborted ? "cancelled" : "provider_error";
      break;
    }
    let decision;
    try {
      decision = bindDistrictScope(parseToolDecision(response), scope);
      if (hiddenTools.includes(decision.name)) throw new Error("provider_tool_not_allowed");
    }
    catch (error) {
      const call = response?.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
      if (CORRECTIONS[error.message] && CHAT_TOOLS.some(t => t.name === call?.name) && corrections < MAX_CORRECTIONS) {
        correct(response.candidates[0].content, call.name, error.message, CORRECTIONS[error.message](call.name));
        continue;
      }
      if (!evidence.length) {
        const proposedName = call?.name;
        throw new Error("provider_output_invalid", { cause: {
          validation_code: ["provider_tool_call_invalid", "provider_tool_arguments_invalid", "provider_tool_not_allowed"].includes(error.message) ? error.message : "invalid_decision",
          tool: CHAT_TOOLS.some(t => t.name === proposedName) ? proposedName : "unknown_tool",
        } });
      }
      stopReason = "invalid_decision";
      break;
    }
    if (decision.name === "finish") {
      if (!evidence.some(x => x.tool !== "discover_database" && ["ok", "no_data"].includes(x.status))) throw new Error("finish_without_evidence");
      stopReason = "complete";
      break;
    }
    if (decision.name === "conversation" && !CONVERSATIONAL.test(message) && corrections < MAX_CORRECTIONS) {
      correct(response.candidates[0].content, decision.name, "data_question", SEARCH_FIRST);
      continue;
    }
    if (decision.name === "conversation") {
      terminalAnswer = CONVERSATION_REPLIES[decision.args.intent];
      terminalStatus = "ok";
      stopReason = "complete";
      break;
    }
    if (["clarify", "unsupported"].includes(decision.name)) {
      terminalAnswer = decision.args.question ?? decision.args.reason;
      terminalStatus = decision.name;
      stopReason = decision.name;
      break;
    }
    const unsourced = !["discover_database", "search_knowledge"].includes(decision.name) && corrections < MAX_CORRECTIONS &&
      unsourcedCode(decision, [message, ...history.map(turn => turn.text), scope?.district_id ?? ""], JSON.stringify(evidence.filter(x => x.tool !== "discover_database")));
    if (unsourced) {
      correct(response.candidates[0].content, decision.name, "unsourced_code",
        `${unsourced[0]} ${unsourced[2]} "${unsourced[1]}" ไม่ได้มาจากคำถาม ประวัติ หรือข้อมูลที่อ่านได้ ห้ามเดารหัสหรือส่วนของรหัส ` +
        `ถ้าคำถามให้ชื่อ ให้ค้นด้วยชื่อ (search หรือ contains ในคอลัมน์ชื่อ) หรือค้นรหัสจากทะเบียนด้วย discover_database และ query_database ก่อน`);
      continue;
    }
    const signature = JSON.stringify([decision.name, Object.entries(decision.args).sort()]);
    if (seen.has(signature) && corrections < MAX_CORRECTIONS) {
      correct(response.candidates[0].content, decision.name, "repeated_call", REPEATED_CALL);
      continue;
    }
    if (seen.has(signature)) { stopReason = "repeated_tool"; break; }
    // A query the database rejected read nothing, so it spends a step but not the read budget.
    if (evidence.filter(x => x.status !== "invalid_input").length >= MAX_READS) break;
    if (decision.name === "query_database" && !discovered.has(decision.args.source_id)) throw new Error("source_not_discovered");
    seen.add(signature);
    signal?.throwIfAborted();
    const started = Date.now();
    let result;
    try { result = await read(decision); }
    catch (error) {
      // Expired/revoked credentials never produce a successful partial response.
      if (!evidence.length || ["unauthorized", "forbidden"].includes(error.message)) throw error;
      stopReason = "tool_error";
      break;
    }
    if (!result || !["ok", "no_data", "forbidden", "invalid_input", "unavailable"].includes(result.status)) {
      throw new Error("tool_output_invalid");
    }
    result=annotateStockFreshness(result);
    // The database says only invalid_input; name the source's columns and the broken rules so the model can fix its query.
    if (decision.name === "query_database" && result.status === "invalid_input") {
      const schema = discovered.get(decision.args.source_id) ?? {};
      result = { ...result, columns: Object.keys(schema), problems: queryProblems(decision.args, schema, discovered) };
    }
    if (decision.name === "query_database" && result.status === "no_data" && !result.near_matches?.length) {
      const hints = emptyHints(decision.args, discovered.get(decision.args.source_id) ?? {});
      if (hints.length) result = { ...result, hints };
    }
    trace.push({ tool: decision.name, status: result.status, duration_ms: Date.now() - started,
      ...(result.retrieval ? { retrieval: result.retrieval } : {}) });
    evidence.push(result);
    if (decision.name === "discover_database") for (const source of result.data ?? []) discovered.set(source.source_id, source.columns ?? {});
    if (!["ok", "no_data"].includes(result.status) && !(decision.name === "query_database" && result.status === "invalid_input")) { stopReason = result.status; break; }
    // Preserve Gemini thought signatures rather than reconstructing the model turn.
    body.contents.push(response.candidates[0].content);
    if (JSON.stringify(result).length > 40_000) { stopReason = "context_limit"; break; }
    body.contents.push({ role: "user", parts: [{ functionResponse: { name: decision.name, response: result } }] });
  }
  const partial = !["complete", "clarify", "unsupported"].includes(stopReason);
  const rendered = evidence.filter(x => x.tool !== "discover_database").map(x => [x.status, renderToolResult(x, wantsSources(message))]);
  const fromReads = rendered.filter(([status]) => status !== "invalid_input");
  // A rejected query read nothing: the user hears about it once, and only when nothing else was read.
  const findings = [...new Set((fromReads.length ? fromReads : rendered.slice(0, 1)).map(([, line]) => line))];
  const answer = [
    ...findings,
    ...(wantsSources(message) && evidence.some(x => x.retrieval?.stage === "sources" && x.retrieval.status === "fallback_original_order")
      ? ["จัดอันดับแหล่งข้อมูลไม่สำเร็จ ใช้ลำดับค้นหาแหล่งข้อมูลเดิม"] : []),
    ...(terminalAnswer ? [terminalAnswer] : []),
    ...(partial ? [fromReads.length ? "ตรวจสอบได้บางส่วน ยังไม่ครบคำถาม กรุณาระบุ SKU/เขตหรือถามต่ออีกครั้ง"
      : "ยังตอบคำถามนี้ไม่ได้ ลองระบุ SKU หรือชื่อเต็มของวัสดุหรือเขต แล้วถามอีกครั้ง"] : []),
  ].join("\n\n");
  return { answer, evidence, trace, stop_reason: stopReason,
    status: partial ? "partial" : terminalStatus ?? (evidence.some((item) => item.tool !== "discover_database" && item.status === "ok") ? "ok" : "no_data") };
}
