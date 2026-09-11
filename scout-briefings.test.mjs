import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPilotBriefingModel,
  createBriefingsWorker,
  PRODUCTION_ORIGIN,
} from "./scout-briefings.js";

const productionRecipient = "manager@example.com";
const pilotRecipient = "pilot@example.com";

function response(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function environment(overrides = {}) {
  return {
    SUPABASE_URL: "https://supabase.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
    AZURE_TENANT_ID: "tenant-id",
    AZURE_CLIENT_ID: "client-id",
    AZURE_CLIENT_SECRET: "client-secret",
    MAIL_FROM: "briefings@example.com",
    DELIVERY_ALLOWED_CALLERS_JSON: JSON.stringify(["caller@example.com"]),
    DELIVERY_PILOT_RECIPIENTS_JSON: JSON.stringify([pilotRecipient]),
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
  graphSendFailure = false,
  failPostSendAudit = false,
} = {}) {
  const deliveries = new Map();
  const runs = new Map();
  const digests = new Map();
  const calls = [];
  let sequence = 0;
  let graphAccepted = false;
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
    manager_email: productionRecipient,
    zero_estimate_email: productionRecipient,
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
    if (parsed.hostname === "login.microsoftonline.com")
      return response({ access_token: "graph-send-token" });
    if (
      parsed.hostname === "graph.microsoft.com" &&
      parsed.pathname.endsWith("/sendMail")
    ) {
      if (graphSendFailure) throw new Error("Graph network failure");
      graphAccepted = true;
      return response(null, 202);
    }
    if (parsed.hostname !== "supabase.example.test")
      throw new Error(`Unexpected URL ${url}`);

    const table = parsed.pathname.split("/").pop();
    const method = init.method || "GET";
    const failure =
      failPostSendAudit &&
      graphAccepted &&
      table === "briefing_deliveries" &&
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
        deliveries.set(body.id, { ...body });
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

function pilotModel(claims, { previousClaims = [], settings = {} } = {}) {
  return buildPilotBriefingModel({
    claims,
    previousClaims,
    extract: { extract_date: "2026-09-10" },
    settings: { manager_email: productionRecipient, ...settings },
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

test("health reveals no configuration or recipient data", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(request("/health", { token: null }), env);
  const body = await bodyOf(result);
  assert.deepEqual(body, {
    ok: true,
    service: "scout-briefings",
    mode: "pilot",
    scheduledDelivery: false,
  });
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(body).includes(productionRecipient), false);
});

test("plan performs no sends", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(
    calls.some((call) => call.url.endsWith("/sendMail")),
    false,
  );
});

test("plan surfaces missing handler mappings as a warning", async () => {
  const { worker, env } = makeHarness({
    settings: { zero_estimate_email: "" },
  });
  const result = await worker.fetch(
    request("/briefings/plan", { method: "POST" }),
    env,
  );
  const body = await bodyOf(result);
  assert.deepEqual(body.missingHandlers, ["Unmapped Handler"]);
  assert.equal(body.pilotReady, undefined);
  assert.equal(body.readiness.managerPilotReady, true);
  assert.deepEqual(body.readiness.blockingReasons, []);
  assert.deepEqual(body.readiness.warnings, [
    "handler_email_mappings_incomplete",
    "anomaly_recipient_configuration_not_required_for_manager_pilot",
  ]);
});

test("plan returns one authoritative manager readiness result", async () => {
  const { worker, env } = makeHarness({
    noExtract: true,
    noSettings: true,
    overrides: {
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      AZURE_TENANT_ID: "",
      AZURE_CLIENT_ID: "",
      AZURE_CLIENT_SECRET: "",
      MAIL_FROM: "",
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
    "graph_configuration_incomplete",
  ]);
  assert.equal(
    body.readiness.warnings.includes("handler_email_mappings_incomplete"),
    false,
  );
});

test("send recomputes readiness before reservation, audit, or Graph token", async () => {
  const { worker, env, calls } = makeHarness({
    noExtract: true,
    noSettings: true,
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "blocked-key",
      },
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
    calls.some((call) => call.url.includes("login.microsoftonline.com")),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.endsWith("/sendMail")),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.init.method === "POST" && call.url.includes("briefing_deliveries"),
    ),
    false,
  );
});

test("missing anomaly recipient configuration is not a manager-pilot blocker", async () => {
  const { worker, env, calls } = makeHarness({
    settings: { zero_estimate_email: "" },
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "anomaly-warning-key",
      },
    }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(
    calls.filter((call) => call.url.endsWith("/sendMail")).length,
    1,
  );
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

test("pilot recipient outside recipient allowlist returns 403", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient: "other@example.com",
        briefingType: "manager",
        idempotencyKey: "key-1",
      },
    }),
    env,
  );
  assert.equal(result.status, 403);
});

test("missing pilot allowlist fails closed", async () => {
  const { worker, env } = makeHarness({
    overrides: { DELIVERY_PILOT_RECIPIENTS_JSON: "" },
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "key-2",
      },
    }),
    env,
  );
  assert.equal(result.status, 503);
});

test("only manager pilot type is accepted", async () => {
  const { worker, env } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "handler",
        idempotencyKey: "key-3",
      },
    }),
    env,
  );
  assert.equal(result.status, 400);
});

