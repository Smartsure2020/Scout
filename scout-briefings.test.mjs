import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPilotBriefingModel,
  createBriefingsWorker,
  PRODUCTION_ORIGIN,
} from "./scout-briefings.js";

const teamsWebhook = "https://teams-webhook.example.test/trigger";
const supabaseSecretKey = "sb_secret_test_value";

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function environment(overrides = {}) {
  return {
    SUPABASE_URL: "https://supabase.example.test",
    SUPABASE_SECRET_KEY: supabaseSecretKey,
    DELIVERY_ALLOWED_CALLERS_JSON: JSON.stringify(["caller@example.com"]),
    TEAMS_MANAGER_WEBHOOK: teamsWebhook,
    SUPABASE_EXTRACTS_TABLE: "claim_extracts",
    SUPABASE_CLAIMS_TABLE: "claims",
    SUPABASE_BRIEFING_RUNS_TABLE: "briefing_runs",
    SUPABASE_BRIEFING_DELIVERIES_TABLE: "briefing_deliveries",
    SUPABASE_DIGEST_LOG_TABLE: "digest_log",
    SUPABASE_SETTINGS_TABLE: "scout_settings",
    ...overrides,
  };
}

function sampleClaims() {
  return [
    {
      id: "claim-1",
      claim_no: "CLM-001",
      insured_name: "A. Insured",
      handler_name: "Mapped Handler",
      status: "Awaiting assessor report",
      working_age: 18,
      outstanding: 12000,
      estimate: 0,
      days_since_movement: 18,
    },
    {
      id: "claim-2",
      claim_no: "CLM-002",
      insured_name: "B. Insured",
      handler_name: "Unmapped Handler",
      status: "Active",
      working_age: 4,
      outstanding: 8000,
      estimate: 5000,
    },
  ];
}

