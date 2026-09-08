import { publicConfig } from "../lib";
import { isLoopbackHost } from "./optimization-worker";

export function controlledSupabaseOrigin() {
  const configured = publicConfig.supabaseUrl.trim();
  if (!configured) return null;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (process.env.NODE_ENV !== "production") return url.origin;
  if (url.protocol !== "https:" || isLoopbackHost(url.hostname)) return null;

  const hostedProject = /^[a-z0-9]{20}\.supabase\.co$/i.test(url.hostname);
  const explicitlyAllowed = process.env.SUPABASE_ALLOWED_ORIGIN?.trim();
  if (hostedProject) return url.origin;
  if (!explicitlyAllowed) return null;
  try {
    const allowed = new URL(explicitlyAllowed);
    return allowed.protocol === "https:" && !allowed.username && !allowed.password &&
      allowed.pathname === "/" && !allowed.search && !allowed.hash &&
      !isLoopbackHost(allowed.hostname) && allowed.origin === url.origin
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
