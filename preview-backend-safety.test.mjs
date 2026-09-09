import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  corsHeaders,
  isApprovedPreviewRead,
  isPreviewMutation,
  isPreviewReadOnly,
  PREVIEW_FRONTEND_ORIGIN,
  PREVIEW_SUPABASE_URL,
} from "./preview-policy.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

function requestWithOrigin(origin) {
  return new Request("https://preview.invalid/claims", {
    headers: origin ? { Origin: origin } : {},
  });
}

test("preview CORS accepts only the remediation origin", () => {
  const env = {
    SCOUT_PREVIEW_READONLY: "true",
    SCOUT_FRONTEND_ORIGIN: PREVIEW_FRONTEND_ORIGIN,
  };
  assert.equal(
    corsHeaders(env, requestWithOrigin(PREVIEW_FRONTEND_ORIGIN))["Access-Control-Allow-Origin"],
    PREVIEW_FRONTEND_ORIGIN,
  );
  assert.equal(
    corsHeaders(env, requestWithOrigin("https://scout-smartsure.marketing-854.workers.dev"))["Access-Control-Allow-Origin"],
    undefined,
  );
  assert.equal(
    corsHeaders(env, requestWithOrigin("https://unknown.invalid"))["Access-Control-Allow-Origin"],
    undefined,
  );
  assert.equal(corsHeaders(env, requestWithOrigin("https://unknown.invalid")).Vary, "Origin");
});

test("preview policy allows only approved reads and auth/me", () => {
  assert.equal(isPreviewReadOnly({ SCOUT_PREVIEW_READONLY: "true" }), true);
  assert.equal(isApprovedPreviewRead("/claims", "GET"), true);
  assert.equal(isApprovedPreviewRead("/reports/example/metrics/sla/claims", "GET"), true);
  assert.equal(isApprovedPreviewRead("/teams", "GET"), false);
  assert.equal(isPreviewMutation("/auth/me", "POST"), false);
  assert.equal(isPreviewMutation("/claims", "POST"), true);
  assert.equal(isPreviewMutation("/settings", "PATCH"), true);
  assert.equal(isPreviewMutation("/teams", "POST"), true);
  assert.equal(isPreviewMutation("/future-route", "DELETE"), true);
});

test("preview configuration is isolated from production credentials and delivery", () => {
  const config = read("wrangler.preview.jsonc");
  assert.match(config, /"name":\s*"scout-backend-ux-preview"/);
  assert.match(config, /"SCOUT_PREVIEW_READONLY":\s*"true"/);
  assert.match(config, /SUPABASE_PREVIEW_API_KEY/);
  assert.match(config, /SUPABASE_PREVIEW_READER_TOKEN/);
  assert.match(config, new RegExp(PREVIEW_SUPABASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(config, /SUPABASE_SERVICE|SUPABASE_ANON|TEAMS_WEBHOOK|EMAIL_WEBHOOK|MAIL_FROM|MANAGER_EMAIL/);
  assert.doesNotMatch(config, /vsuoesiwifktyutmzxhx\.supabase\.co/);
});

test("frontend preview configuration selects the separate preview backend", () => {
  const config = read("wrangler.frontend.remediation.jsonc");
  const worker = read("scout-smartsure/remediation-preview-worker.js");
  assert.match(config, /"name":\s*"ux-remediation-c118a80-scout-smartsure"/);
  assert.match(config, /"SCOUT_BACKEND_URL":\s*"https:\/\/scout-backend-ux-preview\.marketing-854\.workers\.dev"/);
  assert.match(worker, /SCOUT_BACKEND_URL/);
  assert.match(worker, /Preview backend is not configured/);
  const productionFrontendConfig = read("wrangler.frontend.jsonc");
  const productionBackendConfig = read("wrangler.reporting.jsonc");
  assert.match(productionFrontendConfig, /"name":\s*"scout-smartsure"/);
  assert.match(productionBackendConfig, /"name":\s*"scout-backend"/);
  assert.doesNotMatch(productionFrontendConfig, /SCOUT_BACKEND_URL|qakjrvezmnvqdtxhjguv/);
  assert.doesNotMatch(productionBackendConfig, /SCOUT_PREVIEW_READONLY|qakjrvezmnvqdtxhjguv|ux-remediation-c118a80/);
  assert.match(read("scout-smartsure/claims/index.html"), /backendUrl:\s+"https:\/\/scout-backend\.marketing-854\.workers\.dev"/);
});

test("preview audit is a no-op and mutation guard precedes authenticated routes", () => {
  const backend = read("scout backend.js");
  assert.match(backend, /if \(isPreviewReadOnly\(env\)\) return;/);
  assert.match(backend, /if \(isPreviewMutation\(path, request\.method\)\)\s*return err\("Preview environment is read-only", 403\)/);
  assert.ok(backend.indexOf("isPreviewMutation(path, request.method)") < backend.indexOf("const authHeader"));
  assert.ok(backend.indexOf("isPreviewMutation(path, request.method)") < backend.indexOf("const msToken"));
});