function makeHarness({
  settings = {},
  overrides = {},
  graphIdentity = "caller@example.com",
  claims = sampleClaims(),
  previousClaims = sampleClaims().slice(1),
  noExtract = false,
  noSettings = false,
  storageFailure = null,
  teamsSendFailure = false,
  teamsResponseStatus = 202,
  failPostSendAudit = false,
} = {}) {
  const deliveries = new Map();
  const runs = new Map();
  const digests = new Map();
  const calls = [];
  let sequence = 0;
  let teamsAccepted = false;
  const extracts = [
    {
      id: "extract-latest",
      extract_date: "2026-09-10",
      effective_date: "2026-09-10",
      uploaded_at: "2026-09-10T06:00:00Z",
    },
    {
      id: "extract-previous",
      extract_date: "2026-09-09",
      effective_date: "2026-09-09",
      uploaded_at: "2026-09-09T06:00:00Z",
    },
  ];
  const defaultSettings = {
    handler_emails: { "Mapped Handler": "mapped@example.com" },
    ...settings,
  };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url, init });
    if (
      parsed.hostname === "graph.microsoft.com" &&
      parsed.pathname === "/v1.0/me"
    ) {
      const bearer = init.headers?.Authorization || "";
      return bearer.includes("token-good")
        ? response({ mail: graphIdentity, userPrincipalName: graphIdentity })
        : response({ error: "invalid" }, 401);
    }
    if (parsed.hostname === "teams-webhook.example.test") {
      if (teamsSendFailure) throw new Error("Teams network failure");
      if (teamsResponseStatus >= 200 && teamsResponseStatus < 300)
        teamsAccepted = true;
      return response(null, teamsResponseStatus);
    }
    if (parsed.hostname !== "supabase.example.test")
      throw new Error(`Unexpected URL ${url}`);

    const table = parsed.pathname.split("/").pop();
    const method = init.method || "GET";
    const failure =
      failPostSendAudit &&
      teamsAccepted &&
      table === "digest_log" &&
      method === "PATCH"
        ? { status: 500 }
        : storageFailure?.({ table, method, url: parsed.toString() });
    if (failure)
      return response(
        failure.body || { error: "injected storage failure" },
        failure.status || 500,
      );
    if (method === "GET" && table === "claim_extracts")
      return response(noExtract ? [] : extracts);
    if (method === "GET" && table === "claims") {
      const id = parsed.searchParams.get("extract_id") || "";
      return response(id.includes("previous") ? previousClaims : claims);
    }
    if (method === "GET" && table === "scout_settings")
      return response(noSettings ? [] : [{ value: defaultSettings }]);
    if (table === "briefing_deliveries") {
      const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
      if (method === "GET")
        return response(id && deliveries.has(id) ? [deliveries.get(id)] : []);
      if (method === "POST") {
        const body = JSON.parse(init.body);
        if (deliveries.has(body.id))
          return response(
            { code: "23505", message: "duplicate key value" },
            409,
          );
        deliveries.set(id || body.id, { ...body });
        return response([{ ...body }], 201);
      }
      if (method === "PATCH") {
        const body = JSON.parse(init.body);
        const current = deliveries.get(id) || { id };
        deliveries.set(id, { ...current, ...body });
        return response([{ ...deliveries.get(id) }]);
      }
    }
    if (table === "briefing_runs") {
      if (method === "POST") {
        const body = JSON.parse(init.body);
        const id = `run-${++sequence}`;
        runs.set(id, { id, ...body });
        return response([{ id, ...body }], 201);
      }
      if (method === "PATCH") {
        const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
        const body = JSON.parse(init.body);
        runs.set(id, { ...(runs.get(id) || { id }), ...body });
        return response([{ ...runs.get(id) }]);
      }
      if (method === "GET") return response([...runs.values()]);
    }
    if (table === "digest_log") {
      if (method === "POST") {
        const body = JSON.parse(init.body);
        const id = `digest-${++sequence}`;
        digests.set(id, { id, ...body });
        return response([{ id, ...body }], 201);
      }
      if (method === "PATCH") {
        const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
        const body = JSON.parse(init.body);
        digests.set(id, { ...(digests.get(id) || { id }), ...body });
        return response([{ ...digests.get(id) }]);
      }
      if (method === "GET") return response([...digests.values()]);
    }
    return response({ error: "not mocked" }, 404);
  };

  const worker = createBriefingsWorker({
    fetchImpl,
    now: () => new Date("2026-09-11T06:30:00Z"),
  });
  return {
    worker,
    env: environment(overrides),
    calls,
    deliveries,
    runs,
    digests,
  };
}

function request(
  path,
  {
    method = "GET",
    body,
    token = "token-good",
    origin = PRODUCTION_ORIGIN,
  } = {},
) {
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://scout-briefings.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(result) {
  return result.json();
}

function sendPayload(idempotencyKey = "send-key", extra = {}) {
  return {
    briefingType: "manager",
    idempotencyKey,
    ...extra,
  };
}

function teamsCalls(calls) {
  return calls.filter((call) => call.url === teamsWebhook);
}

function supabaseCalls(calls) {
  return calls.filter((call) =>
    call.url.startsWith("https://supabase.example.test/"),
  );
}

function pilotModel(claims, { previousClaims = [], settings = {} } = {}) {
  return buildPilotBriefingModel({
    claims,
    previousClaims,
    extract: { extract_date: "2026-09-10" },
    settings,
  });
}

test("exact production CORS origin is accepted", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(request("/health"), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.equal(
    result.headers.get("Access-Control-Allow-Origin"),
    PRODUCTION_ORIGIN,
  );
});

test("exact production CORS preflight is accepted", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", { method: "OPTIONS", token: null }),
    env,
  );
  assert.equal(result.status, 204);
  assert.equal(
    result.headers.get("Access-Control-Allow-Origin"),
    PRODUCTION_ORIGIN,
  );
});

test("foreign origin is rejected", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/health", { origin: "https://foreign.example.test" }),
    env,
  );
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), null);
});

