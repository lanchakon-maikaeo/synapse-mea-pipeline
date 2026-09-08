import { publicConfig } from "../../lib";
import { controlledSupabaseOrigin } from "../supabase-server";
import {
  bindDistrictScope,
  buildProviderBody,
  parseToolDecision,
  renderToolResult,
} from "./tools.mjs";

export const dynamic = "force-dynamic";

type Scope = { role?: string; district_id?: string | null };
type Admission = { status?: string; scope?: Scope; warnings?: string[] };
type ToolDecision = { name: string; args: Record<string, string> };
type ToolEnvelope = {
  request_id?: string;
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
  const requestId = crypto.randomUUID();
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/.test(authorization)) {
    return failure(401, "unauthorized", "กรุณาเข้าสู่ระบบอีกครั้ง", requestId);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 8_192) {
    return failure(413, "payload_too_large", "ข้อความยาวเกินขนาดที่กำหนด", requestId);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 8_192) return failure(413, "payload_too_large", "ข้อความยาวเกินขนาดที่กำหนด", requestId);
    body = JSON.parse(raw);
  } catch {
    return failure(422, "invalid_input", "รูปแบบคำขอไม่ถูกต้อง", requestId);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "message")) {
    return failure(422, "invalid_input", "คำขอมีข้อมูลที่ระบบไม่รองรับ", requestId);
  }
  const message = typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message.trim()
    : "";
  if (!message || message.length > 2_000) {
    return failure(422, "invalid_input", "กรุณาพิมพ์คำถามไม่เกิน 2,000 ตัวอักษร", requestId);
  }
  const config = providerConfig();
  if (!config) {
    return failure(503, "provider_not_configured", "ยังไม่ได้ตั้งค่า Commercial LLM API", requestId);
  }

  const overall = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
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

  let providerResponse: unknown;
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey,
        "x-goog-api-client": "synapse-mea-poc2/0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildProviderBody(message, config.temperature)),
      redirect: "error",
      signal: AbortSignal.any([overall, AbortSignal.timeout(config.timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failure(response.status === 429 ? 429 : 503, "provider_unavailable",
        response.status === 429 ? "LLM ใช้งานครบโควตาชั่วคราว" : "LLM ไม่พร้อมใช้งานชั่วคราว", requestId);
    }
    providerResponse = await response.json();
  } catch {
    return failure(503, "provider_unavailable", "LLM ไม่พร้อมใช้งานชั่วคราว", requestId);
  }

  let decision: ToolDecision;
  try {
    decision = bindDistrictScope(parseToolDecision(providerResponse), admission.scope) as ToolDecision;
  } catch {
    return failure(502, "provider_output_invalid", "LLM ส่งผลลัพธ์ที่ตรวจสอบไม่ได้", requestId);
  }
  if (decision.name === "clarify") {
    return reply({ request_id: requestId, status: "clarify", answer: decision.args.question, model: config.model });
  }
  if (decision.name === "unsupported") {
    return reply({ request_id: requestId, status: "unsupported", answer: decision.args.reason, model: config.model });
  }

  let envelope: ToolEnvelope;
  try {
    envelope = await supabaseRpc<ToolEnvelope>("vmi_chat_read", {
      p_tool: decision.name,
      p_args: decision.args,
      p_request_id: requestId,
    }, authorization, overall);
  } catch (error) {
    const code = error instanceof Error ? error.message : "supabase_unavailable";
    return failure(code === "unauthorized" ? 401 : code === "forbidden" ? 403 : 503,
      code, "ไม่สามารถอ่านข้อมูล Supabase ได้", requestId);
  }

  return reply({
    request_id: requestId,
    status: envelope.status,
    tool: decision.name,
    answer: renderToolResult(envelope),
    data_as_of: envelope.data_as_of,
    scope: envelope.scope,
    sources: envelope.sources,
    warnings: envelope.warnings,
    model: config.model,
  });
}
