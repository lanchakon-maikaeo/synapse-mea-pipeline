import { bindDistrictScope, buildProviderBody, parseToolDecision, renderToolResult, wantsSources, CONVERSATION_REPLIES, CHAT_TOOLS, annotateStockFreshness } from "./tools.mjs";

export const HARNESS_VERSION = "v4";
export const MAX_READS = 6;

// Model decisions are proposals. This loop owns execution, budgets and completion.
export async function runAgent({ message, history = /** @type {{ role: string, text: string }[]} */ ([]), temperature, scope, signal, generate, read }) {
  const body = buildProviderBody(message, temperature, history);
  const declarations = body.tools[0].functionDeclarations;
  const evidence = [];
  const trace = [];
  const seen = new Set();
  const discovered = new Set();
  let stopReason = "step_limit";
  let terminalAnswer;
  let terminalStatus;
  for (let step = 0; step <= MAX_READS; step++) {
    const canFinish = evidence.some(x => x.tool !== "discover_database" && ["ok", "no_data"].includes(x.status));
    body.tools[0].functionDeclarations = declarations
      .filter(fn => (fn.name !== "query_database" || discovered.size > 0) && (fn.name !== "finish" || canFinish))
      .map(fn => fn.name === "query_database" ? { ...fn, parametersJsonSchema: {
        ...fn.parametersJsonSchema, properties: { ...fn.parametersJsonSchema.properties,
          source_id: { type: "string", enum: [...discovered] },
        },
      } } : fn);
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
    catch (error) {
      if (!evidence.length) {
        const proposedName = response?.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall?.name;
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
    result=annotateStockFreshness(result);
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
    ...evidence.filter(x => x.tool !== "discover_database").map(x => renderToolResult(x, wantsSources(message))),
    ...(wantsSources(message) && evidence.some(x => x.retrieval?.stage === "sources" && x.retrieval.status === "fallback_original_order")
      ? ["จัดอันดับแหล่งข้อมูลไม่สำเร็จ ใช้ลำดับค้นหาแหล่งข้อมูลเดิม"] : []),
    ...(terminalAnswer ? [terminalAnswer] : []),
    ...(partial ? ["ตรวจสอบได้บางส่วน ยังไม่ครบคำถาม กรุณาระบุ SKU/เขตหรือถามต่ออีกครั้ง"] : []),
  ].join("\n\n");
  return { answer, evidence, trace, stop_reason: stopReason,
    status: partial ? "partial" : terminalStatus ?? (evidence.some((item) => item.tool !== "discover_database" && item.status === "ok") ? "ok" : "no_data") };
}