test("no auth returns 401 on a protected endpoint", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { token: null, method: "POST" }),
    env,
  );
  assert.equal(result.status, 401);
});

test("invalid auth returns 401", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { token: "token-bad", method: "POST" }),
    env,
  );
  assert.equal(result.status, 401);
});

test("authenticated identity outside caller allowlist returns 403", async () => {
  const { worker, env } = makeHarness({ graphIdentity: "other@example.com" });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(result.status, 403);
});

test("missing caller allowlist fails closed", async () => {
  const { worker, env } = makeHarness({
    overrides: { DELIVERY_ALLOWED_CALLERS_JSON: "" },
  });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(result.status, 503);
  assert.equal((await bodyOf(result)).error, "caller_allowlist_unavailable");
});

test("health reveals only generic Teams manager mode", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(request("/health", { token: null }), env);
  const body = await bodyOf(result);
  assert.deepEqual(body, {
    ok: true,
    service: "scout-briefings",
    mode: "pilot",
    delivery: "teams-manager",
    scheduledDelivery: false,
  });
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(body).includes(teamsWebhook), false);
});

test("plan performs no sends", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(teamsCalls(calls).length, 0);
});

test("Supabase uses the dedicated secret API key without a bearer header", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(result.status, 200);
  const requests = supabaseCalls(calls);
  assert.ok(requests.length > 0);
  for (const call of requests) {
    assert.equal(call.init.headers.apikey, supabaseSecretKey);
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.equal(Object.hasOwn(call.init.headers, "Authorization"), false);
  }
});

test("missing Supabase secret fails closed before any Supabase request", async () => {
  const { worker, env, calls } = makeHarness({
    overrides: { SUPABASE_SECRET_KEY: "" },
  });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  const body = await bodyOf(result);
  assert.equal(result.status, 200);
  assert.equal(body.readiness.managerPilotReady, false);
  assert.equal(
    body.readiness.blockingReasons.includes(
      "supabase_configuration_incomplete",
    ),
    true,
  );
  assert.equal(supabaseCalls(calls).length, 0);
});

test("plan surfaces missing handler mappings as a warning only", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  const body = await bodyOf(result);
  assert.deepEqual(body.missingHandlers, ["Unmapped Handler"]);
  assert.equal(body.readiness.managerPilotReady, true);
  assert.deepEqual(body.readiness.blockingReasons, []);
  assert.deepEqual(body.readiness.warnings, [
    "handler_email_mappings_incomplete",
  ]);
});

test("plan returns the authoritative Teams readiness result", async () => {
  const { worker, env } = makeHarness({
    noExtract: true,
    noSettings: true,
    overrides: {
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
      TEAMS_MANAGER_WEBHOOK: "",
    },
  });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  const body = await bodyOf(result);
  assert.equal(result.status, 200);
  assert.equal(body.readiness.managerPilotReady, false);
  assert.deepEqual(body.readiness.blockingReasons, [
    "current_extract_unavailable",
    "scout_settings_digest_row_unavailable",
    "manager_briefing_configuration_unavailable",
    "supabase_configuration_incomplete",
    "teams_manager_webhook_unavailable",
  ]);
});

test("missing Teams manager webhook fails closed before reservation", async () => {
  const { worker, env, calls } = makeHarness({
    overrides: { TEAMS_MANAGER_WEBHOOK: "" },
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: sendPayload("missing-webhook"),
    }),
    env,
  );
  const body = await bodyOf(result);
  assert.equal(result.status, 503);
  assert.equal(body.error, "manager_pilot_not_ready");
  assert.equal(
    body.blockingReasons.includes("teams_manager_webhook_unavailable"),
    true,
  );
  assert.equal(teamsCalls(calls).length, 0);
});

