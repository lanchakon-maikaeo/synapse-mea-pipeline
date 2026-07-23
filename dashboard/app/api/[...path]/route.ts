import { publicConfig } from "../../lib";
import { m09OpenApi } from "../../m09-openapi";

export const dynamic = "force-dynamic";

const maxBodyBytes = 1_048_576;

type DispatchResponse = {
  status?: number;
  body?: unknown;
};

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return supplied.length <= 64 && /^[A-Za-z0-9_-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
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
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    return {
      response: error(
        413,
        "payload_too_large",
        "Request body exceeds configured limit",
        id,
      ),
    };
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
    const ready = await fetch(
      `${publicConfig.supabaseUrl}/rest/v1/rpc/m09_health`,
      {
        method: "POST",
        headers: {
          apikey: publicConfig.supabaseAnonKey,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!ready.ok) {
      return error(503, "service_unavailable", "Database is not ready", id);
    }
    return json(await ready.json(), 200, id);
  }

  if (!path.startsWith("/v1/")) {
    return error(404, "not_found", "API path not found", id);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return error(401, "unauthorized", "Missing bearer token", id);
  }

  const parsed =
    request.method === "POST" ? await bodyFrom(request, id) : { body: {} };
  if ("response" in parsed && parsed.response) return parsed.response;

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
  const dispatcher = legacySourcePath
    ? "m11_legacy_dispatch"
    : inputPipelinePath
      ? "m10_input_dispatch"
      : "m09_dispatch";
  const upstream = await fetch(
    `${publicConfig.supabaseUrl}/rest/v1/rpc/${dispatcher}`,
    {
      method: "POST",
      headers: {
        apikey: publicConfig.supabaseAnonKey,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_method: request.method,
        p_path: path,
        p_query: query,
        p_body: parsed.body ?? {},
        p_request_id: id,
      }),
    },
  );

  if (!upstream.ok) {
    const details = await upstream.json().catch(() => null);
    const status =
      upstream.status === 401 || upstream.status === 403
        ? upstream.status
        : 502;
    return error(
      status,
      status === 502 ? "upstream_error" : "unauthorized",
      "Supabase API request failed",
      id,
      details,
    );
  }

  const dispatched = (await upstream.json()) as DispatchResponse;
  const status = Number(dispatched.status ?? 500);
  return json(dispatched.body ?? null, status, id);
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
