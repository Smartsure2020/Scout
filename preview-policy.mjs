export const PREVIEW_SUPABASE_URL =
  "https://qakjrvezmnvqdtxhjguv.supabase.co";

export const PREVIEW_FRONTEND_ORIGIN =
  "https://ux-remediation-c118a80-scout-smartsure.marketing-854.workers.dev";

const PRODUCTION_FRONTEND_ORIGIN =
  "https://scout-smartsure.marketing-854.workers.dev";

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Content-Type, Authorization";

const PREVIEW_READ_ROUTES = [
  /^\/briefing-runs$/,
  /^\/digest-log(?:\/[0-9a-f-]+)?$/i,
  /^\/settings$/,
  /^\/notifications$/,
  /^\/claims$/,
  /^\/notes\/[^/]+$/,
  /^\/history\/latest$/,
  /^\/history\/extracts(?:\/[^/]+)?$/,
  /^\/history\/claims\/[^/]+$/,
  /^\/management-workflow\/users$/,
  /^\/management-attention(?:\/[^/]+)?$/,
  /^\/management-actions(?:\/[^/]+)?$/,
  /^\/reports$/,
  /^\/reports\/[^/]+$/,
  /^\/reports\/[^/]+\/metrics\/[^/]+\/claims$/,
  /^\/reports\/[^/]+\/pdf$/,
  /^\/users$/,
];

export function isPreviewReadOnly(env) {
  return String(env?.SCOUT_PREVIEW_READONLY || "").toLowerCase() === "true";
}

export function corsHeaders(env, request) {
  const base = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_HEADERS,
  };

  if (!isPreviewReadOnly(env)) {
    return {
      ...base,
      "Access-Control-Allow-Origin": PRODUCTION_FRONTEND_ORIGIN,
    };
  }

  const origin = request?.headers?.get("Origin") || "";
  const allowedOrigin = String(
    env?.SCOUT_FRONTEND_ORIGIN || PREVIEW_FRONTEND_ORIGIN,
  );
  return origin === allowedOrigin
    ? { ...base, "Access-Control-Allow-Origin": allowedOrigin }
    : base;
}

export function isApprovedPreviewRead(path, method) {
  if (method === "HEAD") return true;
  if (method !== "GET") return false;
  return PREVIEW_READ_ROUTES.some((pattern) => pattern.test(path));
}

export function isPreviewMutation(path, method) {
  if (method === "OPTIONS" || method === "HEAD") return false;
  if (path === "/auth/me" && method === "POST") return false;
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}
