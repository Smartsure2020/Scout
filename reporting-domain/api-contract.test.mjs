import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCOUT_API_CONTRACT, contractKey } from "./api-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = fs.readFileSync(path.join(root, "scout backend.js"), "utf8");
const claimsUi = fs.readFileSync(
  path.join(root, "scout-smartsure", "claims", "index.html"),
  "utf8",
);
const reportingUi = fs.readFileSync(
  path.join(root, "scout-smartsure", "claims", "reporting-ui.mjs"),
  "utf8",
);
const frontend = `${claimsUi}\n${reportingUi}`;

const sourceAssertions = new Map([
  ["POST /auth/me", 'path === "/auth/me" && request.method === "POST"'],
  ["GET /claims", 'path === "/claims" && request.method === "GET"'],
  ["POST /upload", 'path === "/upload" && request.method === "POST"'],
  ["GET /notes/:claimNo", 'request.method === "GET"'],
  ["PUT /notes/:claimNo", 'request.method === "PUT"'],
  [
    "GET /history/latest",
    'path === "/history/latest" && request.method === "GET"',
  ],
  [
    "GET /history/extracts",
    'path === "/history/extracts" && request.method === "GET"',
  ],
  ["GET /history/extracts/:id", 'request.method === "GET"'],
  ["GET /history/claims/:id", 'request.method === "GET"'],
  [
    "GET /briefing-runs",
    'path === "/briefing-runs" && request.method === "GET"',
  ],
  ["GET /digest-log", 'path === "/digest-log" && request.method === "GET"'],
  ["GET /digest-log/:id", 'digestMatch && request.method === "GET"'],
  ["GET /settings", 'request.method === "GET"'],
  ["PATCH /settings", 'request.method === "PATCH"'],
  [
    "GET /management-workflow/users",
    'path === "/management-workflow/users" && request.method === "GET"',
  ],
  [
    "GET /management-attention",
    'path === "/management-attention" && request.method === "GET"',
  ],
  [
    "POST /management-attention",
    'path === "/management-attention" && request.method === "POST"',
  ],
  [
    "GET /management-attention/:id",
    'attentionByIdMatch && request.method === "GET"',
  ],
  [
    "PATCH /management-attention/:id",
    'attentionByIdMatch &&\n      attentionByIdMatch[1] &&\n      request.method === "PATCH"',
  ],
  [
    "POST /management-attention/:id/resolve",
    'attentionResolveMatch && request.method === "POST"',
  ],
  [
    "GET /management-actions",
    'path === "/management-actions" && request.method === "GET"',
  ],
  [
    "POST /management-actions",
    'path === "/management-actions" && request.method === "POST"',
  ],
  [
    "GET /management-actions/:id",
    'actionByIdMatch && request.method === "GET"',
  ],
  [
    "PATCH /management-actions/:id",
    'actionByIdMatch && actionByIdMatch[1] && request.method === "PATCH"',
  ],
  [
    "POST /management-actions/:id/complete",
    'actionCompleteMatch && request.method === "POST"',
  ],
  [
    "POST /reports/:id/attention",
    'reportAttentionAddMatch && request.method === "POST"',
  ],
  [
    "DELETE /reports/:id/attention/:attentionId",
    'reportAttentionRemoveMatch && request.method === "DELETE"',
  ],
  [
    "POST /reports/:id/actions",
    'reportActionAddMatch && request.method === "POST"',
  ],
  [
    "DELETE /reports/:id/actions/:actionId",
    'reportActionRemoveMatch && request.method === "DELETE"',
  ],
  ["GET /reports", 'path === "/reports" && request.method === "GET"'],
  [
    "POST /reports/generate",
    'path === "/reports/generate" && request.method === "POST"',
  ],
  ["GET /reports/:id", 'reportByIdMatch && request.method === "GET"'],
  [
    "GET /reports/:id/metrics/:metricId/claims",
    'reportMetricClaimsMatch && request.method === "GET"',
  ],
  [
    "POST /reports/:id/regenerate",
    'reportRegenerateMatch && request.method === "POST"',
  ],
  [
    "POST /reports/:id/finalise",
    'reportFinaliseMatch && request.method === "POST"',
  ],
  ["GET /reports/:id/pdf", 'reportPdfMatch && request.method === "GET"'],
  [
    "POST /reports/:id/archive",
    'reportArchiveMatch && request.method === "POST"',
  ],
  ["GET /audit", 'path === "/audit" && request.method === "GET"'],
  ["GET /users", 'path === "/users" && request.method === "GET"'],
  ["POST /teams", 'path === "/teams" && request.method === "POST"'],
]);

