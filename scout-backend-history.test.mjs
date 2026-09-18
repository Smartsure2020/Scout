import assert from "node:assert/strict";
import test from "node:test";

import {
  historicalManifestRecord,
  parseCorrectionOfExtractId,
} from "./scout backend.js";
import scoutBackend from "./scout backend.js";

const VALID_CORRECTION_ID = "8043f9e0-08a9-41de-96be-f50f2f01649c";
const UPLOAD_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON: "test-anon",
  SUPABASE_SERVICE: "test-service",
};
const ADMIN_USER = {
  id: "scout-admin-1",
  email: "admin@example.test",
  display_name: "Admin User",
  role: "admin",
  active: true,
};

const uploadFixture = {
  claims: [{ claimNo: "C-1", status: "Registered" }],
  fileName: "fixture.csv",
  extractDate: "2026-09-14",
  sourceChecksum: "fixture-checksum",
  sourceMetadata: { portfolio_scope: "claims" },
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runUploadRoute(
  body,
  { existingManifest = null, acceptedManifests = [], latestManifestFailure = false } = {},
) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method || (input instanceof Request ? input.method : "GET");
    calls.push({ url, method, body: init.body || null });

    if (url === "https://graph.microsoft.com/v1.0/me")
      return jsonResponse({
        mail: ADMIN_USER.email,
        displayName: ADMIN_USER.display_name,
        id: "ms-admin-1",
      });

    const parsed = new URL(url);
    if (parsed.origin !== UPLOAD_ENV.SUPABASE_URL)
      throw new Error(`Unexpected mocked fetch: ${url}`);
    const table = parsed.pathname.replace("/rest/v1/", "");

    if (table === "scout_users" && method === "GET") {
      return jsonResponse(
        parsed.searchParams.has("email") ? [ADMIN_USER] : [],
      );
    }

    if (table === "scout_history_extracts" && method === "GET") {
      const checksum = parsed.searchParams.get("source_checksum");
      if (checksum === "eq.retry-checksum")
        return jsonResponse(existingManifest ? [existingManifest] : []);
      if (
        latestManifestFailure &&
        parsed.searchParams.get("order") === "received_at.desc"
      )
        return jsonResponse({ error: "mock latest-history failure" }, 500);
      if (parsed.searchParams.has("status"))
        return jsonResponse(acceptedManifests);
      return jsonResponse([]);
    }

    if (table === "scout_audit" && method === "POST") return jsonResponse([]);
    return jsonResponse([]);
  };

  try {
    const response = await scoutBackend.fetch(
      new Request("https://scout.test/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer local-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      UPLOAD_ENV,
    );
    return {
      status: response.status,
      body: await response.json(),
      calls,
      businessWrites: calls.filter(
        (call) =>
          call.method !== "GET" && !call.url.endsWith("/scout_audit"),
      ),
    };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function manifest(id, effectiveDate, overrides = {}) {
  return {
    id,
    source_system: "cardinal_claims",
    status: "accepted",
    historical_persisted: true,
    effective_date: effectiveDate,
    previous_extract_id: null,
    correction_of_extract_id: null,
    ...overrides,
  };
}

test("correction input distinguishes omission from invalid supplied values", () => {
  assert.deepEqual(parseCorrectionOfExtractId({ claims: [] }), {
    supplied: false,
    value: null,
    error: null,
  });

  for (const value of [null, "", "   ", 0, false, true, {}, [], "not-a-uuid"]) {
    assert.deepEqual(
      parseCorrectionOfExtractId({ correctionOfExtractId: value }),
      {
        supplied: true,
        value: null,
        error: "invalid_correction_of_extract_id",
      },
    );
  }

  assert.deepEqual(
    parseCorrectionOfExtractId({
      correctionOfExtractId: VALID_CORRECTION_ID,
    }),
    {
      supplied: true,
      value: VALID_CORRECTION_ID,
      error: null,
    },
  );
});

test("new correction manifests store the resolved genuine predecessor", () => {
  const makeRecord = ({
    extractDate,
    correctionOfExtractId,
    previousManifest,
  }) =>
    historicalManifestRecord({
      checksum: `${extractDate}-checksum`,
      checksumBasis: "claims-json-payload",
      fileName: "extract.csv",
      extractDate,
      effectiveAt: null,
      receivedAt: `${extractDate}T12:00:00.000Z`,
      currentUser: { id: "user-1", email: "admin@example.test" },
      claims: [{}],
      normalized: {
        quality: {
          accepted_claim_count: 1,
          rejected_claim_count: 0,
        },
      },
      quality: { hard_rejection: false },
      previousManifest,
      sourceMetadata: {},
      correctionOfExtractId,
    });

  const p0 = { id: "p0", effective_date: "2026-09-04" };
  const bad14 = { id: "bad14", effective_date: "2026-09-14" };
  const new14 = {
    id: "new14",
    ...makeRecord({
      extractDate: "2026-09-14",
      correctionOfExtractId: bad14.id,
      previousManifest: p0,
    }),
  };
  assert.equal(new14.correction_of_extract_id, bad14.id);
  assert.equal(new14.previous_extract_id, p0.id);

  const o15 = { id: "o15", effective_date: "2026-09-15" };
  const new15 = makeRecord({
    extractDate: "2026-09-15",
    correctionOfExtractId: o15.id,
    previousManifest: new14,
  });
  assert.equal(new15.correction_of_extract_id, o15.id);
  assert.equal(new15.previous_extract_id, new14.id);

  const ordinary15 = { id: "ordinary15", effective_date: "2026-09-15" };
  const ordinary16 = makeRecord({
    extractDate: "2026-09-16",
    correctionOfExtractId: null,
    previousManifest: ordinary15,
  });
  assert.equal(ordinary16.previous_extract_id, ordinary15.id);
  assert.equal(ordinary16.correction_of_extract_id, null);
});

test("actual upload rejects explicit null correction input before business writes", async () => {
  const result = await runUploadRoute({
    ...uploadFixture,
    correctionOfExtractId: null,
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_correction_of_extract_id");
  assert.deepEqual(result.businessWrites, []);
});

test("actual upload rejects invalid string correction input before business writes", async () => {
  const result = await runUploadRoute({
    ...uploadFixture,
    correctionOfExtractId: "not-a-uuid",
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_correction_of_extract_id");
  assert.deepEqual(result.businessWrites, []);
});

test("actual upload returns retry conflict before history or current-state writes", async () => {
  const ids = {
    prior: "00000000-0000-4000-8000-000000000001",
    original: "00000000-0000-4000-8000-000000000002",
    flawed: "00000000-0000-4000-8000-000000000003",
    ordinary15: "00000000-0000-4000-8000-000000000004",
    existing: "00000000-0000-4000-8000-000000000005",
  };
  const prior = manifest(ids.prior, "2026-09-04");
  const original = manifest(ids.original, "2026-09-14", {
    previous_extract_id: prior.id,
  });
  const flawed = manifest(ids.flawed, "2026-09-14", {
    previous_extract_id: original.id,
  });
  const existing = manifest(ids.existing, "2026-09-14", {
    status: "processing",
    historical_persisted: false,
    correction_of_extract_id: flawed.id,
    previous_extract_id: ids.ordinary15,
  });

  const result = await runUploadRoute(
    {
      ...uploadFixture,
      sourceChecksum: "retry-checksum",
      correctionOfExtractId: flawed.id,
    },
    { existingManifest: existing, acceptedManifests: [prior, original, flawed] },
  );

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "history_retry_lineage_conflict");
  assert.deepEqual(result.businessWrites, []);
});

test("actual upload returns 422 for a valid correction UUID with no target", async () => {
  const result = await runUploadRoute({
    ...uploadFixture,
    sourceChecksum: "missing-target-checksum",
    correctionOfExtractId: VALID_CORRECTION_ID,
  });

  assert.equal(result.status, 422);
  assert.match(result.body.error, /correction target was not found/);
  assert.deepEqual(result.businessWrites, []);
});

test("actual upload treats an omitted correction field as an ordinary upload", async () => {
  const result = await runUploadRoute(uploadFixture, {
    latestManifestFailure: true,
  });

  assert.equal(result.status, 503);
  assert.notEqual(result.body.error, "invalid_correction_of_extract_id");
  assert.equal(
    result.calls.some(
      (call) =>
        call.method === "GET" &&
        call.url.includes("/scout_history_extracts") &&
        call.url.includes("order=received_at.desc"),
    ),
    true,
  );
});
