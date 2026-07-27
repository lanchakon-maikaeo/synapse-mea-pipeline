export class WorkerDispatchError extends Error {}

export function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function optimizationWorkerConfig() {
  const rawUrl = process.env.OPTIMIZATION_WORKER_URL?.trim() || "";
  const token = process.env.OPTIMIZATION_WORKER_AUTH_TOKEN?.trim() || "";
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token || token.length > 4096 || /[\r\n]/.test(token)) {
    throw new WorkerDispatchError("Optimization worker configuration is invalid");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    throw new WorkerDispatchError("Optimization worker URL is invalid");
  }
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
  ) {
    throw new WorkerDispatchError("Optimization worker URL is invalid");
  }
  if (
    process.env.NODE_ENV === "production" &&
    (baseUrl.protocol !== "https:" || isLoopbackHost(baseUrl.hostname))
  ) {
    throw new WorkerDispatchError(
      "Production optimization worker must use controlled HTTPS",
    );
  }
  if (baseUrl.protocol === "http:" && !isLoopbackHost(baseUrl.hostname)) {
    throw new WorkerDispatchError(
      "Optimization worker must use HTTPS except on loopback",
    );
  }
  return { baseUrl, token };
}

export async function triggerOptimizationWorker(
  action: "heartbeat" | "run-once",
  requestIdValue: string,
) {
  const configured = optimizationWorkerConfig();
  if (!configured) {
    throw new WorkerDispatchError("Optimization worker is not configured");
  }
  const endpoint = new URL(configured.baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/${action}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configured.token}`,
        "Content-Type": "application/json",
        "X-Request-ID": requestIdValue,
      },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(action === "heartbeat" ? 25_000 : 120_000),
    });
  } catch {
    throw new WorkerDispatchError("Optimization worker is unavailable");
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new WorkerDispatchError("Optimization worker rejected the request");
  }
}
