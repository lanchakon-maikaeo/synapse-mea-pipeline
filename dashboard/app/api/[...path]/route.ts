import { publicConfig } from "../../lib";
import { m09OpenApi } from "../../m09-openapi";
import {
  isLoopbackHost,
  triggerOptimizationWorker,
} from "../optimization-worker";
import {
  optimizeRoadRoute,
  roadRequestFromCanonicalGate,
  RoutingError,
} from "../../route-optimizer";

export const dynamic = "force-dynamic";

const maxBodyBytes = 1_048_576;

type DispatchResponse = {
  status?: number;
  body?: unknown;
};

function controlledSupabaseOrigin() {
  const configured = publicConfig.supabaseUrl.trim();
  if (!configured) return null;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  if (process.env.NODE_ENV === "production") {
    if (url.protocol !== "https:" || isLoopbackHost(url.hostname)) {
      return null;
    }

    // Standard hosted projects use a 20-character project ref. A custom
    // domain must be pinned independently in a server-only environment
    // variable so an accidentally supplied public relay cannot become an
    // authenticated SSRF destination.
    const hostedProject = /^[a-z0-9]{20}\.supabase\.co$/i.test(url.hostname);
    const explicitlyAllowed = process.env.SUPABASE_ALLOWED_ORIGIN?.trim();
    let allowedCustomOrigin = "";
    if (explicitlyAllowed) {
      try {
        const allowed = new URL(explicitlyAllowed);
        if (
          allowed.protocol === "https:" &&
          !allowed.username &&
          !allowed.password &&
          allowed.pathname === "/" &&
          !allowed.search &&
          !allowed.hash &&
          !isLoopbackHost(allowed.hostname)
        ) {
          allowedCustomOrigin = allowed.origin;
        }
      } catch {
        return null;
      }
    }
    if (!hostedProject && url.origin !== allowedCustomOrigin) return null;
  }

  return url.origin;
}

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return supplied.length > 0 &&
    supplied.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function hasValidSuppliedRequestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return (
    supplied.length > 0 &&
    supplied.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(supplied)
  );
}

function json(body: unknown, status: number, id: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-ID": id,
      Vary: "Authorization",
    },
  });
}

function error(
  status: number,
  code: string,
  message: string,
  id: string,
  details: unknown = null,
) {
  return json({ error: { code, message, request_id: id, details } }, status, id);
}

async function bodyFrom(request: Request, id: string) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return {
      response: error(
        413,
        "payload_too_large",
        "Request body exceeds configured limit",
        id,
      ),
    };
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return {
          response: error(
            413,
            "payload_too_large",
            "Request body exceeds configured limit",
            id,
          ),
        };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text) return { body: {} };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return {
      response: error(
        422,
        "validation_error",
        "Request body must be valid JSON",
        id,
      ),
    };
  }
}

