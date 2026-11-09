import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./scout-smartsure/", import.meta.url);
const QA_BACKEND = "https://scout-qa.invalid";
const LIVE_BACKEND = "https://scout-backend.marketing-854.workers.dev";
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const staticAssets = new Map([
  ["/oauth-route.js", ["oauth-route.js", "text/javascript; charset=utf-8"]],
  ["/claims/claims-qa.mjs", ["claims/claims-qa.mjs", "text/javascript; charset=utf-8"]],
  ["/claims/ux-model.mjs", ["claims/ux-model.mjs", "text/javascript; charset=utf-8"]],
  ["/claims/reporting-ui.mjs", ["claims/reporting-ui.mjs", "text/javascript; charset=utf-8"]],
  ["/claims/briefing-model.mjs", ["claims/briefing-model.mjs", "text/javascript; charset=utf-8"]],
]);

function qaHtml(source) {
  if (!source.includes(LIVE_BACKEND) || !source.includes("./qa-fixtures.js")) {
    throw new Error("Synthetic preview source lacks the expected safety markers");
  }
  return source
    .replaceAll(LIVE_BACKEND, QA_BACKEND)
    .replace(/azureClientId:\s*"[^"]+"/, 'azureClientId: "synthetic-qa-disabled"')
    .replace(/azureTenantId:\s*"[^"]+"/, 'azureTenantId: "synthetic-qa-disabled"')
    .replace(/<script data-cfasync="false" src="\/cdn-cgi\/scripts\/[^"]+"><\/script>/, "")
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx@[^"]+"><\/script>/, "");
}

function qaFixture(source) {
  if (!source.includes('url.hostname === "scout-backend.marketing-854.workers.dev"')) {
    throw new Error("Synthetic fetch interceptor has changed unexpectedly");
  }
  return source.replace(
    'url.hostname === "scout-backend.marketing-854.workers.dev"',
    'url.hostname === "scout-qa.invalid"',
  );
}

function respond(res, status, body, contentType = "text/plain; charset=utf-8", head = false) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
  };
  res.writeHead(status, headers);
  res.end(head ? undefined : body);
}

export function createQaServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return respond(res, 403, "Synthetic preview: mutations are disabled");
      }
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      const head = req.method === "HEAD";
      if (pathname === "/") {
        res.writeHead(302, { Location: "/claims/", "Cache-Control": "no-store" });
        return res.end();
      }
      if (pathname === "/healthz") {
        return respond(res, 200, JSON.stringify({ ok: true, synthetic: true }),
          "application/json; charset=utf-8", head);
      }
      if (pathname === "/claims" || pathname === "/claims/" || pathname === "/claims/index.html") {
        const source = await readFile(new URL("claims/qa-preview-index.html", root), "utf8");
        return respond(res, 200, qaHtml(source), "text/html; charset=utf-8", head);
      }
      if (pathname === "/claims/qa-preview-config.js") {
        const script = "window.ScoutQAConfig = Object.freeze({ fixtureMode: true, label: 'SCOUT OPTION A · SYNTHETIC ONLY' });\n";
        return respond(res, 200, script, "text/javascript; charset=utf-8", head);
      }
      if (pathname === "/claims/qa-fixtures.js") {
        const source = await readFile(new URL("claims/qa-fixtures.js.txt", root), "utf8");
        return respond(res, 200, qaFixture(source), "text/javascript; charset=utf-8", head);
      }
      if (staticAssets.has(pathname)) {
        const [asset, mime] = staticAssets.get(pathname);
        const source = await readFile(new URL(asset, root));
        return respond(res, 200, source, mime, head);
      }
      return respond(res, 404, "Not found", undefined, head);
    } catch (err) {
      console.error("Synthetic preview asset unavailable:", err?.message);
      return respond(res, 503, "Synthetic review preview temporarily unavailable");
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL("file://" + process.argv[1]))) {
  const port = Number(process.env.PORT || 3000);
  createQaServer().listen(port, "0.0.0.0", () =>
    console.log("SCOUT synthetic-only review listening on port", port));
}