test("Teams manager webhook readiness requires a valid HTTPS URL", async () => {
  for (const webhook of [
    "not-a-url",
    "http://teams.example.test/trigger",
    "",
  ]) {
    const { worker, env } = makeHarness({
      overrides: { TEAMS_MANAGER_WEBHOOK: webhook },
    });
    const result = await worker.fetch(
      request("/briefings/plan", { method: "POST" }),
      env,
    );
    const body = await bodyOf(result);
    assert.equal(result.status, 200, webhook);
    assert.equal(body.readiness.managerPilotReady, false, webhook);
    assert.equal(
      body.readiness.blockingReasons.includes(
        "teams_manager_webhook_unavailable",
      ),
      true,
      webhook,
    );
  }

  const { worker, env } = makeHarness({
    overrides: { TEAMS_MANAGER_WEBHOOK: "https://teams.example.test/trigger" },
  });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  const body = await bodyOf(result);
  assert.equal(result.status, 200);
  assert.equal(body.readiness.managerPilotReady, true);
  assert.equal(
    body.readiness.blockingReasons.includes(
      "teams_manager_webhook_unavailable",
    ),
    false,
  );
});

test("send recomputes readiness before reservation or Teams delivery", async () => {
  const { worker, env, calls } = makeHarness({
    noExtract: true,
    noSettings: true,
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: sendPayload("blocked-key"),
    }),
    env,
  );
  const body = await bodyOf(result);
  assert.equal(result.status, 503);
  assert.equal(body.error, "manager_pilot_not_ready");
  assert.equal(
    body.blockingReasons.includes("current_extract_unavailable"),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.init.method === "POST" && call.url.includes("briefing_deliveries"),
    ),
    false,
  );
  assert.equal(teamsCalls(calls).length, 0);
});

test("request-controlled destination fields are rejected", async () => {
  for (const field of [
    "pilotRecipient",
    "recipient",
    "webhook",
    "webhookUrl",
    "channel",
    "destination",
  ]) {
    const { worker, env, calls } = makeHarness();
    const result = await worker.fetch(
      request("/briefings/send-pilot", {
        method: "POST",
        body: sendPayload(`destination-${field}`, {
          [field]: "attacker-value",
        }),
      }),
      env,
    );
    assert.equal(result.status, 400, field);
    assert.equal((await bodyOf(result)).error, "destination_not_allowed");
    assert.equal(teamsCalls(calls).length, 0);
  }
});

test("only manager briefing type is accepted", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: sendPayload("handler-key", { briefingType: "handler" }),
    }),
    env,
  );
  assert.equal(result.status, 400);
  assert.equal((await bodyOf(result)).error, "only_manager_pilot_supported");
});

test("missing idempotency key is rejected", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: { briefingType: "manager" },
    }),
    env,
  );
  assert.equal(result.status, 400);
  assert.equal((await bodyOf(result)).error, "idempotency_key_required");
});

test("successful manager send is transport accepted with exactly one webhook call", async () => {
  const { worker, env, calls, deliveries, runs, digests } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: sendPayload("success-key"),
    }),
    env,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await bodyOf(result), {
    ok: true,
    status: "accepted",
    transportAccepted: true,
    deliveryConfirmed: false,
    mode: "pilot",
    briefingType: "manager",
  });
  assert.equal([...deliveries.values()][0].status, "accepted");
  assert.equal([...runs.values()][0].status, "completed");
  assert.equal([...digests.values()][0].sent_ok, true);
  const sends = teamsCalls(calls);
  assert.equal(sends.length, 1);
  const payload = JSON.parse(sends[0].init.body);
  assert.equal(payload.type, "message");
  assert.equal(payload.attachments.length, 1);
  assert.equal(
    payload.attachments[0].contentType,
    "application/vnd.microsoft.card.adaptive",
  );
  assert.match(payload.attachments[0].content.body[1].text, /Active claims/);
  assert.match(
    payload.attachments[0].content.body[1].text,
    /Management attention/,
  );
  assert.equal(JSON.stringify(payload).includes(supabaseSecretKey), false);
});

