import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReportSnapshot } from "./reporting-metrics.mjs";
import { renderClaimsReportHtml } from "./claims-report-pdf.mjs";
import {
  ReportsController,
  reportSnapshot,
} from "../scout-smartsure/claims/reporting-ui.mjs";

// The Reports page and the PDF must tell management the same story. Both print
// the engine's handler_scorecards metric; these tests lock that in with a real
// engine-built report rather than hand-made fixtures.

const roster = JSON.parse(
  /\$json\$([\s\S]*?)\$json\$/.exec(
    readFileSync(new URL("../scout-reporting-roster.sql", import.meta.url), "utf8"),
  )[1],
);

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
  const id = `P-${n}`;
  return {
    extract_id: extractId,
    claim_id: id,
    identity_key: `cardinal_claims:${id}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${id}`,
    source_claim_number: id,
    handler_source: handler,
    handler_email: null,
    resolved_scout_user_id: null,
    handler_resolution: "unrecognised",
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
    source_evidence: { age: overrides.calendar_age ?? 40 },
    ...overrides,
  };
}

function engineReport() {
  n = 0;
  const closing = manifest("e-close", "2026-08-28", 12);
  const opening = manifest("e-open", "2026-08-21", 6);
  const closingRows = [
    row(closing.id, "Lucky Mokgomo", { calendar_age: 75 }),
    row(closing.id, "Lucky Mokgomo", { calendar_age: 61 }),
    row(closing.id, "Lucky Mokgomo", { calendar_age: 60 }),
    row(closing.id, "Lucky Mokgomo", { registered_date: "2026-08-26", calendar_age: 2 }),
    row(closing.id, "Naledi Moletsane", { calendar_age: 130 }),
    row(closing.id, "Sarah Dzumba", { calendar_age: 10 }),
    row(closing.id, "Beverly De Beer"),
    row(closing.id, "De Beer Bev"),
    row(closing.id, "Nicole Mentor", { registered_date: "2026-08-27", calendar_age: 1 }),
    row(closing.id, "Lesire Make", { calendar_age: 200 }),
    // Cardinal froze this claim's Age at a Settled Date: QA disagreement.
    row(closing.id, "Naledi Moletsane", { calendar_age: 150, source_evidence: { age: 20 } }),
    row(closing.id, "Stranger Name"),
  ];
  const openingRows = [row(opening.id, "Lucky Mokgomo"), row(opening.id, "Sarah Dzumba")];
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      [opening.id, openingRows],
      [closing.id, closingRows],
    ]),
    activeUsers: [],
    handlerRoster: roster,
  });
}

