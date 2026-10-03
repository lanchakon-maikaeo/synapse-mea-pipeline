import { publicConfig } from "../../lib";

export const dynamic = "force-dynamic";

const allowedRoles = new Set([
  "district",
  "planner",
  "academic",
  "picker",
  "viewer",
]);

type AccessRequestBody = {
  fullName?: unknown;
  employeeId?: unknown;
  workEmail?: unknown;
  organizationUnit?: unknown;
  requestedRole?: unknown;
  reason?: unknown;
};

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return supplied.length > 0 &&
    supplied.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function json(body: unknown, status: number, id: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-ID": id,
    },
  });
}

function error(status: number, code: string, message: string, id: string) {
  return json({ error: { code, message, request_id: id } }, status, id);
}

function field(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function supabaseOrigin() {
  try {
    const url = new URL(publicConfig.supabaseUrl);
    if (
      !/^https:$/.test(url.protocol) ||
      !/^[a-z0-9]{20}\.supabase\.co$/i.test(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > 16_384) {
    return error(413, "payload_too_large", "คำขอมีขนาดใหญ่เกินกำหนด", id);
  }

  let body: AccessRequestBody;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 16_384) {
      return error(413, "payload_too_large", "คำขอมีขนาดใหญ่เกินกำหนด", id);
    }
    body = JSON.parse(rawBody) as AccessRequestBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return error(400, "invalid_json", "รูปแบบคำขอไม่ถูกต้อง", id);
  }

  const fullName = field(body.fullName, 120);
  const employeeId = field(body.employeeId, 30);
  const workEmail = field(body.workEmail, 160).toLowerCase();
  const organizationUnit = field(body.organizationUnit, 160);
  const requestedRole = field(body.requestedRole, 24);
  const reason = field(body.reason, 800);

  if (
    fullName.length < 2 ||
    !/^[A-Za-z0-9._/-]{2,30}$/.test(employeeId) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail) ||
    organizationUnit.length < 2 ||
    !allowedRoles.has(requestedRole) ||
    reason.length < 10
  ) {
    return error(
      422,
      "validation_error",
      "กรุณาตรวจสอบชื่อ รหัสพนักงาน อีเมล หน่วยงาน บทบาท และเหตุผลให้ครบถ้วน",
      id,
    );
  }

  const origin = supabaseOrigin();
  if (!origin || !publicConfig.supabaseAnonKey) {
    return error(
      503,
      "access_request_unavailable",
      "ระบบรับคำขอยังไม่ได้เชื่อมต่อ กรุณาติดต่อผู้ดูแลระบบ",
      id,
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${origin}/rest/v1/rpc/m15_submit_access_request`,
      {
        method: "POST",
        headers: {
          apikey: publicConfig.supabaseAnonKey,
          Authorization: `Bearer ${publicConfig.supabaseAnonKey}`,
          "Content-Type": "application/json",
          "X-Client-Info": "mea-synapse-access-request/1.0",
        },
        body: JSON.stringify({
          p_full_name: fullName,
          p_employee_id: employeeId,
          p_work_email: workEmail,
          p_organization_unit: organizationUnit,
          p_requested_role: requestedRole,
          p_reason: reason,
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return error(
      503,
      "access_request_unavailable",
      "ระบบรับคำขอยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ",
      id,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | {
        request_id?: string;
        request_number?: string;
        status?: string;
        message?: string;
      }
    | null;

  if (!response.ok || !payload?.request_number) {
    const unavailable = response.status === 404;
    const validationMessage = response.ok ? payload?.message : null;
    return error(
      unavailable ? 503 : 400,
      unavailable ? "access_request_not_deployed" : "access_request_rejected",
      unavailable
        ? "ระบบรับคำขอยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ"
        : validationMessage ?? "ไม่สามารถบันทึกคำขอได้",
      id,
    );
  }

  return json(
    {
      request_id: payload.request_id,
      request_number: payload.request_number,
      status: payload.status ?? "pending",
    },
    201,
    id,
  );
}
