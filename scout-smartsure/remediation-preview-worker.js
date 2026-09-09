const PRODUCTION_BACKEND_URL =
  "https://scout-backend.marketing-854.workers.dev";

function rewriteBackendUrl(html, backendUrl) {
  const configured = JSON.stringify(backendUrl);
  return html.replace(
    /backendUrl\s*:\s*"https:\/\/scout-backend\.marketing-854\.workers\.dev"/g,
    `backendUrl: ${configured}`,
  );
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("text/html")) return response;

    const backendUrl = String(
      env.SCOUT_BACKEND_URL || PRODUCTION_BACKEND_URL,
    ).replace(/\/+$/, "");
    if (backendUrl === PRODUCTION_BACKEND_URL) {
      return new Response("Preview backend is not configured", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const html = await response.text();
    const headers = new Headers(response.headers);
    return new Response(rewriteBackendUrl(html, backendUrl), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
