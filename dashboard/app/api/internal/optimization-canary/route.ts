import { publicConfig } from "../../../lib";
import {
  triggerOptimizationWorker,
  WorkerDispatchError,
} from "../../optimization-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const productionProjectHost = "fvdfduuanfrncrwuareb.supabase.co";

function response(status: number, body: unknown, requestId: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-ID": requestId,
    },
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function productionSupabaseOrigin() {
  const configured = publicConfig.supabaseUrl.trim();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== productionProjectHost ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.origin;
}

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    return response(422, { error: { code: "invalid_request_id" } }, requestId);
  }

  const raw = await request.text();
  if (raw.length > 512) {
    return response(413, { error: { code: "request_too_large" } }, requestId);
  }
  let token = "";
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    token = typeof parsed.token === "string" ? parsed.token : "";
  } catch {
    return response(422, { error: { code: "invalid_request" } }, requestId);
  }
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return response(401, { error: { code: "invalid_capability" } }, requestId);
  }

  const origin = productionSupabaseOrigin();
  const publishableKey = publicConfig.supabaseAnonKey.trim();
  if (!origin || !publishableKey || /[\r\n]/.test(publishableKey)) {
    return response(503, { error: { code: "database_not_configured" } }, requestId);
  }

  const consumed = await fetch(
    `${origin}/rest/v1/rpc/m14c_consume_worker_trigger`,
    {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token_sha256: await sha256(token) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);
  if (!consumed?.ok) {
    await consumed?.body?.cancel().catch(() => undefined);
    return response(401, { error: { code: "invalid_capability" } }, requestId);
  }
  const capability = (await consumed.json()) as {
    accepted?: boolean;
    route_job_id?: string;
  };
  if (!capability.accepted || !capability.route_job_id) {
    return response(401, { error: { code: "invalid_capability" } }, requestId);
  }

  try {
    await triggerOptimizationWorker("run-once", requestId);
  } catch (error) {
    const code =
      error instanceof WorkerDispatchError
        ? "optimization_worker_unavailable"
        : "optimization_worker_failed";
    return response(
      503,
      {
        error: { code },
        route_job_id: capability.route_job_id,
        capability_consumed: true,
      },
      requestId,
    );
  }
  return response(
    200,
    {
      status: "worker_iteration_completed",
      route_job_id: capability.route_job_id,
    },
    requestId,
  );
}
