import { publicConfig } from "../../../lib";

// Admin-only account provisioning (create login, reset password) using the
// Supabase Auth admin API. The service role key lives only in the server
// environment (SUPABASE_SERVICE_ROLE_KEY) and never reaches the browser.
// Every call is first authorised as an active admin through the normal
// m09_dispatch /v1/me check with the caller's own token.

export const dynamic = "force-dynamic";

const ASSIGNABLE = new Set(["planner", "academic", "picker", "district", "viewer"]);

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
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

function error(status: number, code: string, message: string, id: string) {
  return json({ error: { code, message, request_id: id } }, status, id);
}

function supabaseOrigin() {
  try {
    const url = new URL(publicConfig.supabaseUrl);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (process.env.NODE_ENV === "production") {
      if (url.protocol !== "https:") return null;
      const allowed = process.env.SUPABASE_ALLOWED_ORIGIN?.trim();
      if (!/^[a-z0-9]{20}\.supabase\.co$/i.test(url.hostname) && url.origin !== allowed) return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
}

async function dispatch(
  origin: string,
  authorization: string,
  method: string,
  path: string,
  body: unknown,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/rest/v1/rpc/m09_dispatch`, {
    method: "POST",
    headers: {
      apikey: publicConfig.supabaseAnonKey,
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_method: method, p_path: path, p_query: {}, p_body: body ?? {}, p_request_id: id }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as { status?: number; body?: unknown } | null;
  return { status: Number(payload?.status ?? response.status), body: payload?.body ?? null };
}

async function authorise(request: Request, id: string) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]{20,}$/.test(authorization)) {
    return { failure: error(401, "unauthorized", "Missing or invalid bearer token", id) };
  }
  const origin = supabaseOrigin();
  if (!origin || !publicConfig.supabaseAnonKey) {
    return { failure: error(503, "service_unavailable", "Supabase is not configured", id) };
  }
  const me = await dispatch(origin, authorization, "GET", "/v1/me", {}, id).catch(() => null);
  const identity = me?.body as { role?: string; user_id?: string } | null;
  if (!me || me.status !== 200 || identity?.role !== "admin") {
    return { failure: error(403, "forbidden", "เฉพาะผู้ดูแลระบบ (admin) เท่านั้น", id) };
  }
  return { origin, authorization, me: identity };
}

function authAdminHeaders(key: string): Record<string, string> {
  // New-style secret keys (sb_secret_…) go in the apikey header only;
  // legacy service_role JWTs are also sent as the bearer token.
  return key.startsWith("sb_secret_")
    ? { apikey: key, "Content-Type": "application/json" }
    : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export async function GET(request: Request) {
  const id = requestId(request);
  const auth = await authorise(request, id);
  if ("failure" in auth) return auth.failure;
  return json({ configured: Boolean(serviceKey()) }, 200, id);
}

type Body = {
  action?: unknown;
  email?: unknown;
  password?: unknown;
  display_name?: unknown;
  role?: unknown;
  district_id?: unknown;
  user_id?: unknown;
};

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function passwordProblem(password: string) {
  if (password.length < 8) return "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร";
  if (password.length > 72) return "รหัสผ่านยาวเกิน 72 ตัวอักษร";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข";
  return "";
}

export async function POST(request: Request) {
  const id = requestId(request);
  const auth = await authorise(request, id);
  if ("failure" in auth) return auth.failure;

  const key = serviceKey();
  if (!key) {
    return error(503, "service_role_not_configured",
      "ยังไม่ได้ตั้งค่า SUPABASE_SERVICE_ROLE_KEY ใน Vercel", id);
  }

  let body: Body;
  try {
    const raw = await request.text();
    if (raw.length > 8_192) return error(413, "payload_too_large", "คำขอมีขนาดใหญ่เกินกำหนด", id);
    body = JSON.parse(raw) as Body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return error(400, "invalid_json", "รูปแบบคำขอไม่ถูกต้อง", id);
  }

  const action = text(body.action, 30);

  if (action === "create") {
    const email = text(body.email, 160).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = text(body.display_name, 120);
    const role = text(body.role, 20);
    const districtId = role === "district" ? text(body.district_id, 4) : "";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(422, "validation_error", "อีเมลไม่ถูกต้อง", id);
    if (displayName.length < 2) return error(422, "validation_error", "กรุณาใส่ชื่อ (อย่างน้อย 2 ตัวอักษร)", id);
    if (!ASSIGNABLE.has(role)) return error(422, "validation_error", "บทบาทไม่ถูกต้อง", id);
    if (role === "district" && !/^55(0[1-9]|1[0-8])$/.test(districtId)) {
      return error(422, "validation_error", "บทบาทเขตต้องเลือกเขต 5501–5518", id);
    }
    const problem = passwordProblem(password);
    if (problem) return error(422, "validation_error", problem, id);

    let created: Response;
    try {
      created = await fetch(`${auth.origin}/auth/v1/admin/users`, {
        method: "POST",
        headers: authAdminHeaders(key),
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { display_name: displayName },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return error(503, "auth_unavailable", "ติดต่อระบบ Login ของ Supabase ไม่ได้", id);
    }
    const user = (await created.json().catch(() => null)) as
      | { id?: string; msg?: string; message?: string; error_code?: string; code?: string | number }
      | null;
    if (!created.ok || !user?.id) {
      const message = String(user?.msg ?? user?.message ?? "");
      const exists = created.status === 422 && /already|registered|exists/i.test(message + (user?.error_code ?? ""));
      if (created.status === 401 || created.status === 403) {
        return error(503, "service_role_invalid", "SUPABASE_SERVICE_ROLE_KEY ใน Vercel ไม่ถูกต้อง", id);
      }
      return error(exists ? 409 : 400, exists ? "email_exists" : "auth_rejected",
        exists ? "อีเมลนี้มีบัญชีอยู่แล้ว — แก้ไขสิทธิ์ได้จากแท็บผู้ใช้ทั้งหมด" : message || "สร้างบัญชีไม่สำเร็จ", id);
    }

    // Role / district through the normal admin route so the audit log shows who did it.
    const assigned = await dispatch(auth.origin, auth.authorization, "POST", `/v1/admin/users/${user.id}`, {
      display_name: displayName,
      role,
      ...(role === "district" ? { district_id: districtId } : {}),
    }, id).catch(() => null);

    if (!assigned || assigned.status !== 200) {
      return json({
        user_id: user.id,
        email,
        role_assigned: false,
        warning: "สร้างบัญชีแล้ว แต่กำหนดบทบาทไม่สำเร็จ — กดแก้ไขที่แถวผู้ใช้นี้เพื่อกำหนดบทบาทอีกครั้ง",
      }, 201, id);
    }
    return json({ user_id: user.id, email, role_assigned: true }, 201, id);
  }

  if (action === "reset_password") {
    const userId = text(body.user_id, 36);
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return error(422, "validation_error", "user_id ไม่ถูกต้อง", id);
    const problem = passwordProblem(password);
    if (problem) return error(422, "validation_error", problem, id);

    const listing = await dispatch(auth.origin, auth.authorization, "GET", "/v1/admin/users", {}, id).catch(() => null);
    const target = ((listing?.body as { users?: Array<{ user_id: string; role: string }> } | null)?.users ?? [])
      .find((row) => row.user_id === userId);
    if (!target) return error(404, "not_found", "ไม่พบผู้ใช้นี้", id);
    if (target.role === "admin" && userId !== auth.me?.user_id) {
      return error(403, "forbidden", "ตั้งรหัสผ่านของผู้ดูแลระบบคนอื่นจากหน้านี้ไม่ได้", id);
    }

    let updated: Response;
    try {
      updated = await fetch(`${auth.origin}/auth/v1/admin/users/${userId}`, {
        method: "PUT",
        headers: authAdminHeaders(key),
        body: JSON.stringify({ password }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return error(503, "auth_unavailable", "ติดต่อระบบ Login ของ Supabase ไม่ได้", id);
    }
    if (!updated.ok) {
      if (updated.status === 401 || updated.status === 403) {
        return error(503, "service_role_invalid", "SUPABASE_SERVICE_ROLE_KEY ใน Vercel ไม่ถูกต้อง", id);
      }
      const payload = (await updated.json().catch(() => null)) as { msg?: string; message?: string } | null;
      return error(400, "auth_rejected", payload?.msg ?? payload?.message ?? "ตั้งรหัสผ่านไม่สำเร็จ", id);
    }
    return json({ user_id: userId, password_reset: true }, 200, id);
  }

  return error(400, "unknown_action", "action ต้องเป็น create หรือ reset_password", id);
}