test("same idempotency key cannot call Teams twice", async () => {
  const { worker, env, calls } = makeHarness();
  const payload = sendPayload("same-key");
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(first.status, 200);
  assert.equal((await bodyOf(first)).status, "accepted");
  assert.equal(second.status, 200);
  assert.deepEqual(await bodyOf(second), {
    ok: true,
    status: "already-accepted",
    duplicate: true,
    transportAccepted: true,
    deliveryConfirmed: false,
    mode: "pilot",
    briefingType: "manager",
  });
  assert.equal(teamsCalls(calls).length, 1);
});

test("concurrent same-key attempts reserve only once and invoke Teams once", async () => {
  const { worker, env, calls } = makeHarness();
  const payload = sendPayload("concurrent-key");
  const [first, second] = await Promise.all([
    worker.fetch(
      request("/briefings/send-pilot", { method: "POST", body: payload }),
      env,
    ),
    worker.fetch(
      request("/briefings/send-pilot", { method: "POST", body: payload }),
      env,
    ),
  ]);
  const results = await Promise.all([bodyOf(first), bodyOf(second)]);
  assert.equal(
    results.filter((result) => result.status === "accepted").length,
    1,
  );
  assert.equal(
    results.some(
      (result) =>
        result.status === "already-accepted" ||
        result.error === "delivery_in_progress",
    ),
    true,
  );
  assert.equal(teamsCalls(calls).length, 1);
});

test("clear Teams HTTP rejection is failed and does not retry", async () => {
  const { worker, env, calls } = makeHarness({ teamsResponseStatus: 400 });
  const payload = sendPayload("rejected-key");
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const firstBody = await bodyOf(first);
  assert.equal(first.status, 502);
  assert.equal(firstBody.error, "teams_delivery_failed");
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(second.status, 409);
  assert.equal((await bodyOf(second)).error, "idempotency_key_used");
  assert.equal(teamsCalls(calls).length, 1);
});

test("ambiguous Teams failure is delivery_unknown and same key does not retry", async () => {
  const { worker, env, calls } = makeHarness({ teamsSendFailure: true });
  const payload = sendPayload("ambiguous-key");
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const firstBody = await bodyOf(first);
  assert.equal(first.status, 502);
  assert.equal(firstBody.error, "teams_delivery_ambiguous");
  assert.equal(firstBody.transportAccepted, null);
  assert.equal(firstBody.deliveryConfirmed, false);
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(second.status, 409);
  assert.equal((await bodyOf(second)).error, "idempotency_key_used");
  assert.equal(teamsCalls(calls).length, 1);
});

test("accepted Teams delivery followed by audit failure is accepted_audit_incomplete", async () => {
  const { worker, env, calls, deliveries } = makeHarness({
    failPostSendAudit: true,
  });
  const payload = sendPayload("audit-failure-key");
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const firstBody = await bodyOf(first);
  assert.equal(first.status, 502);
  assert.equal(firstBody.error, "accepted_audit_incomplete");
  assert.equal(firstBody.transportAccepted, true);
  assert.equal(firstBody.deliveryConfirmed, false);
  assert.equal([...deliveries.values()][0].status, "accepted_audit_incomplete");
  const sendCount = teamsCalls(calls).length;
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(second.status, 409);
  assert.equal(teamsCalls(calls).length, sendCount);
});

test("briefing parity uses the accepted no-movement and Risk Watch rules", () => {
  const fifteenDays = pilotModel([
    {
      claim_no: "NM-15",
      status: "Active",
      working_age: 10,
      outstanding: 100,
      estimate: 100,
      days_since_movement: 15,
    },
  ]);
  assert.equal(fifteenDays.metrics.noMovement, 0);

  const thirtyOneDays = pilotModel([
    {
      claim_no: "NM-31",
      status: "Active",
      working_age: 10,
      outstanding: 100,
      estimate: 100,
      days_since_movement: 31,
    },
  ]);
  assert.equal(thirtyOneDays.metrics.noMovement, 1);

  const repudiated = pilotModel([
    {
      claim_no: "REP-1",
      status: "Repudiated",
      working_age: 2,
      outstanding: 100,
      estimate: 100,
    },
  ]);
  assert.deepEqual(
    repudiated.topRisks.items.map((item) => item.claimNo),
    ["REP-1"],
  );
});