async function dispatchRpc({
  dispatcher,
  authorization,
  method,
  path,
  query,
  body,
  id,
}: {
  dispatcher: string;
  authorization: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  id: string;
}): Promise<DispatchResponse | Response> {
  const supabaseOrigin = controlledSupabaseOrigin();
  if (!supabaseOrigin || !publicConfig.supabaseAnonKey) {
    return error(
      503,
      "service_unavailable",
      "Supabase is not configured with a controlled origin",
      id,
    );
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${supabaseOrigin}/rest/v1/rpc/${dispatcher}`,
      {
        method: "POST",
        headers: {
          apikey: publicConfig.supabaseAnonKey,
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_method: method,
          p_path: path,
          p_query: query,
          p_body: body ?? {},
          p_request_id: id,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return error(
      503,
      "service_unavailable",
      "Supabase API is unavailable",
      id,
    );
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    const status =
      upstream.status === 401 || upstream.status === 403
        ? upstream.status
        : 502;
    return error(
      status,
      status === 502
        ? "upstream_error"
        : status === 403
          ? "forbidden"
          : "unauthorized",
      "Supabase API request failed",
      id,
    );
  }
  try {
    return (await upstream.json()) as DispatchResponse;
  } catch {
    return error(
      502,
      "upstream_error",
      "Supabase API returned an invalid response",
      id,
    );
  }
}

async function databaseReady(id: string) {
  const supabaseOrigin = controlledSupabaseOrigin();
  if (!supabaseOrigin || !publicConfig.supabaseAnonKey) {
    return error(
      503,
      "service_unavailable",
      "Database is not configured with a controlled origin",
      id,
    );
  }
  let ready: Response;
  try {
    ready = await fetch(
      `${supabaseOrigin}/rest/v1/rpc/m09_health`,
      {
        method: "POST",
        headers: {
          apikey: publicConfig.supabaseAnonKey,
          "Content-Type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    return error(503, "service_unavailable", "Database is unavailable", id);
  }
  if (!ready.ok) {
    return error(503, "service_unavailable", "Database is not ready", id);
  }
  try {
    const readiness = (await ready.json()) as {
      operational_ready?: boolean;
    };
    return json(
      readiness,
      readiness.operational_ready === false ? 503 : 200,
      id,
    );
  } catch {
    return error(
      503,
      "service_unavailable",
      "Database readiness response is invalid",
      id,
    );
  }
}

async function handle(request: Request) {
  const id = requestId(request);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return json(
      { status: "ok", service: "synapse-api", version: "v1" },
      200,
      id,
    );
  }

  if (request.method === "GET" && path === "/openapi.json") {
    return json(m09OpenApi, 200, id);
  }

  if (request.method === "GET" && path === "/health/ready") {
    return databaseReady(id);
  }

  if (!path.startsWith("/v1/")) {
    return error(404, "not_found", "API path not found", id);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return error(401, "unauthorized", "Missing bearer token", id);
  }

  if (
    request.method === "POST" &&
    path === "/v1/transport/optimization-jobs" &&
    !hasValidSuppliedRequestId(request)
  ) {
    return error(
      422,
      "validation_error",
      "A valid X-Request-ID header is required for route-job idempotency",
      id,
    );
  }

  const parsed =
    request.method === "POST" ? await bodyFrom(request, id) : { body: {} };
  if ("response" in parsed && parsed.response) return parsed.response;

  if (
    request.method === "GET" &&
    path === "/v1/transport/readiness"
  ) {
    // Readiness stays useful when the worker is temporarily unavailable; the
    // database contract will report the heartbeat gate as blocked.
    await triggerOptimizationWorker("heartbeat", id).catch(() => undefined);
  }

  if (
    request.method === "POST" &&
    path === "/v1/transport/optimization-jobs"
  ) {
    try {
      await triggerOptimizationWorker("heartbeat", id);
    } catch {
      return error(
        503,
        "optimization_worker_unavailable",
        "Optimization worker readiness could not be established",
        id,
      );
    }
  }

  if (request.method === "POST" && path === "/v1/transport/optimize") {
    try {
      const gate = await dispatchRpc({
        dispatcher: "m13_transport_dispatch",
        authorization,
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        body: parsed.body,
        id,
      });
      if (gate instanceof Response) return gate;
      const gateStatus = Number(gate.status ?? 500);
      if (gateStatus !== 200) return json(gate.body ?? null, gateStatus, id);
      const canonical = roadRequestFromCanonicalGate(gate.body);
      const result = await optimizeRoadRoute(canonical.request);
      return json(
        {
          ...result,
          replenishmentPlanId: canonical.gate.replenishment_plan_id,
          coordinateProvenance: {
            depot: {
              id: canonical.gate.depot.id,
              verifiedAt: canonical.gate.depot.verified_at ?? null,
              sourceReference:
                canonical.gate.depot.source_reference ?? null,
              sourceChecksumSha256:
                canonical.gate.depot.source_checksum_sha256 ?? null,
              sourceRowNumber:
                canonical.gate.depot.source_row_number ?? null,
            },
            stops: canonical.gate.stops.map((stop) => ({
              id: stop.id,
              verifiedAt: stop.verified_at ?? null,
              sourceReference: stop.source_reference ?? null,
              sourceChecksumSha256:
                stop.source_checksum_sha256 ?? null,
              sourceRowNumber: stop.source_row_number ?? null,
            })),
          },
          monetaryTollEstimateAvailable: false,
          monetaryTollEstimateStatus:
            canonical.gate.monetary_toll_estimate_status ??
            "unavailable_route_tariff_mapping_not_configured",
        },
        200,
        id,
      );
    } catch (routingError) {
      if (routingError instanceof RoutingError) {
        return error(
          routingError.status,
          routingError.code,
          routingError.message,
          id,
        );
      }
      return error(
        500,
        "routing_internal_error",
        "Road route optimization failed",
        id,
      );
    }
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const legacySourcePath =
    path === "/v1/reference/materials" ||
    path === "/v1/warehouse-stock" ||
    path === "/v1/data-sources/legacy/status" ||
    path === "/v1/admin/import/legacy";
  const inputPipelinePath =
    path === "/v1/reference/districts" ||
    path === "/v1/data-inputs/vmi" ||
    path === "/v1/data-inputs/vmi/context";
  const transportPath = path.startsWith("/v1/transport/");
  // /v1/source-imports/promotion (M24) lives in m09_dispatch; the rest is the Import Center dispatcher.
  const sourceImportPath = path.startsWith("/v1/source-imports/") && path !== "/v1/source-imports/promotion";
  const dispatcher = sourceImportPath
    ? "srcimp_dispatch"
    : transportPath
    ? "m13_transport_dispatch"
    : legacySourcePath
      ? "m11_legacy_dispatch"
      : inputPipelinePath
        ? "m10_input_dispatch"
        : "m09_dispatch";
  const dispatched = await dispatchRpc({
    dispatcher,
    authorization,
    method: request.method,
    path,
    query,
    body: parsed.body,
    id,
  });
  if (dispatched instanceof Response) return dispatched;
  const status = Number(dispatched.status ?? 500);
  if (
    request.method === "POST" &&
    path === "/v1/transport/optimization-jobs" &&
    status >= 200 &&
    status < 300
  ) {
    try {
      await triggerOptimizationWorker("run-once", id);
    } catch {
      return error(
        503,
        "optimization_worker_dispatch_failed",
        "The idempotent optimization job was accepted but worker execution could not be started; retry with the same X-Request-ID",
        id,
      );
    }
  }
  return json(dispatched.body ?? null, status, id);
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
