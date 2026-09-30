/*
 * MS2 parent-identity focused tests for manager briefings.
 *
 * These cover the parent-safe behaviour required by the accepted MS2 model:
 * logical parents counted once, conservative lifecycle roll-up, fail-closed
 * financials, authoritative-only criticality, gated cross-period comparison, and
 * a deterministic, send-free plan.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagerBriefing,
  buildPilotBriefingModel,
  createBriefingsWorker,
  historySnapshotForBriefing,
  PRODUCTION_ORIGIN,
} from "./scout-briefings.js";
import {
  diffParentPresence,
  groupSnapshotsByParent,
  parentIdentityKey,
} from "./reporting-domain/claim-parent.mjs";

const RUN_NOW = new Date("2026-09-11T06:30:00Z");

// A briefing snapshot row (the shape historySnapshotForBriefing produces),
// carrying the domain fields the accepted parent primitives consume.
function row(overrides = {}) {
  const status = overrides.status ?? "Active";
  const claim = overrides.claim ?? "MS-1";
  const age = overrides.age ?? 5;
  const days = overrides.daysSinceMovement ?? null;
  return {
    source_claim_number: claim,
    claimNo: claim,
    claim_no: claim,
    source_system: "cardinal_claims",
    source_row_index: overrides.rowIndex ?? 0,
    status,
    status_raw: status,
    status_normalized:
      overrides.status_normalized ?? String(status).toLowerCase(),
    terminal: overrides.terminal === true,
    open: overrides.terminal === true ? false : true,
    handler: overrides.handler ?? "Handler A",
    handler_email: overrides.handler_email ?? "handler.a@example.test",
    insured: overrides.insured ?? "Shared Insured",
    registered_date: overrides.registered_date ?? "2026-08-01",
    dol_date: overrides.dol_date ?? "2026-07-01",
    insurer: overrides.insurer ?? "Insurer X",
    movement_date: overrides.movement_date ?? null,
    working_age: age,
    workingAge: age,
    outstanding: overrides.outstanding ?? 0,
    estimate: overrides.estimate ?? 1000,
    paid: 0,
    data_quality_flags: overrides.data_quality_flags ?? [],
    daysSinceMovement: days,
    days_since_movement: days,
    ...(overrides.extra || {}),
  };
}

function model(claims, { previousClaims = [], settings = {} } = {}) {
  return buildPilotBriefingModel({
    claims,
    previousClaims,
    extract: { extract_date: "2026-09-10" },
    settings,
  });
}

test("a 2-row legitimate multi-section parent counts once", () => {
  const result = model([
    row({ claim: "MS-1", rowIndex: 0, status: "Active" }),
    row({ claim: "MS-1", rowIndex: 1, status: "Awaiting Assessor Report" }),
  ]);
  assert.equal(result.metrics.active, 1);
  assert.equal(result.active.length, 1);
  assert.equal(result.handler.active.length, 1);
  const parent = result.active[0].__parent;
  assert.equal(parent.multiRow, true);
  assert.equal(parent.rowCount, 2);
  // Differing child rows are a multi-section claim, never a collision.
  assert.equal(result.active[0].possible_duplicate, false);
  assert.equal(parent.identityQuality, "valid");
});

test("2->1->2 cardinality keeps one stable parent key and manufactures no movement", () => {
  // Distinct child snapshot UUIDs across three extracts; identity is the logical
  // parent key, never a child UUID.
  const extract1 = [
    row({
      claim: "CARD-1",
      rowIndex: 0,
      status: "Active",
      extra: { id: "uuid-a1" },
    }),
    row({
      claim: "CARD-1",
      rowIndex: 1,
      status: "Awaiting Assessor Report",
      extra: { id: "uuid-a2" },
    }),
  ];
  const extract2 = [
    row({
      claim: "CARD-1",
      rowIndex: 0,
      status: "Active",
      extra: { id: "uuid-b1" },
    }),
  ];
  const extract3 = [
    row({
      claim: "CARD-1",
      rowIndex: 0,
      status: "Active",
      extra: { id: "uuid-c1" },
    }),
    row({
      claim: "CARD-1",
      rowIndex: 1,
      status: "Awaiting Assessor Report",
      extra: { id: "uuid-c2" },
    }),
  ];

  const EXPECTED_KEY = "cardinal_claims:CARD-1";
  assert.equal(parentIdentityKey(extract1[0]), EXPECTED_KEY);

  // The accepted parent identity is stable and never a child UUID.
  const [p1] = groupSnapshotsByParent(extract1);
  const [p2] = groupSnapshotsByParent(extract2);
  const [p3] = groupSnapshotsByParent(extract3);
  assert.equal(p1.parent_identity_key, EXPECTED_KEY);
  assert.equal(p2.parent_identity_key, EXPECTED_KEY);
  assert.equal(p3.parent_identity_key, EXPECTED_KEY);
  assert.notEqual(p2.parent_identity_key, "uuid-b1");

  // Presence across every adjacent pair yields no first/missing/reopened/terminal
  // events for the parent — cardinality churn is not a lifecycle transition.
  assert.deepEqual(diffParentPresence(p1 ? [p1] : [], [p2]), []);
  assert.deepEqual(diffParentPresence([p2], [p3]), []);

  // The briefing layer counts the parent once each period and never flags it new
  // or newly critical off the cardinality change.
  const middle = model(extract2, { previousClaims: extract1 });
  const back = model(extract3, { previousClaims: extract2 });
  for (const result of [middle, back]) {
    assert.equal(result.comparisonAvailable, true);
    assert.equal(result.metrics.active, 1);
    assert.equal(result.metrics.newClaims, 0);
    assert.equal(result.metrics.critical, 0);
    assert.equal(result.active[0].__parent.key, EXPECTED_KEY);
  }
});

test("a claim-invariant conflict is kept in inventory but gated from ranking and comparison", () => {
  // Same claim number, but the rows DISAGREE on a parent-identifying invariant
  // (insured) — a real identity conflict, not a section-varying difference. Both
  // rows are otherwise an authoritative critical SLA breach.
  const current = [
    row({
      claim: "CONF-1",
      rowIndex: 0,
      status: "Awaiting Broker Feedback",
      age: 8,
      insured: "Alpha Holdings",
    }),
    row({
      claim: "CONF-1",
      rowIndex: 1,
      status: "Awaiting Broker Feedback",
      age: 8,
      insured: "Beta Industries",
    }),
  ];
  const result = model(current, { previousClaims: [] });

  // Retained in active inventory via the accepted lifecycle roll-up...
  assert.equal(result.metrics.active, 1);
  assert.equal(result.active[0].__parent.identityQuality, "conflict");
  // ...but excluded from ranked critical/stale buckets and top-risk ranking...
  assert.equal(result.metrics.critical, 0);
  assert.equal(result.metrics.stale, 0);
  assert.equal(
    result.attention.some((section) => section.claims.length),
    false,
  );
  assert.equal(result.topRisks.items.length, 0);
  // ...and never confirmed as new/newly-critical movement.
  const withPrevious = model(current, {
    previousClaims: [row({ claim: "OTHER-1", status: "Active" })],
  });
  assert.equal(withPrevious.metrics.newClaims, 0);
  assert.equal(withPrevious.metrics.newCritical, 0);
  // It is surfaced instead as a bounded data-quality exception.
  const briefing = buildManagerBriefing(
    result,
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  assert.match(briefing.text, /Data-quality exceptions/);
  assert.match(
    briefing.text,
    /CONF-1 — claim-identity conflict; resolve source rows before ranking/,
  );
});

test("a multi-row parent with disagreeing handlers fails closed to a neutral handler", () => {
  // Two legitimate sections of ONE parent (same identity invariants), but with
  // different populated handlers.
  const result = model([
    row({
      claim: "MULTI-H",
      rowIndex: 0,
      status: "Active",
      extra: {
        handler_source: "Alice Adams",
        handler_email: "alice@example.test",
      },
    }),
    row({
      claim: "MULTI-H",
      rowIndex: 1,
      status: "Active",
      extra: { handler_source: "Bob Brown", handler_email: "bob@example.test" },
    }),
  ]);
  // Counted once.
  assert.equal(result.metrics.active, 1);
  const parent = result.active[0];
  // Never assigned to an arbitrary representative child handler.
  assert.equal(parent.handler, "Multiple handlers");
  assert.notEqual(parent.handler, "Alice Adams");
  assert.notEqual(parent.handler, "Bob Brown");
  assert.equal(parent.__parent.handlerAmbiguous, true);
  assert.ok(parent.__parent.qualityFlags.includes("parent_handler_ambiguous"));
  // Team totals attribute the parent to the neutral bucket, not to either child.
  const handlers = result.team.map((entry) => entry.handler);
  assert.ok(handlers.includes("Multiple handlers"));
  assert.equal(handlers.includes("Alice Adams"), false);
  assert.equal(handlers.includes("Bob Brown"), false);
});

test("a multi-row parent stays critical when only one child breaches SLA (order-independent)", () => {
  // One open child in an authoritative critical SLA status, one open child in a
  // benign status — same logical parent identity.
  const rows = [
    row({
      claim: "ONE-CRIT",
      rowIndex: 0,
      status: "Awaiting Broker Feedback",
      age: 8,
    }),
    row({ claim: "ONE-CRIT", rowIndex: 1, status: "Active", age: 8 }),
  ];
  for (const ordered of [rows, rows.slice().reverse()]) {
    const result = model(ordered);
    assert.equal(result.metrics.active, 1);
    assert.equal(result.metrics.critical, 1);
    assert.equal(result.active[0].__parent.criticalEvidence, true);
  }
});

test("a parent is open when one child is open and one is terminal", () => {
  const result = model([
    row({ claim: "OPEN-1", rowIndex: 0, status: "Active" }),
    row({ claim: "OPEN-1", rowIndex: 1, status: "Settled", terminal: true }),
  ]);
  assert.equal(result.metrics.active, 1);
  assert.equal(result.active[0].__parent.lifecycleState, "open");
});

test("a parent is terminal only when all usable children are terminal", () => {
  const terminalRows = () => [
    row({
      claim: "TERM-1",
      rowIndex: 0,
      status: "Closed Paid",
      terminal: true,
    }),
    row({ claim: "TERM-1", rowIndex: 1, status: "Cancelled", terminal: true }),
  ];
  // All children terminal -> parent terminal -> excluded from the active book.
  const active = model(terminalRows());
  assert.equal(active.metrics.active, 0);
  // Confirm the roll-up itself is terminal (inspected with terminals included).
  const inspected = model(terminalRows(), {
    settings: { include_terminal_claims: true },
  });
  assert.equal(inspected.active[0].__parent.lifecycleState, "terminal");
});

test("missing/unmapped child evidence fails closed and never terminalizes", () => {
  const result = model(
    [
      row({ claim: "MISS-1", rowIndex: 0, status: "Settled", terminal: true }),
      row({
        claim: "MISS-1",
        rowIndex: 1,
        status: "",
        status_normalized: "",
        data_quality_flags: ["missing_status"],
      }),
    ],
    { settings: { include_terminal_claims: true } },
  );
  const parent = result.active[0].__parent;
  // A terminal sibling plus missing evidence must stay OPEN, not close.
  assert.equal(parent.lifecycleState, "open");
  assert.ok(parent.qualityFlags.includes("parent_status_incomplete"));
});

test("a single-row-safe portfolio reports a numeric exposure", () => {
  const result = model([
    row({ claim: "SAFE-1", outstanding: 30000 }),
    row({ claim: "SAFE-2", outstanding: 12000 }),
  ]);
  assert.equal(result.metrics.exposure, 42000);
  const briefing = buildManagerBriefing(
    result,
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  assert.match(briefing.text, /Outstanding exposure: R42[\s ]?000/);
  assert.doesNotMatch(briefing.text, /Outstanding exposure: unavailable/);
});

test("portfolio exposure fails closed to unavailable with any unsafe multi-row parent", () => {
  const result = model([
    // A safe single-row parent that would otherwise contribute a real number.
    row({ claim: "SAFE-9", outstanding: 25000 }),
    // An unsafe multi-row parent whose financial aggregation is unresolved.
    row({ claim: "FIN-1", rowIndex: 0, outstanding: 50000 }),
    row({ claim: "FIN-1", rowIndex: 1, outstanding: 50000 }),
  ]);
  // Individual unsafe parent financial fields remain null.
  const unsafe = result.active.find((claim) => claim.__parent.multiRow);
  assert.equal(unsafe.outstanding, null);
  assert.equal(unsafe.__parent.financialsAvailable, false);
  // The portfolio exposure METRIC itself is unavailable — not a partial total,
  // and never an R0 substitution.
  assert.equal(result.metrics.exposure, null);
  const briefing = buildManagerBriefing(
    result,
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  assert.match(
    briefing.text,
    /Outstanding exposure: unavailable — multi-section financial aggregation unresolved/,
  );
  // The safe parent's real value must not leak out as a partial portfolio total.
  assert.doesNotMatch(briefing.text, /Outstanding exposure: R/);
});

test("an unsafe multi-row parent in attention never renders outstanding as R0", () => {
  // Two sections of ONE parent (no invariant conflict), both an authoritative
  // critical SLA breach, so the parent is rankable and surfaces in attention —
  // but its financial aggregation is unsafe.
  const result = model([
    row({
      claim: "UNSAFE-CRIT",
      rowIndex: 0,
      status: "Awaiting Broker Feedback",
      age: 8,
      outstanding: 40000,
    }),
    row({
      claim: "UNSAFE-CRIT",
      rowIndex: 1,
      status: "Awaiting Broker Feedback",
      age: 8,
      outstanding: 40000,
    }),
  ]);
  assert.equal(result.metrics.active, 1);
  assert.equal(result.metrics.critical, 1);
  assert.equal(result.active[0].__parent.financialsAvailable, false);
  assert.equal(result.metrics.exposure, null);

  const briefing = buildManagerBriefing(
    result,
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  // The parent appears in management attention with its outstanding explicitly
  // unavailable — never formatted as R0.
  assert.match(
    briefing.text,
    /UNSAFE-CRIT — Critical SLA breach;[^\n]*; outstanding unavailable/,
  );
  assert.doesNotMatch(briefing.text, /R0\b/);
});

test("parent identity carries the manifest source_system explicitly", () => {
  // A non-default source system must flow into the projected snapshot rows so
  // parent identity is source_system + claim number, never a cardinal_claims
  // fallback.
  const adapted = historySnapshotForBriefing(
    {
      source_claim_number: "LEG-1",
      status_raw: "Active",
      status_normalized: "active",
      terminal: false,
      open: true,
      data_quality_flags: [],
    },
    { source_system: "legacy_claims", effective_date: "2026-09-10" },
  );
  assert.equal(adapted.source_system, "legacy_claims");
  assert.equal(parentIdentityKey(adapted), "legacy_claims:LEG-1");
  assert.notEqual(parentIdentityKey(adapted), "cardinal_claims:LEG-1");

  // Grouping (current and previous alike use the same adapter) keys on it.
  const [parent] = groupSnapshotsByParent([adapted]);
  assert.equal(parent.parent_identity_key, "legacy_claims:LEG-1");
});

test("a bare age of 30+ is not independently critical", () => {
  // "Active" is not an SLA-mapped taxonomy status, so age alone drives nothing.
  const result = model([row({ claim: "AGE-1", status: "Active", age: 45 })]);
  assert.equal(result.metrics.active, 1);
  assert.equal(result.metrics.critical, 0);
});

test("a bare priority score of 60+ is not independently critical", () => {
  const result = model([
    row({
      claim: "SCORE-1",
      status: "Active",
      age: 10,
      outstanding: 100000,
      estimate: 100000,
      daysSinceMovement: 31,
    }),
  ]);
  const item = result.handler.items.find(
    (entry) => entry.claimNo === "SCORE-1",
  );
  assert.ok(item && item.score >= 60, "fixture must reach a bare score >= 60");
  assert.equal(result.metrics.critical, 0);
});

test("an authoritative critical SLA breach remains critical", () => {
  // "Awaiting Broker Feedback" is critical at age >= 7 by the accepted taxonomy.
  const result = model([
    row({ claim: "SLA-1", status: "Awaiting Broker Feedback", age: 8 }),
  ]);
  assert.equal(result.metrics.critical, 1);
});

test("[none] evidence stays missing (not unmapped) and fails closed", () => {
  // The adapter preserves an intentionally empty normalized status as missing.
  const adapted = historySnapshotForBriefing(
    {
      source_claim_number: "NONE-1",
      status_raw: "[none]",
      status_normalized: "",
      terminal: false,
      open: true,
      data_quality_flags: [],
    },
    { effective_date: "2026-09-10" },
  );
  assert.equal(adapted.status_normalized, "");
  assert.equal(adapted.status, "");
  assert.notEqual(adapted.terminal, true);

  // A parent whose evidence is all-missing is unresolved and open, never closed.
  const result = model(
    [
      row({ claim: "NONE-1", rowIndex: 0, status: "", status_normalized: "" }),
      row({ claim: "NONE-1", rowIndex: 1, status: "", status_normalized: "" }),
    ],
    { settings: { include_terminal_claims: true } },
  );
  const parent = result.active[0].__parent;
  assert.equal(parent.lifecycleState, "open");
  assert.equal(parent.stateResolution, "unresolved");
  assert.ok(parent.qualityFlags.includes("parent_status_unresolved"));
});

test("the manager briefing plan is deterministic across input order", () => {
  const claims = [
    row({
      claim: "DET-3",
      status: "Awaiting Broker Feedback",
      age: 8,
      outstanding: 100,
    }),
    row({
      claim: "DET-1",
      status: "Awaiting Broker Feedback",
      age: 8,
      outstanding: 100,
    }),
    row({
      claim: "DET-2",
      status: "Awaiting Broker Feedback",
      age: 8,
      outstanding: 100,
    }),
  ];
  const forward = buildManagerBriefing(
    model(claims),
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  const reversed = buildManagerBriefing(
    model(claims.slice().reverse()),
    { extract_date: "2026-09-10" },
    RUN_NOW,
  );
  assert.equal(forward.text, reversed.text);
  const order = forward.text
    .split("\n")
    .filter((line) => /^- DET-/.test(line))
    .map((line) => line.slice(2, 7));
  // Deterministic tie-break falls through to claim number ascending.
  assert.deepEqual(order, ["DET-1", "DET-2", "DET-3"]);
});

test("generating a briefing plan performs no Teams send", async () => {
  const teamsWebhook = "https://teams-webhook.example.test/trigger";
  const calls = [];
  const manifest = {
    id: "extract-latest",
    source_system: "cardinal_claims",
    schema_version: "scout-history-v1",
    effective_at: "2026-09-10T06:00:00Z",
    effective_date: "2026-09-10",
    received_at: "2026-09-10T06:01:00Z",
    created_at: "2026-09-10T06:02:00Z",
    claim_count: 2,
    accepted_claim_count: 2,
    quality_summary: {
      comparable_to_previous: true,
      completeness_state: "complete",
    },
    source_metadata: { portfolio_scope: null },
    previous_extract_id: null,
    correction_of_extract_id: null,
    status: "accepted",
    historical_persisted: true,
  };
  const dbRow = (index, status) => ({
    id: `extract-latest-snapshot-${index}`,
    extract_id: "extract-latest",
    source_claim_number: "WORKER-1",
    handler_source: "Handler A",
    handler_email: "handler.a@example.test",
    status_raw: status,
    status_normalized: status.toLowerCase(),
    terminal: false,
    open: true,
    registered_date: "2026-08-01",
    dol_date: "2026-07-01",
    movement_date: null,
    repudiation_date: null,
    outstanding: 1000,
    estimate: 1000,
    paid: 0,
    mandate: 0,
    insurer: "Insurer X",
    peril: null,
    peril_type: null,
    insured: "Shared Insured",
    description: null,
    comments: null,
    calendar_age: 5,
    working_age: 5,
    priority_score: 0,
    priority_band: "P3",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
  });
  const jsonResponse = (body, status = 200) =>
    new Response(body == null ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url, init });
    if (parsed.hostname === "graph.microsoft.com")
      return jsonResponse({
        mail: "caller@example.com",
        userPrincipalName: "caller@example.com",
      });
    if (parsed.hostname === "teams-webhook.example.test")
      return jsonResponse(null, 202);
    const table = parsed.pathname.split("/").pop();
    if (table === "scout_history_extracts") return jsonResponse([manifest]);
    if (table === "scout_history_snapshots")
      return jsonResponse([
        dbRow(1, "Active"),
        dbRow(2, "Awaiting Assessor Report"),
      ]);
    if (table === "scout_settings")
      return jsonResponse([{ value: { handler_emails: {} } }]);
    return jsonResponse([]);
  };
  const worker = createBriefingsWorker({ fetchImpl, now: () => RUN_NOW });
  const env = {
    SUPABASE_URL: "https://supabase.example.test",
    SUPABASE_SECRET_KEY: "synthetic-secret-not-production",
    PILOT_APPROVED_EXTRACT_ID: "extract-latest",
    DELIVERY_ALLOWED_CALLERS_JSON: JSON.stringify(["caller@example.com"]),
    TEAMS_MANAGER_WEBHOOK: teamsWebhook,
    SUPABASE_EXTRACTS_TABLE: "scout_history_extracts",
    SUPABASE_CLAIMS_TABLE: "scout_history_snapshots",
    SUPABASE_SETTINGS_TABLE: "scout_settings",
  };
  const request = new Request(
    "https://scout-briefings.example.test/briefings/plan",
    {
      method: "POST",
      headers: {
        Origin: PRODUCTION_ORIGIN,
        Authorization: "Bearer token-good",
      },
    },
  );
  const result = await worker.fetch(request, env);
  assert.equal(result.status, 200);
  const body = await result.json();
  // Two source rows collapse to one logical parent.
  assert.equal(body.activeClaimCount, 1);
  // The plan endpoint never contacts Teams.
  assert.equal(
    calls.filter((call) => call.url.startsWith(teamsWebhook)).length,
    0,
  );
});
