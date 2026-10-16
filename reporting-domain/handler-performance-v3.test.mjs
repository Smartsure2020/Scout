import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReportSnapshot } from "./reporting-metrics.mjs";
import {
  buildClaimsReportPdfViewModel,
  renderClaimsReportHtml,
} from "./claims-report-pdf.mjs";
import {
  ReportsController,
  reportSnapshot,
} from "../scout-smartsure/claims/reporting-ui.mjs";

// V3 handler reporting is the roster-driven handler_scorecards metric ONLY.
// The legacy `handler_performance` metric (every active SCOUT user with the handler
// role, claims matched by exact resolved user id) listed underwriters as 0-claim
// handlers, reported Lucky as 0 and put the whole Lucky book in "unresolved". It
// must never be written to a new snapshot, while stored v2 snapshots keep
// rendering from their own frozen copy.

const roster = JSON.parse(
  /\$json\$([\s\S]*?)\$json\$/.exec(
    readFileSync(new URL("../scout-reporting-roster.sql", import.meta.url), "utf8"),
  )[1],
);
const UNDERWRITERS = /\b(carol|kelvin|marlene|salome)\b/i;

// Active SCOUT users exactly as the live table shaped the 5-9 Oct incident:
// underwriters carry the handler role, and "Lucky" exists as a user whose name does
// NOT equal Cardinal's "Lucky Mokgomo", so stored rows never get a resolved user id.
const activeUsers = [
  ["u-carol", "Carol", "handler"],
  ["u-kelvin", "Kelvin", "handler"],
  ["u-lucky", "Lucky", "handler"],
  ["u-marlene", "Marlene", "handler"],
  ["u-naledi", "Naledi Moletsane", "handler"],
  ["u-salome", "Salome", "handler"],
  ["u-sarah", "Sarah Dzumba", "handler"],
  ["u-bev", "Beverly De Beer", "manager"],
].map(([id, name, role]) => ({
  id,
  email: `${name.split(" ")[0].toLowerCase()}@example.test`,
  display_name: name,
  role,
  active: true,
}));

function manifest(id, effectiveDate, count) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: id,
    effective_date: effectiveDate,
    received_at: `${effectiveDate}T12:00:00.000Z`,
    status: "accepted",
    historical_persisted: true,
    claim_count: count,
    accepted_claim_count: count,
    quality_summary: {
      completeness_state: "complete",
      comparable_to_previous: true,
      warnings: [],
      unmapped_status_count: 0,
      unknown_handler_count: 0,
      identity_ambiguity_count: 0,
    },
  };
}

let n = 0;
function row(extractId, handler, overrides = {}) {
  n += 1;
  const id = `H-${n}`;
  const userByName = activeUsers.find((user) => user.display_name === handler);
  return {
    extract_id: extractId,
    claim_id: id,
    identity_key: `cardinal_claims:${id}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${id}`,
    source_claim_number: id,
    handler_source: handler,
    handler_email: userByName?.email ?? null,
    // Only an exact SCOUT-user name match carries a resolved id; "Lucky Mokgomo" never does.
    resolved_scout_user_id: userByName?.id ?? null,
    handler_resolution: userByName ? "resolved" : "unrecognised",
    status_raw: "Registered",
    status_normalized: "registered",
    terminal: false,
    open: true,
    registered_date: "2026-07-01",
    dol_date: "2026-06-20",
    movement_date: "2026-08-20",
    repudiation_date: null,
    source_event_at: null,
    outstanding: 1000,
    estimate: 1500,
    paid: 0,
    mandate: 0,
    insurer: "Insurer",
    peril: "Fire",
    peril_type: "Property",
    insured: `Insured ${id}`,
    description: "Fixture",
    comments: null,
    calendar_age: 40,
    working_age: 28,
    rule_version: "claims-operations-rules-v1",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
    ...overrides,
  };
}