test("briefing parity uses the deterministic six-rule closure model", () => {
  const model = pilotModel(
    [
      {
        claim_no: "CLOSE-1",
        status: "Repudiated - Awaiting Closure",
        working_age: 8,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "CLOSE-2",
        status: "Payment - Payments Made",
        working_age: 22,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "CLOSE-3",
        status: "Payment Released",
        working_age: 15,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "CLOSE-4",
        status: "Settled",
        working_age: 15,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "CLOSE-5",
        status: "Settled - Awaiting Recovery",
        working_age: 15,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "CLOSE-6",
        status: "Payment Requested",
        working_age: 31,
        outstanding: 100,
        estimate: 0,
      },
      {
        claim_no: "CLOSE-7",
        status: "Registered",
        working_age: 61,
        outstanding: 100,
        estimate: 100,
      },
    ],
    { settings: { include_terminal_claims: true } },
  );

  assert.equal(model.metrics.closure, 6);
  assert.equal(
    model.handler.items.some((item) => item.claimNo === "CLOSE-5"),
    false,
  );
  assert.equal(
    model.handler.items.some((item) => item.claimNo === "CLOSE-4"),
    true,
  );
});

test("briefing parity covers zero estimate, mandate, overdue, and new-claim fixtures", () => {
  const model = pilotModel(
    [
      {
        claim_no: "ZERO-1",
        status: "Payment Requested",
        working_age: 1,
        outstanding: 100,
        estimate: 0,
      },
      {
        claim_no: "MANDATE-1",
        status: "Active",
        working_age: 2,
        outstanding: 100000,
        estimate: 100000,
      },
      {
        claim_no: "ASSESSOR-1",
        status: "Awaiting Assessor Report",
        working_age: 7,
        outstanding: 100,
        estimate: 100,
        possible_duplicate: true,
      },
      {
        claim_no: "BROKER-1",
        status: "Awaiting Broker Feedback",
        working_age: 8,
        outstanding: 100,
        estimate: 100,
      },
      {
        claim_no: "NEW-1",
        status: "Registered",
        working_age: 0,
        outstanding: 100,
        estimate: 100,
        last_updated_source: "new-claim",
      },
    ],
    {
      previousClaims: [
        {
          claim_no: "OLD-1",
          status: "Active",
          working_age: 1,
          outstanding: 100,
          estimate: 100,
        },
      ],
    },
  );

  assert.equal(model.metrics.zeroEstimate, 1);
  assert.equal(model.metrics.mandate, 1);
  assert.equal(model.metrics.newClaims, 1);
  assert.equal(
    model.attention.some((section) => section.key === "mandate"),
    true,
  );
  assert.equal(
    model.handler.items.find((item) => item.claimNo === "ASSESSOR-1")
      ?.nextAction,
    "Chase assessor report",
  );
  assert.equal(
    model.handler.items.find((item) => item.claimNo === "BROKER-1")?.nextAction,
    "Follow up with broker or client",
  );
  assert.equal(
    model.handler.items.some((item) => item.claimNo === "NEW-1"),
    true,
  );
});

test("configuration has no scheduled trigger, routes, assets, or webhook var", async () => {
  const config = await readFile("./wrangler.briefings.jsonc", "utf8");
  assert.match(config, /"name"\s*:\s*"scout-briefings"/);
  assert.doesNotMatch(config, /"triggers"|"crons"|"scheduled"/i);
  assert.doesNotMatch(config, /"routes"|"assets"/i);
  const secretsBlock = config.match(
    /"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([\s\S]*?)\]/,
  );
  assert.ok(secretsBlock);
  const requiredSecrets = [
    "SUPABASE_SECRET_KEY",
    "DELIVERY_ALLOWED_CALLERS_JSON",
    "TEAMS_MANAGER_WEBHOOK",
  ];
  assert.deepEqual(
    [...secretsBlock[1].matchAll(/"([^\"]+)"/g)].map((match) => match[1]),
    requiredSecrets,
  );
  for (const secret of requiredSecrets) {
    assert.match(secretsBlock[1], new RegExp(`"${secret}"`));
  }
  assert.doesNotMatch(config, /SUPABASE_SERVICE_ROLE_KEY/);
  const varsBlock = config.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(varsBlock);
  for (const secret of requiredSecrets) {
    assert.doesNotMatch(varsBlock[1], new RegExp(`"${secret}"`));
  }
});

