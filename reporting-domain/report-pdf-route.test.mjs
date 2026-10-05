// Source contract for the GET /reports/:id/pdf Browser Run renderer path.
// The Worker fetch handler is not executed under `node --test`, so — like
// api-contract.test.mjs — these regressions assert the deployed route shape
// directly against `scout backend.js`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = fs
  .readFileSync(path.join(root, "scout backend.js"), "utf8")
  .replace(/\r\n/g, "\n");

// Isolate the PDF handler so an assertion cannot accidentally match another
// route's audit or error text.
const pdfRoute = (() => {
  const start = backend.indexOf("const reportPdfMatch = path.match(");
  assert.ok(start >= 0, "GET /reports/:id/pdf route not found in backend");
  const end = backend.indexOf("const reportArchiveMatch = path.match(", start);
  assert.ok(end > start, "PDF route boundary not found in backend");
  return backend.slice(start, end);
})();

const failureAudit = pdfRoute.slice(pdfRoute.indexOf("} catch (e) {"));

test("1. PDF export invokes Browser Run quickAction with the 'pdf' action", () => {
  assert.match(pdfRoute, /env\.BROWSER\.quickAction\(\s*"pdf",/);
});

test("2. quickAction payload includes the rendered html", () => {
  assert.match(pdfRoute, /quickAction\(\s*"pdf",\s*\{\s*html,/);
});

test("3. quickAction uses A4 landscape with native margin headers and footers", () => {
  assert.match(
    pdfRoute,
    /quickAction\(\s*"pdf",\s*\{\s*html,\s*pdfOptions:\s*\{\s*printBackground:\s*true,\s*format:\s*"a4",\s*landscape:\s*true,\s*preferCSSPageSize:\s*true,\s*displayHeaderFooter:\s*true,\s*headerTemplate,\s*footerTemplate,\s*margin:\s*\{\s*top:\s*"14mm",\s*right:\s*"12mm",\s*bottom:\s*"15mm",\s*left:\s*"12mm",?\s*\},?\s*\},?\s*\},?\s*\)/,
  );
  assert.match(
    pdfRoute,
    /renderClaimsReportPdfHeaderTemplate\(\s*run,\s*workflow,?\s*\)/,
  );
  assert.match(pdfRoute, /renderClaimsReportPdfFooterTemplate\(\s*\)/);
});

test("4. quickAction payload has no top-level printBackground", () => {
  assert.doesNotMatch(pdfRoute, /\{\s*html,\s*printBackground/);
});

test("5. a successful render returns application/pdf", () => {
  assert.match(
    pdfRoute,
    /pdfHeaders\.set\("Content-Type",\s*"application\/pdf"\)/,
  );
});

test("5b. a successful PDF response preserves Scout CORS headers", () => {
  assert.match(pdfRoute, /const pdfHeaders = new Headers\(pdf\.headers\)/);
  assert.match(
    pdfRoute,
    /for \(const key of \[\.\.\.pdfHeaders\.keys\(\)\]\) \{\s*if \(key\.toLowerCase\(\)\.startsWith\("access-control-"\)\) \{\s*pdfHeaders\.delete\(key\);\s*\}\s*\}/,
  );
  assert.match(
    pdfRoute,
    /for \(const \[key, value\] of Object\.entries\(headers\)\) \{\s*pdfHeaders\.set\(key, value\);\s*\}/,
  );
  assert.match(
    pdfRoute,
    /return new Response\(pdf\.body, \{\s*status: pdf\.status,\s*headers: pdfHeaders,\s*\}\)/,
  );
});

test("6. a non-OK Browser Run response throws and fails closed with 503", () => {
  assert.match(pdfRoute, /if \(!rendered\.ok\)/);
  assert.match(
    pdfRoute,
    /throw new Error\(\s*`Browser Run PDF renderer returned \$\{rendered\.status\}`/,
  );
  assert.match(
    pdfRoute,
    /return err\("PDF export could not be completed", 503\)/,
  );
});

test("3b. an unexpected non-Response value is rejected, never silently wrapped", () => {
  assert.match(
    pdfRoute,
    /Browser Run PDF renderer returned an invalid response/,
  );
  assert.doesNotMatch(pdfRoute, /new Response\(rendered\)/);
});

test("7. renderer failure captures status diagnostics and audits renderer_error", () => {
  assert.match(pdfRoute, /rendererStatus = rendered\.status/);
  assert.match(
    pdfRoute,
    /browserMsUsed = rendered\.headers\.get\("X-Browser-Ms-Used"\)/,
  );
  assert.match(pdfRoute, /reason:\s*"renderer_error"/);
  assert.match(pdfRoute, /renderer_status:\s*rendererStatus/);
  assert.match(pdfRoute, /browser_ms_used:\s*browserMsUsed/);
});

test("7b. the failure audit detail never carries report html or secrets", () => {
  assert.doesNotMatch(failureAudit, /\bhtml\b/);
  assert.doesNotMatch(failureAudit, /Authorization|bearer|cookie|secret/i);
});

test("8. missing BROWSER binding or quickAction keeps the binding-unavailable 503", () => {
  assert.match(
    pdfRoute,
    /if \(!env\.BROWSER \|\| typeof env\.BROWSER\.quickAction !== "function"\)/,
  );
  assert.match(pdfRoute, /reason:\s*"browser_run_binding_unavailable"/);
  assert.match(
    pdfRoute,
    /"PDF export is unavailable until the report renderer is configured"/,
  );
});

test("9. unavailable management workflow keeps its distinct 503", () => {
  assert.match(
    pdfRoute,
    /return err\("Management workflow snapshots are unavailable", 503\)/,
  );
});
