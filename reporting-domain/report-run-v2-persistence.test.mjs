// MS2 report schema v2 persistence contract for persistReportDraft. The real
// function body is sliced out of `scout backend.js` and evaluated in a vm
// sandbox (as in supabase-empty-body.test.mjs) so the deployed code path is
// exercised, not a re-implementation.
//
// v2 fails closed: every claim population row MUST carry a non-blank
// parent_identity_key; claim_id may be a canonical UUID or NULL, but a supplied
// non-null claim_id that is not a legitimate UUID is a hard error (never
// silently downgraded). Validation happens BEFORE any Supabase mutation.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = fs
  .readFileSync(path.join(root, "scout backend.js"), "utf8")
  .replace(/\r\n/g, "\n");

function sliceFn(fromMarker, toMarker) {
  const start = backend.indexOf(fromMarker);
  const end = backend.indexOf(toMarker, start + fromMarker.length);
  assert.ok(start >= 0 && end > start, `could not slice ${fromMarker}`);
  return backend.slice(start, end);
}

const supabaseSrc = sliceFn(
  "async function supabase(",
  "async function supabaseAll(",
);
const persistSrc = sliceFn(
  "async function persistReportDraft(",
  "function publicReportRun(",
);

const ENV = { SUPABASE_URL: "https://x.test", SUPABASE_SERVICE: "service-key" };
const UUID = "00000000-0000-4000-8000-000000000001";

