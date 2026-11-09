import { publicConfig } from "../lib";
import { isLoopbackHost } from "./optimization-worker";

// One Supabase origin rule for every server route that calls Supabase.
export function controlledSupabaseOrigin() {
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

export function hasValidSuppliedRequestId(request: Request) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(supplied);
}

export function requestId(request: Request) {
  return hasValidSuppliedRequestId(request)
    ? (request.headers.get("x-request-id") as string)
    : crypto.randomUUID();
}
