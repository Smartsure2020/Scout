// Regressions for the shared Supabase helper empty-body fix (the confirmed
// Generate/Regenerate 500 root cause). A successful `return=minimal` write
// (Supabase 201/200 with an empty body) must resolve to null instead of
// throwing on JSON.parse of "".
//
// The Worker module cannot be imported under `node --test` (it is an ESM
// Worker with many bindings), so — to exercise the REAL production code
// rather than a re-implementation — the actual `supabase` and
// `persistReportDraft` function bodies are sliced out of `scout backend.js`
// and evaluated in a vm sandbox with a mocked fetch and dependency stubs.
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

const ENV = {
  SUPABASE_URL: "https://x.test",
  SUPABASE_ANON: "anon-key",
  SUPABASE_SERVICE: "service-key",
};

function makeSandbox({ fetchImpl, stubs = {} } = {}) {
  const context = {
    fetch: fetchImpl,
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
    reportRunRecord: stubs.reportRunRecord || (() => ({ id: "record" })),
    getReportRunById: stubs.getReportRunById || (async (_env, id) => ({ id })),
    uuidValue: stubs.uuidValue || ((value) => value),
  };
  vm.runInNewContext(
    `${supabaseSrc}\n${persistSrc}\n` +
      "this.supabase = supabase; this.persistReportDraft = persistReportDraft;",
    context,
  );
  return context;
}

function res({ status, ok = status >= 200 && status < 300, body = "" }) {
  return {
    ok,
    status,
    async text() {
      return body;
    },
  };
}

test("successful 201 + empty body resolves to null without throwing (return=minimal)", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () => res({ status: 201, body: "" }),
  });
  const result = await supabase(
    ENV,
    "/x",
    "POST",
    { a: 1 },
    true,
    "return=minimal",
  );
  assert.equal(result, null);
});

test("successful 200 + empty body resolves to null", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () => res({ status: 200, body: "" }),
  });
  assert.equal(await supabase(ENV, "/x", "GET"), null);
});

test("204 No Content resolves to null", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () => res({ status: 204, body: "" }),
  });
  assert.equal(await supabase(ENV, "/x", "DELETE"), null);
});

test("a normal JSON response still parses", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () =>
      res({ status: 200, body: '{"id":"run-1","ok":true}' }),
  });
  assert.deepEqual(await supabase(ENV, "/x", "GET"), { id: "run-1", ok: true });
});

test("a whitespace-only body resolves to null (not a parse error)", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () => res({ status: 200, body: "\n  \t" }),
  });
  assert.equal(await supabase(ENV, "/x", "GET"), null);
});

test("a failed Supabase response still throws the existing bounded error", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () =>
      res({ status: 500, ok: false, body: "E".repeat(300) }),
  });
  await assert.rejects(supabase(ENV, "/x", "GET"), (error) => {
    assert.match(error.message, /^Supabase error 500: /);
    // bound preserved: prefix + first 200 chars of the body only
    assert.equal(error.message.length, "Supabase error 500: ".length + 200);
    return true;
  });
});

function persistFetch(calls) {
  return async (url, options) => {
    calls.push({ url, method: options.method, prefer: options.headers.Prefer });
    if (url.includes("/scout_report_run_claims")) {
      // claim writes and the regeneration delete both return empty bodies
      if (options.method === "DELETE") return res({ status: 204, body: "" });
      return res({ status: 201, body: "" }); // return=minimal insert
    }
    if (url.includes("/scout_report_runs")) {
      if (options.method === "POST")
        return res({ status: 201, body: '[{"id":"new-run"}]' });
      return res({ status: 200, body: "" }); // PATCH representation, empty
    }
    return res({ status: 200, body: "" });
  };
}

function reportWithClaims(count) {
  return {
    claim_rows: Array.from({ length: count }, (_, index) => ({
      claim_id: `claim-${index}`,
      metric_ids: [],
    })),
  };
}

test("persistReportDraft with >200 claim rows completes every return=minimal batch", async () => {
  const calls = [];
  const { persistReportDraft } = makeSandbox({
    fetchImpl: persistFetch(calls),
  });

  const result = await persistReportDraft(
    ENV,
    reportWithClaims(450),
    { email: "m@test", name: "M" },
    {},
    null,
  );

  const claimInserts = calls.filter(
    (call) =>
      call.url.includes("/scout_report_run_claims") && call.method === "POST",
  );
  assert.equal(result.claimPopulationCount, 450);
  assert.equal(
    claimInserts.length,
    3,
    "ceil(450/200) = 3 batches all complete",
  );
  assert.ok(
    claimInserts.every((call) => call.prefer === "return=minimal"),
    "claim inserts use return=minimal",
  );
});

test("regeneration replaces the full persisted claim population instead of dying after batch 1", async () => {
  const calls = [];
  const { persistReportDraft } = makeSandbox({
    fetchImpl: persistFetch(calls),
  });

  const result = await persistReportDraft(
    ENV,
    reportWithClaims(450),
    { email: "m@test", name: "M" },
    {},
    { id: "run-x" },
  );

  const deletes = calls.filter(
    (call) =>
      call.url.includes("/scout_report_run_claims") && call.method === "DELETE",
  );
  const claimInserts = calls.filter(
    (call) =>
      call.url.includes("/scout_report_run_claims") && call.method === "POST",
  );
  assert.equal(deletes.length, 1, "existing claim population is cleared first");
  assert.equal(
    claimInserts.length,
    3,
    "all 3 batches re-inserted, none skipped",
  );
  assert.equal(result.claimPopulationCount, 450);
});

test("workflow return=minimal callers are covered by the shared helper (behaviour + wiring)", async () => {
  const { supabase } = makeSandbox({
    fetchImpl: async () => res({ status: 201, body: "" }),
  });
  // Attention/action snapshot inserts post with this exact prefer and a 201
  // empty body — the shape that previously threw.
  const attention = await supabase(
    ENV,
    "/scout_report_attention_items",
    "POST",
    { x: 1 },
    true,
    "resolution=ignore-duplicates,return=minimal",
  );
  assert.equal(attention, null);

  // And those callers really do route through the shared helper with that prefer.
  assert.match(
    backend,
    /"\/scout_report_attention_items",\s*"POST",[\s\S]*?"resolution=ignore-duplicates,return=minimal"/,
  );
  assert.match(
    backend,
    /"\/scout_report_action_items",\s*"POST",[\s\S]*?"resolution=ignore-duplicates,return=minimal"/,
  );
});