function res({ status, body = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function makeSandbox(calls) {
  const context = {
    fetch: async (url, options) => {
      calls.push({ url, method: options.method });
      if (
        url.includes("/scout_report_run_claims") &&
        options.method === "POST"
      ) {
        calls[calls.length - 1].rows = JSON.parse(options.body);
        return res({ status: 201, body: "" });
      }
      if (url.includes("/scout_report_runs") && options.method === "POST")
        return res({ status: 201, body: '[{"id":"new-run"}]' });
      return res({ status: 200, body: "" });
    },
    JSON,
    Error,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    encodeURIComponent,
    console,
    isPreviewReadOnly: () => false,
    PREVIEW_SUPABASE_URL: "https://preview.invalid",
    reportRunRecord: () => ({ id: "record" }),
    getReportRunById: async (_env, id) => ({ id }),
    // Realistic uuidValue: passes a UUID-shaped string, nulls everything else.
    uuidValue: (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
        ? value
        : null,
  };
  vm.runInNewContext(
    `${supabaseSrc}\n${persistSrc}\nthis.persistReportDraft = persistReportDraft;`,
    context,
  );
  return context;
}

function report(rows) {
  return { claim_rows: rows };
}

test("v2 canonical row (parent_identity_key + UUID) and NULL-claim_id row both persist", async () => {
  const calls = [];
  const { persistReportDraft } = makeSandbox(calls);
  const result = await persistReportDraft(
    ENV,
    report([
      { parent_identity_key: "cardinal_claims:SOLO-1", claim_id: UUID },
      { parent_identity_key: "cardinal_claims:MULTI-1", claim_id: null },
    ]),
    { email: "m@test", name: "M" },
    {},
    null,
  );
  assert.equal(result.claimPopulationCount, 2);
  const inserted = calls.find(
    (c) => c.url.includes("/scout_report_run_claims") && c.method === "POST",
  ).rows;
  const canonical = inserted.find(
    (r) => r.parent_identity_key === "cardinal_claims:SOLO-1",
  );
  const ambiguous = inserted.find(
    (r) => r.parent_identity_key === "cardinal_claims:MULTI-1",
  );
  assert.equal(canonical.claim_id, UUID);
  assert.equal(ambiguous.claim_id, null);
});

test("v2 row with UUID but MISSING parent_identity_key throws", async () => {
  const { persistReportDraft } = makeSandbox([]);
  await assert.rejects(
    persistReportDraft(
      ENV,
      report([{ claim_id: UUID }]),
      { email: "m@test" },
      {},
      null,
    ),
    /missing parent_identity_key/,
  );
});

test("v2 row with NEITHER identity throws", async () => {
  const { persistReportDraft } = makeSandbox([]);
  await assert.rejects(
    persistReportDraft(
      ENV,
      report([{ claim_id: null, parent_identity_key: null }]),
      { email: "m@test" },
      {},
      null,
    ),
    /missing parent_identity_key/,
  );
});

test("blank/whitespace parent_identity_key throws", async () => {
  const { persistReportDraft } = makeSandbox([]);
  await assert.rejects(
    persistReportDraft(
      ENV,
      report([{ parent_identity_key: "   ", claim_id: UUID }]),
      { email: "m@test" },
      {},
      null,
    ),
    /missing parent_identity_key/,
  );
});

test("malformed supplied claim_id throws (never silently downgraded to NULL)", async () => {
  const { persistReportDraft } = makeSandbox([]);
  await assert.rejects(
    persistReportDraft(
      ENV,
      report([
        {
          parent_identity_key: "cardinal_claims:SOLO-1",
          claim_id: "not-a-uuid",
        },
      ]),
      { email: "m@test" },
      {},
      null,
    ),
    /malformed claim_id/,
  );
});

test("validation failure occurs BEFORE any PATCH/DELETE/POST mutation on an existing draft", async () => {
  const calls = [];
  const { persistReportDraft } = makeSandbox(calls);
  await assert.rejects(
    persistReportDraft(
      ENV,
      report([{ claim_id: UUID }]), // missing parent_identity_key
      { email: "m@test" },
      {},
      { id: "run-x" }, // existing draft
    ),
    /missing parent_identity_key/,
  );
  // No run PATCH, no claim DELETE, no claim POST may have happened.
  assert.equal(
    calls.some(
      (c) => c.url.includes("/scout_report_runs") && c.method === "PATCH",
    ),
    false,
  );
  assert.equal(
    calls.some(
      (c) =>
        c.url.includes("/scout_report_run_claims") && c.method === "DELETE",
    ),
    false,
  );
  assert.equal(
    calls.some(
      (c) => c.url.includes("/scout_report_run_claims") && c.method === "POST",
    ),
    false,
  );
});

test(">200-row batching still completes every batch under v2 validation", async () => {
  const calls = [];
  const { persistReportDraft } = makeSandbox(calls);
  const rows = Array.from({ length: 450 }, (_, index) => ({
    parent_identity_key: `cardinal_claims:C-${index}`,
    claim_id: null,
  }));
  const result = await persistReportDraft(
    ENV,
    report(rows),
    { email: "m@test" },
    {},
    null,
  );
  assert.equal(result.claimPopulationCount, 450);
  const inserts = calls.filter(
    (c) => c.url.includes("/scout_report_run_claims") && c.method === "POST",
  );
  assert.equal(inserts.length, 3); // ceil(450 / 200)
});

test("source contract: v2 validation throws (no silent claim_id-only filter)", () => {
  assert.match(persistSrc, /missing parent_identity_key/);
  assert.match(persistSrc, /malformed claim_id/);
  assert.doesNotMatch(persistSrc, /\.filter\(\(claim\) => claim\.claim_id\)/);
});

test("source contract: drill resolves NULL claim_id parents by source-scoped source_claim_number", () => {
  const drill = sliceFn(
    "async function getWorkflowClaimContext(",
    "async function workflowSnapshotForReport(",
  );
  assert.match(drill, /if \(claimId\) \{/);
  assert.match(drill, /"claim_id=eq\." \+ encodeURIComponent\(claimId\)/);
  assert.match(
    drill,
    /"source_claim_number=eq\." \+ encodeURIComponent\(sourceClaimNumber\)/,
  );
  // No boundary (report authoritative extract) => no global claim-number lookup.
  assert.match(drill, /if \(!boundary\) return \{\};/);
  // Consensus over all rows, ordered - never a single first/last child.
  assert.match(drill, /order=source_row_index\.asc/);
  assert.doesNotMatch(drill, /limit=1/);
});