test("production recipient is never used as pilot destination", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "key-4",
      },
    }),
    env,
  );
  assert.equal(result.status, 200);
  const send = calls.find((call) => call.url.endsWith("/sendMail"));
  const sent = JSON.parse(send.init.body);
  assert.equal(
    sent.message.toRecipients[0].emailAddress.address,
    pilotRecipient,
  );
  assert.equal(JSON.stringify(sent).includes(productionRecipient), false);
});

test("missing Graph configuration fails before send", async () => {
  const { worker, env, calls } = makeHarness({
    overrides: { AZURE_CLIENT_SECRET: "", MAIL_FROM: "" },
  });
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "key-5",
      },
    }),
    env,
  );
  assert.equal(result.status, 503);
  assert.equal(
    calls.some((call) => call.url.endsWith("/sendMail")),
    false,
  );
});

test("first idempotency key is eligible and the same key cannot send twice", async () => {
  const { worker, env, calls } = makeHarness();
  const payload = {
    pilotRecipient,
    briefingType: "manager",
    idempotencyKey: "same-key",
  };
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(first.status, 200);
  assert.equal((await bodyOf(first)).status, "sent");
  assert.equal(second.status, 200);
  assert.equal((await bodyOf(second)).status, "already-sent");
  assert.equal(
    calls.filter((call) => call.url.endsWith("/sendMail")).length,
    1,
  );
});

test("concurrent same-key attempts reserve only once and invoke Graph once", async () => {
  const { worker, env, calls } = makeHarness();
  const payload = {
    pilotRecipient,
    briefingType: "manager",
    idempotencyKey: "concurrent-key",
  };
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
  assert.equal(results.filter((result) => result.status === "sent").length, 1);
  assert.equal(
    results.some(
      (result) =>
        result.status === "already-sent" ||
        result.error === "delivery_in_progress",
    ),
    true,
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/sendMail")).length,
    1,
  );
});

test("Graph acceptance followed by audit failure is sent_audit_incomplete and remains consumed", async () => {
  const { worker, env, calls } = makeHarness({ failPostSendAudit: true });
  const payload = {
    pilotRecipient,
    briefingType: "manager",
    idempotencyKey: "audit-failure-key",
  };
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const firstBody = await bodyOf(first);
  assert.equal(first.status, 502);
  assert.equal(firstBody.error, "sent_audit_incomplete");
  assert.equal(firstBody.providerAccepted, true);

  const sendCount = calls.filter((call) =>
    call.url.endsWith("/sendMail"),
  ).length;
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(second.status, 409);
  assert.equal(
    calls.filter((call) => call.url.endsWith("/sendMail")).length,
    sendCount,
  );
});

test("Graph network failure is ambiguous and same-key retry does not call Graph", async () => {
  const { worker, env, calls } = makeHarness({ graphSendFailure: true });
  const payload = {
    pilotRecipient,
    briefingType: "manager",
    idempotencyKey: "ambiguous-key",
  };
  const first = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  const firstBody = await bodyOf(first);
  assert.equal(first.status, 502);
  assert.equal(firstBody.error, "graph_delivery_ambiguous");
  assert.equal(firstBody.providerAccepted, null);

  const sendCount = calls.filter((call) =>
    call.url.endsWith("/sendMail"),
  ).length;
  const second = await worker.fetch(
    request("/briefings/send-pilot", { method: "POST", body: payload }),
    env,
  );
  assert.equal(second.status, 409);
  assert.equal((await bodyOf(second)).error, "idempotency_key_used");
  assert.equal(
    calls.filter((call) => call.url.endsWith("/sendMail")).length,
    sendCount,
  );
});

test("configuration has no scheduled trigger", async () => {
  const config = await readFile("./wrangler.briefings.jsonc", "utf8");
  assert.match(config, /"name"\s*:\s*"scout-briefings"/);
  assert.doesNotMatch(config, /"triggers"|"crons"|"scheduled"/i);
});

test("new Worker has no unrelated delivery implementation", async () => {
  const source = await readFile("./scout-briefings.js", "utf8");
  assert.doesNotMatch(
    source,
    /chat creation|webhook send|ChatMessage\.Send|channel send|sendDM|Teams token/i,
  );
});

test("new Worker has no hard-coded production recipient fallback", async () => {
  const source = await readFile("./scout-briefings.js", "utf8");
  assert.doesNotMatch(source, /@smartsure2020\.co\.za/i);
  assert.doesNotMatch(source, /DEFAULT_MANAGER_EMAIL|MANAGER_EMAIL\s*\|\|/);
});

test("shared briefing model drives generated manager content", async () => {
  const { worker, env, calls } = makeHarness();
  const result = await worker.fetch(
    request("/briefings/send-pilot", {
      method: "POST",
      body: {
        pilotRecipient,
        briefingType: "manager",
        idempotencyKey: "model-key",
      },
    }),
    env,
  );
  assert.equal(result.status, 200);
  const send = calls.find((call) => call.url.endsWith("/sendMail"));
  const sent = JSON.parse(send.init.body);
  assert.match(sent.message.body.content, /CLM-001/);
  assert.match(sent.message.body.content, /Critical|Management attention/);
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
