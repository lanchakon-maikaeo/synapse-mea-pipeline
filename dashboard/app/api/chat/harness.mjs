import { bindDistrictScope, buildProviderBody, parseToolDecision, renderToolResult } from "./tools.mjs";

export const HARNESS_VERSION = "v2";
export const MAX_READS = 3;

// Model decisions are proposals. This loop owns execution, budgets and completion.
export async function runAgent({ message, history = /** @type {{ role: string, text: string }[]} */ ([]), temperature, scope, signal, generate, read }) {
  const body = buildProviderBody(message, temperature, history);
  const evidence = [];
  const trace = [];
  const seen = new Set();
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
      if (!evidence.length) throw new Error("finish_without_evidence");
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
    trace.push({ tool: decision.name, status: result.status, duration_ms: Date.now() - started });
    evidence.push(result);
    if (!["ok", "no_data"].includes(result.status)) { stopReason = result.status; break; }
    // Preserve Gemini thought signatures rather than reconstructing the model turn.
    body.contents.push(response.candidates[0].content);
    if (JSON.stringify(result).length > 40_000) { stopReason = "context_limit"; break; }
    body.contents.push({ role: "user", parts: [{ functionResponse: { name: decision.name, response: result } }] });
  }
  const partial = !["complete", "clarify", "unsupported"].includes(stopReason);
  const answer = [
    ...evidence.map(renderToolResult),
    ...(terminalAnswer ? [terminalAnswer] : []),
    ...(partial ? ["ตรวจสอบได้บางส่วน ยังไม่ครบคำถาม กรุณาระบุ SKU/เขตหรือถามต่ออีกครั้ง"] : []),
  ].join("\n\n");
  return { answer, evidence, trace, stop_reason: stopReason,
    status: partial ? "partial" : terminalStatus ?? (evidence.some((item) => item.status === "ok") ? "ok" : "no_data") };
}
