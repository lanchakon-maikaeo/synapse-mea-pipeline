import { publicConfig } from "../../lib";
import { controlledSupabaseOrigin } from "../supabase-server";
import {
  validateHistory,
} from "./tools.mjs";

import { runAgent, HARNESS_VERSION } from "./harness.mjs";
import { retrieveDatabase } from "./retrieval.mjs";
import { embedText, providerErrorCode } from "./embedding.mjs";
import { composeAnswer } from "./answer.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Scope = { role?: string; district_id?: string | null };
type Admission = { status?: string; scope?: Scope; warnings?: string[] };
type ToolDecision = { name: string; args: Record<string, unknown> };
type ToolEnvelope = {
  request_id?: string;
  view?: string;
  tool?: string;
  status?: string;
  data?: unknown[];
  data_as_of?: unknown;
  scope?: Scope & { truncated?: boolean };
  sources?: unknown[];
  warnings?: string[];
};

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  Vary: "Authorization",
};

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

function failure(status: number, code: string, message: string, requestId: string) {
  return reply({ error: { code, message, request_id: requestId } }, status);
}

function providerConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
  const model = process.env.LLM_MODEL?.trim() || "gemini-3.5-flash-lite";
  const rawTemperature = process.env.LLM_TEMPERATURE?.trim() || "0";
  const rawTimeout = process.env.LLM_TIMEOUT_MS?.trim() || "30000";
  const temperature = Number(rawTemperature);
  const timeoutMs = Number(rawTimeout);
  let apiUrl: URL;
  try {
    apiUrl = new URL(process.env.LLM_API_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/");
  } catch {
    return null;
  }
  const secureUrl = apiUrl.protocol === "https:" ||
    (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname));
  if (!apiKey || !/^gemini-[A-Za-z0-9._-]{1,100}$/.test(model) || !secureUrl ||
      apiUrl.username || apiUrl.password || !Number.isFinite(temperature) ||
      temperature < 0 || temperature > 2 || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 || timeoutMs > 40_000) return null;
  apiUrl.pathname = `${apiUrl.pathname.replace(/\/?$/, "/")}models/${model}:generateContent`;
  return { apiKey, model, temperature, timeoutMs, apiUrl: apiUrl.toString() };
}

