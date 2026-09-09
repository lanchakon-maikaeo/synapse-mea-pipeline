import { bindDistrictScope, buildProviderBody, parseToolDecision, renderToolResult, CONVERSATION_REPLIES } from "./tools.mjs";

export const HARNESS_VERSION = "v3";
export const MAX_READS = 6;

// Model decisions are proposals. This loop owns execution, budgets and completion.
export async function runAgent({ message, history = /** @type {{ role: string, text: string }[]} */ ([]), temperature, scope, signal, generate, read }) {
  const body = buildProviderBody(message, temperature, history);
  const evidence = [];
  const trace = [];
  const seen = new Set();
  const discovered = new Set();
  let stopReason = "step_limit";
  let terminalAnswer;
  let terminalStatus;
  for (let step = 0; step <= MAX_READS; step++) {
    let response;
    try {
      signal?.throwIfAborted();
      response = await generate(body);
    } catch (error) {
      if (!evidence.length) throw error;
      stopReason = signal?.aborted ? "cancelled" : "provider_error";
      break;
    }
    let decision;
    try { decision = bindDistrictScope(parseToolDecision(response), scope); }
    catch {
      if (!evidence.length) throw new Error("provider_output_invalid");
      stopReason = "invalid_decision";
      break;
    }
    if (decision.name === "finish") {
      if (!evidence.some(x => x.tool !== "discover_database" && ["ok", "no_data"].includes(x.status))) throw new Error("finish_without_evidence");
      stopReason = "complete";
      break;
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
    const signature = JSON.stringify([decision.name, Object.entries(decision.args).sort()]);
    if (seen.has(signature)) { stopReason = "repeated_tool"; break; }
    if (evidence.length >= MAX_READS) break;
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
    trace.push({ tool: decision.name, status: result.status, duration_ms: Date.now() - started,
      ...(result.retrieval ? { retrieval: result.retrieval } : {}) });
    evidence.push(result);
    if (decision.name === "discover_database") for (const source of result.data ?? []) discovered.add(source.source_id);
    if (!["ok", "no_data"].includes(result.status) && !(decision.name === "query_database" && result.status === "invalid_input")) { stopReason = result.status; break; }
    // Preserve Gemini thought signatures rather than reconstructing the model turn.
    body.contents.push(response.candidates[0].content);
    if (JSON.stringify(result).length > 40_000) { stopReason = "context_limit"; break; }
    body.contents.push({ role: "user", parts: [{ functionResponse: { name: decision.name, response: result } }] });
  }
  const partial = !["complete", "clarify", "unsupported"].includes(stopReason);
  const answer = [
    ...evidence.filter(x => x.tool !== "discover_database").map(renderToolResult),
    ...(terminalAnswer ? [terminalAnswer] : []),
    ...(partial ? ["ตรวจสอบได้บางส่วน ยังไม่ครบคำถาม กรุณาระบุ SKU/เขตหรือถามต่ออีกครั้ง"] : []),
  ].join("\n\n");
  return { answer, evidence, trace, stop_reason: stopReason,
    status: partial ? "partial" : terminalStatus ?? (evidence.some((item) => item.tool !== "discover_database" && item.status === "ok") ? "ok" : "no_data") };
}