function build({ withClosing = true } = {}) {
  n = 0;
  const opening = manifest("v3-open", "2026-08-21", 2);
  const closing = manifest("v3-close", "2026-08-28", 14);
  const closingRows = [
    ...Array.from({ length: 6 }, (_, index) =>
      row(closing.id, "Lucky Mokgomo", index === 0 ? { registered_date: "2026-08-26", calendar_age: 2 } : {}),
    ),
    row(closing.id, "Naledi Moletsane", { calendar_age: 130 }),
    row(closing.id, "Naledi Moletsane"),
    row(closing.id, "Sarah Dzumba"),
    row(closing.id, "Sarah Dzumba", { calendar_age: 95 }),
    row(closing.id, "Beverly De Beer"),
    row(closing.id, "De Beer Bev"),
    row(closing.id, "Nicole Mentor", { registered_date: "2026-08-27", calendar_age: 1 }),
    row(closing.id, "Lesire Make", { calendar_age: 200 }),
  ];
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: withClosing ? [opening, closing] : [],
    snapshotsByExtract: withClosing
      ? new Map([
          [opening.id, [row(opening.id, "Lucky Mokgomo"), row(opening.id, "Sarah Dzumba")]],
          [closing.id, closingRows],
        ])
      : new Map(),
    activeUsers,
    handlerRoster: roster,
  });
}

function runFor(snapshot, status = "finalised") {
  return {
    id: "run-1",
    report_type: "weekly",
    status,
    generated_at: "2026-08-29T08:00:00Z",
    finalised_at: "2026-08-29T09:00:00Z",
    finalised_by: "manager@example.test",
    metrics_snapshot: snapshot,
  };
}

function controller() {
  return new ReportsController({
    document: {
      getElementById: () => null,
      addEventListener() {},
      querySelector: () => null,
    },
    getContext: () => ({ user: { role: "manager" }, freshness: null }),
  });
}