test("Supabase secret is absent from API responses, source, and configuration", async () => {
  const source = await readFile("./scout-briefings.js", "utf8");
  const config = await readFile("./wrangler.briefings.jsonc", "utf8");
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(source, /console\.(log|warn|error)\s*\(/);
  assert.equal(config.includes(supabaseSecretKey), false);
  const { worker, env } = makeHarness();
  const health = await worker.fetch(request("/health", { token: null }), env);
  const plan = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(
    JSON.stringify(await bodyOf(health)).includes(supabaseSecretKey),
    false,
  );
  assert.equal(
    JSON.stringify(await bodyOf(plan)).includes(supabaseSecretKey),
    false,
  );
});

test("Graph application email and legacy proxy delivery are absent", async () => {
  const source = await readFile("./scout-briefings.js", "utf8");
  assert.doesNotMatch(
    source,
    /sendMail|client_credentials|AZURE_CLIENT_SECRET|MAIL_FROM|scout-teams-proxy/i,
  );
  assert.match(source, /graph\.microsoft\.com\/v1\.0\/me/);
  assert.match(source, /sendTeamsManagerBriefing/);
});

test("Teams credential is not present in source, config, or API output", async () => {
  const source = await readFile("./scout-briefings.js", "utf8");
  const config = await readFile("./wrangler.briefings.jsonc", "utf8");
  assert.equal(source.includes(teamsWebhook), false);
  assert.equal(config.includes(teamsWebhook), false);
  const { worker, env } = makeHarness({
    overrides: { TEAMS_MANAGER_WEBHOOK: "secret-value-that-must-not-leak" },
  });
  const result = await worker.fetch(request("/health", { token: null }), env);
  assert.equal(
    JSON.stringify(await bodyOf(result)).includes("secret-value"),
    false,
  );
});

test("manager message is capped and retains accepted operational meaning", async () => {
  const claims = Array.from({ length: 328 }, (_, index) => ({
    claim_no: `CLM-${String(index + 1).padStart(3, "0")}`,
    status: index % 2 ? "Active" : "Repudiated",
    working_age: index + 1,
    outstanding: 1000,
    estimate: 1000,
  }));
  const { worker, env, calls } = makeHarness({ claims });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: sendPayload("capped-key"),
    }),
    env,
  );
  assert.equal(result.status, 200);
  const payload = JSON.parse(teamsCalls(calls)[0].init.body);
  const text = payload.attachments[0].content.body[1].text;
  assert.match(text, /Data as at/);
  assert.match(text, /Active claims/);
  assert.match(text, /Critical SLA/);
  assert.match(text, /Stale \/ at-risk/);
  assert.match(text, /Outstanding exposure/);
  assert.match(text, /Management attention/);
  assert.match(text, /Top risk watch/);
  assert.ok(text.length < 12000);
  assert.equal(text.includes("CLM-328"), false);
});

test("history endpoints omit recipient fields", async () => {
  const { worker, env } = makeHarness();
  const runs = await worker.fetch(request("/briefing-runs"), env);
  const digests = await worker.fetch(request("/digest-log"), env);
  assert.equal(JSON.stringify(await bodyOf(runs)).includes("recipient"), false);
  assert.equal(
    JSON.stringify(await bodyOf(digests)).includes("recipient"),
    false,
  );
});