test("route contract is unique and covers every backend route", () => {
  const keys = SCOUT_API_CONTRACT.map(contractKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const route of SCOUT_API_CONTRACT.filter((item) => item.path !== "*")) {
    const assertion = sourceAssertions.get(contractKey(route));
    assert.ok(assertion, `missing source assertion for ${contractKey(route)}`);
    assert.match(
      backend,
      new RegExp(assertion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      contractKey(route),
    );
  }
});

test("CORS permits all methods used by the portal", () => {
  assert.match(
    backend,
    /"Access-Control-Allow-Origin":\s*"https:\/\/scout-smartsure\.marketing-854\.workers\.dev"/,
  );
  assert.match(
    backend,
    /"Access-Control-Allow-Methods":\s*"GET, POST, PUT, DELETE, OPTIONS"/,
  );
  assert.doesNotMatch(backend, /"Access-Control-Allow-Origin":\s*"\*"/);
  assert.match(backend, /if \(request\.method === "OPTIONS"\)/);
});

test("claim notes enforce role-aware claim access before read or write", () => {
  assert.match(backend, /canAccessClaimNote\(env, claimNo, currentUser\)/);
  assert.match(backend, /currentUser\?\.role !== "handler"/);
  assert.match(backend, /handler_email=eq\./);
});

test("frontend consumers map to implemented endpoints", () => {
  for (const route of SCOUT_API_CONTRACT.filter(
    (item) => item.frontend.length,
  )) {
    const dynamicParts = route.path.split(/:[^/]+/);
    const endpoint = dynamicParts[0];
    assert.ok(
      frontend.includes(endpoint),
      `${contractKey(route)} base path is not referenced by the frontend`,
    );
    for (const suffix of dynamicParts.slice(1)) {
      if (suffix)
        assert.ok(
          frontend.includes(suffix),
          `${contractKey(route)} suffix is not referenced by the frontend`,
        );
    }
  }
});

test("history UI does not write or render full extracts in localStorage", () => {
  assert.doesNotMatch(claimsUi, /claims:\s*rawClaims/);
  assert.doesNotMatch(claimsUi, /Load\s+extract/);
  assert.match(claimsUi, /Immutable extract history from the Scout server/);
  assert.match(claimsUi, /loadServerHistory\(\)/);
});

test("live identity and navigation safeguards remain source-enforced", () => {
  assert.doesNotMatch(
    backend,
    /sarah@smartsure2020\.co\.za|bev@smartsure2020\.co\.za/i,
  );
  assert.doesNotMatch(
    claimsUi,
    /Beverly De Beer|Sarah Dzumba|bev@smartsure2020\.co\.za/i,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "scout-smartsure", "index.html"), "utf8"),
    /uwUrl:\s*["']\/underwriting\//,
  );
  assert.match(
    fs.readFileSync(path.join(root, "scout-smartsure", "index.html"), "utf8"),
    /Coming soon in Atlas/,
  );
});

test("zero-estimate drill-through remains canonical and frozen", () => {
  assert.match(reportingUi, /zero_estimate_payment_request/);
  assert.match(
    backend,
    /Array\.isArray\(row\.metric_ids\).*row\.metric_ids\.includes\(metricId\)/s,
  );
});

test("source dates are explicit and missing Cardinal age is not treated as a discrepancy", () => {
  assert.match(claimsUi, /ageProvided/);
  assert.match(claimsUi, /typeof value === "boolean"\) continue/);
  assert.doesNotMatch(claimsUi, /firstValidDate\([^\n]*row\["Repudiated"\]/);
});