const unescape = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const plain = (html) =>
  unescape(html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

// What the stored 12-16 Oct candidate draft (c256cf6) actually held in the snapshot.
function withStaleLegacyMetric(snapshot) {
  const stale = structuredClone(snapshot);
  stale.metrics.handler_performance = {
    id: "handler_performance",
    value: {
      handlers: [
        ["Carol", 0],
        ["Kelvin", 0],
        ["Lucky", 0],
        ["Marlene", 0],
        ["Naledi Moletsane", 3],
        ["Salome", 0],
        ["Sarah Dzumba", 3],
      ].map(([name, open]) => ({
        handler_id: `u-${name.split(" ")[0].toLowerCase()}`,
        handler_email: `${name.split(" ")[0].toLowerCase()}@example.test`,
        handler_name: name,
        open_claims: open,
        claims_60_plus: 0,
        claims_91_plus: 0,
      })),
      manager_held_other: { count: 2, claim_ids: [] },
      unassigned_unresolved: { count: 162, claim_ids: ["H-1"] },
      active_handler_count: 7,
    },
    availability: "available",
    precision: "snapshot_exact",
    claim_population: { count: 1, claim_ids: ["H-1"] },
  };
  return stale;
}

test("a new v3 snapshot never carries the legacy handler_performance metric", () => {
  const snapshot = build();
  assert.equal(snapshot.metric_definition_version, "claims-reporting-metrics-v3");
  assert.equal(snapshot.report_schema_version, "scout-report-v3");
  assert.equal("handler_performance" in snapshot.metrics, false);
  assert.equal(snapshot.metrics.handler_scorecards.availability, "available");
  assert.equal("handler_performance" in snapshot.comparisons, false);
  const json = JSON.stringify(snapshot);
  for (const legacyKey of ["handler_performance", "unassigned_unresolved", "manager_held_other", "active_handler_count"])
    assert.equal(json.includes(legacyKey), false, `${legacyKey} must not appear anywhere in the snapshot`);
});

test("a v3 snapshot with no closing evidence has no handler_performance shell either", () => {
  const snapshot = build({ withClosing: false });
  assert.equal("handler_performance" in snapshot.metrics, false);
  assert.equal(snapshot.metrics.handler_scorecards.availability, "unavailable");
});

test("no underwriter, Lucky=0 or 162-style unresolved bucket survives anywhere in the v3 snapshot", () => {
  const snapshot = build();
  assert.equal(UNDERWRITERS.test(JSON.stringify(snapshot)), false, "Carol/Kelvin/Marlene/Salome appear nowhere");
  assert.equal(UNDERWRITERS.test(JSON.stringify(snapshot.claim_rows)), false);
  const { cards, totals } = snapshot.metrics.handler_scorecards.value;
  const lucky = cards.find((card) => card.key === "roster:lucky");
  assert.equal(lucky.role, "handler");
  assert.equal(lucky.gross_registered, 6, "Lucky Mokgomo resolves to Lucky through the roster");
  assert.equal(cards.some((card) => card.role === "unrecognised" || card.role === "unassigned"), false, "nothing is pooled as unresolved");
  assert.equal(totals.gross_registered, snapshot.metrics.closing_inventory.value);
});

test("drill-through: no persisted claim row is a member of handler_performance", () => {
  const snapshot = build();
  assert.ok(snapshot.claim_rows.length > 0);
  for (const claim of snapshot.claim_rows) {
    assert.equal(claim.metric_ids.includes("handler_performance"), false, claim.source_claim_number);
    assert.equal("handler_performance" in claim.membership_reasons, false);
    assert.ok(claim.metric_ids.includes("scorecard_gross_registered") || !claim.metric_ids.includes("closing_inventory"));
  }
  // The route returns rows whose metric_ids include the requested metric: anchor the
  // emulation below to the real route so this cannot drift from the Worker.
  const backend = readFileSync(new URL("../scout backend.js", import.meta.url), "utf8");
  assert.match(
    backend,
    /rows\.filter\(\s*\(row\) =>\s*Array\.isArray\(row\.metric_ids\) && row\.metric_ids\.includes\(metricId\),?\s*\)/,
    "drill-through filters stored rows by metric_ids membership",
  );
  const drill = (metricId) =>
    snapshot.claim_rows.filter((row) => Array.isArray(row.metric_ids) && row.metric_ids.includes(metricId));
  assert.deepEqual(drill("handler_performance"), [], "the legacy population is not drillable on a v3 report");
  assert.equal(drill("scorecard_gross_registered").length, snapshot.metrics.closing_inventory.value);
});

test("the legacy metric is not built anywhere in the engine source", () => {
  const source = readFileSync(new URL("./reporting-metrics.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /metrics\.handler_performance\s*=/);
  assert.doesNotMatch(source, /handlerMetricValue/);
  assert.doesNotMatch(source, /unassigned_unresolved/);
});

test("rendered v3 report is unchanged: cards, manager, administrator, former handler, no underwriters", () => {
  const snapshot = build();
  const run = runFor(snapshot);
  const html = renderClaimsReportHtml(run, { available: true });
  const text = plain(html);
  const cards = [...html.matchAll(/<article class="handler-card[^"]*"><header><h3>([^<]*)<\/h3>[\s\S]*?<\/article>/g)].map((m) => unescape(m[1]));
  assert.deepEqual(cards, ["Lucky", "Naledi", "Sarah", "Bev"]);
  assert.match(html, /<h2>Claims Performance/);
  assert.doesNotMatch(html, /<table class="management-table handler-table"/);
  assert.doesNotMatch(html, /<h2>Handler Performance/);
  assert.match(text, /Claims manager/);
  assert.match(text, /Nicole \(1\)/);
  assert.match(text, /Allocate correct handler/);
  assert.match(text, /ownership to be confirmed for Lesire \(1\)/);
  assert.match(text, /Confirm ownership/);
  assert.equal(UNDERWRITERS.test(text), false);

  const ui = plain(controller().renderScorecards(reportSnapshot(run)));
  for (const label of ["Lucky", "Naledi", "Sarah", "Bev", "Nicole", "Lesire"]) assert.ok(ui.includes(label), label);
  assert.equal(UNDERWRITERS.test(ui), false);
});

test("rendering is byte-identical whether or not a stored draft still carries the stale legacy metric", () => {
  const snapshot = build();
  const stale = withStaleLegacyMetric(snapshot);
  assert.equal(UNDERWRITERS.test(JSON.stringify(stale.metrics.handler_performance)), true, "fixture really carries the leak");
  assert.equal(
    renderClaimsReportHtml(runFor(stale), { available: true }),
    renderClaimsReportHtml(runFor(snapshot), { available: true }),
    "v3 PDF layout never reads handler_performance",
  );
  assert.equal(
    controller().renderScorecards(reportSnapshot(runFor(stale))),
    controller().renderScorecards(reportSnapshot(runFor(snapshot))),
    "v3 web layout never reads handler_performance",
  );
  assert.equal(
    controller().renderReportBody(runFor(stale), reportSnapshot(runFor(stale))),
    controller().renderReportBody(runFor(snapshot), reportSnapshot(runFor(snapshot))),
  );
});

test("a v3 report without scorecards falls back to 'not available', never to a handler table of zeros", () => {
  const snapshot = build({ withClosing: false });
  const ui = controller().renderHandlers(reportSnapshot(runFor(snapshot)));
  assert.match(ui, /Handler performance is not available for this report/);
  assert.equal(UNDERWRITERS.test(ui), false);
  const view = buildClaimsReportPdfViewModel(runFor(snapshot), { available: true });
  assert.deepEqual(view.handlerRows, []);
  assert.doesNotThrow(() => renderClaimsReportHtml(runFor(snapshot), { available: true }));
});

// --- historical v2 compatibility -------------------------------------------------

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function storedV2Snapshot() {
  const available = (value, extra = {}) => ({ value, availability: "available", precision: "snapshot_exact", ...extra });
  return deepFreeze({
    report_type: "weekly",
    period_start_local_date: "2026-10-05",
    period_end_local_date: "2026-10-10",
    timezone: "Africa/Johannesburg",
    coverage_status: "usable_with_warnings",
    coverage: { warnings: ["unresolved_handlers"] },
    metric_definition_version: "claims-reporting-metrics-v2",
    report_schema_version: "scout-report-v2",
    comparisons: {},
    metrics: {
      opening_inventory: available(386),
      closing_inventory: available(364),
      net_inventory_movement: available(-22),
      new_claims_registered: available(25),
      new_claims_first_observed: available(2),
      claims_closed: available(1),
      open_claims_60_plus: available(208),
      open_claims_91_plus: available(162),
      ageing_distribution: available({ "0-30": 90, "31-60": 66, "61-90": 46, "91+": 162, unknown: 0 }),
      sla_compliance: available(0.06),
      sla_breaches: available(340),
      sla_summary: available({ compliant: 24, breached: 340, unmapped: 0, unknown: 0, denominator: 364 }),
      operational_health: available({ assessor_overdue: 1, investigator_overdue: 1, broker_overdue: 1, high_value: 28, legal_recovery: 1, nfo_ombudsman: 0, fraud: 0, repudiation_expired: null }),
      handler_performance: available({
        handlers: [
          ["Carol", 0],
          ["Lucky", 0],
          ["Naledi Moletsane", 58],
        ].map(([name, open]) => ({
          handler_id: `id-${name}`,
          handler_email: `${name.split(" ")[0].toLowerCase()}@example.test`,
          handler_name: name,
          open_claims: open,
          claims_60_plus: 0,
          claims_91_plus: 0,
          sla_breaches: 0,
          no_movement_over_30: 0,
          ready_to_close: 0,
          reassignments_in: 0,
          reassignments_out: 0,
        })),
        manager_held_other: { count: 20 },
        unassigned_unresolved: { count: 155 },
        active_handler_count: 3,
      }),
      assignment_activity: available(0, { details: { reassignments_in: 0, reassignments_out: 0 } }),
      no_movement_over_14: available(0),
      no_movement_over_30: available(0),
      ready_to_close: available(3),
      financial_open_outstanding: available(1250000),
      financial_estimate_total: available(1800000),
      financial_paid_total: available(450000),
    },
  });
}

test("v2 historical compatibility: a stored v2 snapshot still renders its own handler table, unmodified", () => {
  const snapshot = storedV2Snapshot();
  const before = JSON.stringify(snapshot);
  const run = runFor(snapshot);

  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /<h2>Handler Performance<\/h2>/);
  assert.match(html, /<table class="management-table handler-table"/);
  for (const name of ["Carol", "Lucky", "Naledi Moletsane"]) assert.ok(html.includes(`>${name}</th>`), name);
  assert.match(plain(html), /Manager-held \/ other 20/);
  assert.match(plain(html), /Unassigned \/ unresolved 155/);
  assert.doesNotMatch(html, /<h2>Claims Performance/, "legacy layout, not the scorecard layout");
  assert.equal(renderClaimsReportHtml(run, { available: true }), html, "deterministic");

  const ui = controller().renderHandlers(reportSnapshot(run));
  assert.match(ui, /report-handler-table/);
  assert.ok(ui.includes("Carol") && ui.includes("Naledi Moletsane"));
  assert.match(plain(ui), /Unassigned \/ unresolved: 155/);
  assert.ok(!controller().hasScorecards(reportSnapshot(run)), "web page uses the legacy layout for v2");

  // The snapshot was deep-frozen: any write would have thrown. Nothing was rewritten.
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(Object.isFrozen(snapshot.metrics.handler_performance), true);
});

test("v2 historical compatibility: the stored view model still exposes the frozen handler rows", () => {
  const view = buildClaimsReportPdfViewModel(runFor(storedV2Snapshot()), { available: true });
  assert.equal(view.scorecards, null);
  assert.equal(view.handlerRows.length, 3);
  assert.equal(view.handlerHeldCount, 20);
  assert.equal(view.unresolvedCount, 155);
});
