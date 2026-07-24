export type Role =
  | "admin"
  | "planner"
  | "academic"
  | "picker"
  | "viewer"
  | "district";

export type Identity = {
  user_id: string;
  role: Role;
  district_id: string | null;
};

export type ApiError = {
  error?: { code?: string; message?: string; request_id?: string };
};

// These are Supabase browser credentials, not secrets. A service-role key must
// never be added here or to any NEXT_PUBLIC_* variable.
export const publicConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  apiBaseUrl: (process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api").replace(/\/$/, ""),
};

export function isAuthConfigured() {
  return Boolean(publicConfig.supabaseUrl && publicConfig.supabaseAnonKey);
}

const signInAliases: Record<string, string> = {
  admin: "admin@synapse.mea",
};

export function resolveSignInIdentifier(value: string) {
  const normalized = value.trim().toLowerCase();
  return signInAliases[normalized] ?? normalized;
}

export async function apiRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${publicConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) {
    const message =
      payload.error?.message ?? `API request failed (${response.status})`;
    const requestId = payload.error?.request_id
      ? ` • Request ${payload.error.request_id}`
      : "";
    throw new Error(`${message}${requestId}`);
  }
  return payload;
}

export function formatNumber(value: unknown, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("th-TH", {
        maximumFractionDigits: digits,
      }).format(number)
    : "—";
}

export function formatDateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("th-TH", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