async function supabaseRpc<T>(name: string, body: unknown, authorization: string, signal: AbortSignal): Promise<T> {
  const origin = controlledSupabaseOrigin();
  if (!origin || !publicConfig.supabaseAnonKey) throw new Error("supabase_not_configured");
  const response = await fetch(`${origin}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publicConfig.supabaseAnonKey,
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new Error("unauthorized");
    if (response.status === 403) throw new Error("forbidden");
    throw new Error("supabase_unavailable");
  }
  return await response.json() as T;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/.test(authorization)) {
    return failure(401, "unauthorized", "กรุณาเข้าสู่ระบบอีกครั้ง", requestId);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    return failure(413, "payload_too_large", "ข้อความยาวเกินขนาดที่กำหนด", requestId);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 65_536) return failure(413, "payload_too_large", "ข้อความยาวเกินขนาดที่กำหนด", requestId);
    body = JSON.parse(raw);
  } catch {
    return failure(422, "invalid_input", "รูปแบบคำขอไม่ถูกต้อง", requestId);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["message", "history"].includes(key))) {
    return failure(422, "invalid_input", "คำขอมีข้อมูลที่ระบบไม่รองรับ", requestId);
  }
  const message = typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message.trim()
    : "";
  if (!message || message.length > 2_000) {
    return failure(422, "invalid_input", "กรุณาพิมพ์คำถามไม่เกิน 2,000 ตัวอักษร", requestId);
  }
  let history: { role: string; text: string }[];
  try { history = validateHistory((body as { history?: unknown }).history); }
  catch { return failure(422, "invalid_input", "ประวัติแชทยาวเกินหรือรูปแบบไม่ถูกต้อง", requestId); }
  const config = providerConfig();
  if (!config) {
    return failure(503, "provider_not_configured", "ยังไม่ได้ตั้งค่าบริการแชท", requestId);
  }

  const overall = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
  let admission: Admission;
  try {
    admission = await supabaseRpc<Admission>("vmi_chat_admit", { p_request_id: requestId }, authorization, overall);
  } catch (error) {
    const code = error instanceof Error ? error.message : "supabase_unavailable";
    if (code === "unauthorized") return failure(401, code, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง", requestId);
    if (code === "forbidden") return failure(403, code, "บัญชีนี้ไม่มีสิทธิ์ใช้แชท", requestId);
    return failure(503, code, "ระบบยืนยันสิทธิ์ไม่พร้อมใช้งาน", requestId);
  }
  if (admission.status === "forbidden") return failure(403, "forbidden", "บัญชีนี้ไม่มีสิทธิ์ใช้แชท", requestId);
  if (admission.status !== "ok") return failure(429, "rate_limited", "ใช้งานครบ 10 ครั้งต่อนาที กรุณารอสักครู่", requestId);

  let result;
  let modelCalls = 0;
  let totalTokens = 0;
  const topK = Number(process.env.LLM_RETRIEVAL_TOP_K ?? "6");
  if (!Number.isInteger(topK) || topK < 1 || topK > 12) return failure(503, "retrieval_not_configured", "ค่า retrieval top-k ต้องเป็นจำนวนเต็ม 1–12", requestId);
  const generate = async (body: unknown, limit = 12) => {
    if (modelCalls >= limit) throw new Error("model_call_limit");
    modelCalls++;
    const response = await fetch(config.apiUrl, {
      method: "POST", headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error",
      signal: AbortSignal.any([overall, AbortSignal.timeout(config.timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(providerErrorCode(response.status));
    }
    const payload = await response.json();
    const tokens = payload?.usageMetadata?.totalTokenCount;
    if (Number.isSafeInteger(tokens) && tokens >= 0) totalTokens += tokens;
    return payload;
  };
  try {
    result = await runAgent({
      message, history, temperature: config.temperature, scope: admission.scope, signal: overall,
      generate,
      read: async (decision: ToolDecision) => decision.name === "search_knowledge"
        ? supabaseRpc<ToolEnvelope>("vmi_chat_knowledge", {
          p_embedding: await embedText({ text: String(decision.args.query), apiKey: config.apiKey,
            signal: AbortSignal.any([overall, AbortSignal.timeout(config.timeoutMs)]) }),
          p_limit: topK,
        }, authorization, overall)
        : ["discover_database", "query_database"].includes(decision.name)
        ? retrieveDatabase({ decision, question: message, generate, topK,
          rpc: (query: ToolDecision) => supabaseRpc("vmi_chat_database", {
            p_tool: query.name, p_args: query.args, p_request_id: requestId,
          }, authorization, overall) })
        : supabaseRpc<ToolEnvelope>(decision.name === "get_operations_overview" ? "vmi_chat_overview" : "vmi_chat_read", {
          p_tool: decision.name, p_args: decision.args, p_request_id: requestId,
        }, authorization, overall),
    });
    // Reserve at most two extra calls for writing/review; same overall deadline.
    result = await composeAnswer({ result, question: message, history, signal: overall,
      generate: (body: unknown) => generate(body, 14) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "agent_unavailable";
    const status = code === "unauthorized" ? 401 : code === "forbidden" ? 403 : code === "provider_rate_limited" ? 429 : 503;
    console.warn(JSON.stringify({ event: "chat_run_failed", request_id: requestId, harness: HARNESS_VERSION,
      http_status: status, model_calls: modelCalls, total_tokens: totalTokens, duration_ms: Date.now() - startedAt }));
    const message = code === "provider_billing_required"
      ? "บริการ AI ยังใช้งานไม่ได้ กรุณาให้ผู้ดูแลระบบตรวจ billing และโควตาของผู้ให้บริการ"
      : code === "provider_rate_limited"
        ? "บริการ AI ใช้งานเกินโควตาชั่วคราว กรุณาลองใหม่ภายหลัง"
        : "ค้นและตรวจข้อมูลไม่สำเร็จ กรุณาลองใหม่ภายหลัง";
    return failure(status, code, message, requestId);
  }
  // Operational trace excludes prompts, keys, JWTs, tool arguments and business rows.
  console.info(JSON.stringify({ event: "chat_run", request_id: requestId, harness: HARNESS_VERSION,
    model: config.model, model_calls: modelCalls, top_k: topK, status: result.status, stop_reason: result.stop_reason,
    answer_mode: result.answer_mode, answer_validation: result.answer_validation,
    total_tokens: totalTokens, duration_ms: Date.now() - startedAt, steps: result.trace }));
  const evidence = result.evidence as ToolEnvelope[];
  const envelope = evidence[0];

  return reply({
    request_id: requestId,
    status: result.status,
    tool: envelope?.tool,
    answer: result.answer,
    answer_mode: result.answer_mode,
    answer_validation: result.answer_validation,
    harness: HARNESS_VERSION,
    model_calls: modelCalls,
    stop_reason: result.stop_reason,
    steps: result.trace,
    data_as_of: evidence.map((item) => item.data_as_of),
    scope: envelope?.scope ?? admission.scope,
    sources: [...new Set(evidence.flatMap((item) => item.sources ?? []))],
    warnings: evidence.flatMap((item) => item.warnings ?? []),
    model: config.model,
  });
}