function runFor(snapshot, status = "finalised") {
  return {
    id: "parity-run",
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

// [label, gross, new, over60] for every full handler card, from each renderer.
function pdfCards(html) {
  return [...html.matchAll(/<article class="handler-card[^"]*"><header><h3>([^<]*)<\/h3>[\s\S]*?<\/article>/g)].map(
    (m) => [
      unescape(m[1]),
      ...["Total Gross Registered", "New Allocated Claims", "Over 60 Days"].map((label) =>
        Number(new RegExp(`${label}</span><span class="hc-value">(\\d+)`).exec(m[0])[1]),
      ),
    ],
  );
}
function uiCards(html) {
  return [...html.matchAll(/<article class="scorecard-card[^"]*"><header><h3>([^<]*)<\/h3>[\s\S]*?<\/article>/g)].map(
    (m) => [
      unescape(m[1]),
      ...["Total Gross Registered", "New Allocated Claims", "Over 60 Days"].map((label) =>
        Number(new RegExp(`${label}</span><button[^>]*><strong>(\\d+)`).exec(m[0])[1]),
      ),
    ],
  );
}

test("web page and PDF print identical handler cards, totals, alerts and holders", () => {
  const snapshot = engineReport();
  const run = runFor(snapshot);
  const value = snapshot.metrics.handler_scorecards.value;
  const ui = controller().renderScorecards(reportSnapshot(run));
  const pdf = renderClaimsReportHtml(run, { available: true });

  const primary = value.cards.filter((card) => ["handler", "claims_manager", "management"].includes(card.role));
  const expected = primary.map((card) => [card.label, card.gross_registered, card.new_allocated, card.over_60]);
  assert.deepEqual(uiCards(ui), expected);
  assert.deepEqual(pdfCards(pdf), expected);

  // The engine's own numbers, so neither renderer can be quietly wrong together.
  assert.deepEqual(expected.find(([label]) => label === "Lucky"), ["Lucky", 4, 1, 2]);
  assert.deepEqual(expected.find(([label]) => label === "Bev"), ["Bev", 2, 0, 0]);

  for (const html of [plain(ui), plain(pdf)]) {
    for (const figure of [value.totals.gross_registered, value.totals.new_allocated, value.totals.over_60])
      assert.ok(html.includes(` ${figure} `), `team figure ${figure}`);
    assert.ok(html.includes(value.alerts.critical.title));
    assert.ok(html.includes(value.alerts.critical.text));
    assert.ok(html.includes(value.alerts.confirm.title));
    assert.ok(html.includes(value.alerts.confirm.text));
    for (const holder of value.cards.filter((card) => !["handler", "claims_manager", "management"].includes(card.role)))
      assert.ok(html.includes(holder.label) && html.includes(holder.action_label), holder.label);
    assert.ok(html.includes("Open claims only"));
  }
});

test("alerts name Nicole and the stranger as red and Lesire as amber, in both places", () => {
  const value = engineReport().metrics.handler_scorecards.value;
  assert.match(value.alerts.critical.text, /Nicole \(1\)/);
  assert.match(value.alerts.critical.text, /Stranger Name \(1\)/);
  assert.match(value.alerts.confirm.text, /ownership to be confirmed for Lesire \(1\)/);
  // Cardinal's frozen Age is reference only: it must not raise a warning.
  assert.doesNotMatch(value.alerts.confirm.text, /Cardinal Age/);
  const byLabel = Object.fromEntries(value.cards.map((card) => [card.label, card]));
  assert.equal(byLabel.Nicole.action, "allocate");
  assert.equal(byLabel["Stranger Name"].action, "allocate");
  assert.equal(byLabel.Lesire.action, "confirm");
  assert.equal(byLabel.Bev.action, "none");
});

test("Reports page leads with Claims Performance, then queries, then supporting intelligence", () => {
  const run = runFor(engineReport());
  const html = controller().renderReportBody(run, reportSnapshot(run));
  const at = (title) => html.indexOf(`<div class="section-title">${title}`);
  const order = [
    "Claims Performance",
    "Claims Queries &amp; Management Attention",
    "Recommendations &amp; Action Plan",
  ].map(at);
  order.push(html.indexOf("<h2>Supporting Intelligence</h2>"), at("SLA: Claim Age vs Status Threshold"));
  assert.ok(order.every((index) => index >= 0), "every section renders");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /Handler Performance/);
  assert.doesNotMatch(html, />Executive Summary</);
  assert.match(html, /not a measure of handler performance/);
});

test("report details carry the same definitions and Cardinal Age QA wording as the PDF methodology", () => {
  const run = runFor(engineReport());
  const value = run.metrics_snapshot.metrics.handler_scorecards.value;
  const details = controller().renderReportDetails(run, reportSnapshot(run));
  const pdf = renderClaimsReportHtml(run, { available: true });
  for (const text of [
    value.definitions.gross_registered,
    value.definitions.new_allocated,
    value.definitions.over_60,
    value.cardinal_age_check.summary,
  ]) {
    assert.ok(plain(details).includes(text), `UI: ${text.slice(0, 40)}`);
    assert.ok(plain(pdf).includes(text), `PDF: ${text.slice(0, 40)}`);
  }
});

test("clicking a card figure drills to exactly that handler's claims", async () => {
  const snapshot = engineReport();
  const ui = controller();
  ui.state.selected = runFor(snapshot);
  // Mirrors the endpoint, which returns only the rows belonging to the metric.
  ui.api = {
    metricClaims: async (_id, metricId) => ({
      claims: snapshot.claim_rows.filter((row) => row.metric_ids.includes(metricId)),
    }),
  };
  const lucky = snapshot.metrics.handler_scorecards.value.cards.find((card) => card.label === "Lucky");

  await ui.drill("scorecard_over_60", "card:roster:lucky");
  assert.equal(ui.state.drill.claims.length, lucky.over_60);
  assert.ok(ui.state.drill.claims.every((row) => row.handler_snapshot === "Lucky Mokgomo"));
  assert.equal(ui.drillLabel("scorecard_over_60", "card:roster:lucky"), "Over 60 Days · Lucky");

  await ui.drill("scorecard_gross_registered", "card:roster:lucky");
  assert.equal(ui.state.drill.claims.length, lucky.gross_registered);
  await ui.drill("scorecard_new_allocated", "card:roster:lucky");
  assert.equal(ui.state.drill.claims.length, lucky.new_allocated);
  // The team total (no card filter) is the whole population for that figure.
  await ui.drill("scorecard_over_60");
  assert.equal(ui.state.drill.claims.length, snapshot.metrics.scorecard_over_60.value);
  // Cardinal Age disagreements are drillable for reconciliation.
  await ui.drill("scorecard_cardinal_age_differs", "card:roster:naledi");
  assert.equal(ui.state.drill.claims.length, 1);
});

test("reports finalised before scorecards existed still render the legacy layout on the web page", () => {
  const snapshot = engineReport();
  delete snapshot.metrics.handler_scorecards;
  const run = runFor(snapshot);
  const html = controller().renderReportBody(run, reportSnapshot(run));
  assert.match(html, /Executive Summary/);
  assert.match(html, /Handler Performance/);
  assert.doesNotMatch(html, /Supporting Intelligence/);
  assert.doesNotMatch(renderClaimsReportHtml(run, { available: true }), /<h2>Claims Performance/);
});

test("scorecard text from handler names is escaped on the web page", () => {
  const snapshot = engineReport();
  snapshot.metrics.handler_scorecards.value.cards[0].label = "<img src=x onerror=alert(1)>";
  const html = controller().renderScorecards(reportSnapshot(runFor(snapshot)));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("the Reports page and the PDF label the renamed operational metrics the same way", () => {
  const run = runFor(engineReport());
  const snapshot = reportSnapshot(run);
  const ui = controller().renderOperational(snapshot, true);
  const pdf = renderClaimsReportHtml(run, { available: true });
  assert.match(ui, /High value \(outstanding\)/);
  assert.match(ui, /Payment Status \/ Estimate Zero/);
  assert.doesNotMatch(ui, /High value \/ mandate attention/);
  assert.match(plain(pdf), /High value \(outstanding\)/);
  assert.match(plain(pdf), /Payment status with zero estimate/);
  // An older report carries the combined key and keeps its original label on the page.
  const legacy = structuredClone(snapshot);
  legacy.metrics.operational_health.value = {
    ...legacy.metrics.operational_health.value,
    high_value_mandate_attention: 3,
  };
  delete legacy.metrics.operational_health.value.high_value;
  const legacyHtml = controller().renderOperational(legacy, false);
  assert.match(legacyHtml, /High value \/ mandate attention/);
  assert.doesNotMatch(legacyHtml, /High value \(outstanding\)/);
  assert.match(legacyHtml, /Payment Requested \/ Estimate Zero/);
});
