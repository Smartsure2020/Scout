import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildHandlerScorecards,
  normaliseReportingRoster,
} from "./handler-scorecards.mjs";
import { buildReportSnapshot } from "./reporting-metrics.mjs";

const period = {
  startLocalDate: "2026-10-05",
  endLocalDateExclusive: "2026-10-10",
};

const roster = {
  version: "1",
  members: [
    { id: "lucky", label: "Lucky", role: "handler", match: ["Lucky Mokgomo"] },
    { id: "naledi", label: "Naledi", role: "handler", match: ["Naledi Moletsane"] },
    { id: "sarah", label: "Sarah", role: "handler", match: ["Sarah Dzumba"] },
    { id: "bev", label: "Bev", role: "claims_manager", match: ["Beverly De Beer"] },
    {
      id: "nicole",
      label: "Nicole",
      role: "claims_administrator",
      match: ["Nicole Mentor"],
    },
    { id: "lesire", label: "Lesire", role: "former_handler", match: ["Lesire Make"] },
  ],
};

let counter = 0;
function claim(handlerSource, overrides = {}) {
  counter += 1;
  return {
    id: `claim-${counter}`,
    handlerSource,
    handlerEmail: null,
    resolvedScoutUserId: null,
    open: true,
    terminal: false,
    registeredDate: "2026-06-01",
    calendarAge: 10,
    ...overrides,
  };
}

function cardByLabel(result, label) {
  return result.value.cards.find((card) => card.label === label);
}

test("cards give gross registered, new allocated and over-60 per handler from the roster", () => {
  const rows = [
    claim("Lucky Mokgomo", { calendarAge: 70 }),
    claim("Lucky Mokgomo", { calendarAge: 5, registeredDate: "2026-10-06" }),
    // Settled: not gross, not over 60 even though it is old.
    claim("Lucky Mokgomo", { calendarAge: 200, open: false, terminal: true }),
    claim("Naledi Moletsane", { calendarAge: 61 }),
    claim("Naledi Moletsane", { calendarAge: 60 }),
  ];
  const result = buildHandlerScorecards({ closingRows: rows, period, roster });
  const lucky = cardByLabel(result, "Lucky");
  assert.equal(lucky.gross_registered, 2);
  assert.equal(lucky.new_allocated, 1);
  assert.equal(lucky.over_60, 1);
  assert.equal(lucky.role, "handler");
  const naledi = cardByLabel(result, "Naledi");
  assert.equal(naledi.gross_registered, 2);
  assert.equal(naledi.over_60, 1, "exactly 60 days is NOT over 60; 61 is");
  assert.equal(naledi.oldest_open_age_days, 61);
});

test("a rostered handler with no claims still gets a card showing zero", () => {
  const result = buildHandlerScorecards({
    closingRows: [claim("Lucky Mokgomo")],
    period,
    roster,
  });
  const sarah = cardByLabel(result, "Sarah");
  assert.ok(sarah);
  assert.equal(sarah.gross_registered, 0);
  assert.equal(sarah.new_allocated, 0);
  assert.equal(sarah.over_60, 0);
  assert.equal(sarah.oldest_open_age_days, null);
});

test("new allocated is open claims registered inside the period, start inclusive and end exclusive", () => {
  const rows = [
    claim("Sarah Dzumba", { registeredDate: "2026-10-05" }),
    claim("Sarah Dzumba", { registeredDate: "2026-10-09" }),
    claim("Sarah Dzumba", { registeredDate: "2026-10-04" }),
    claim("Sarah Dzumba", { registeredDate: "2026-10-10" }),
    // Registered in the week but already settled: not part of the open book.
    claim("Sarah Dzumba", {
      registeredDate: "2026-10-07",
      open: false,
      terminal: true,
    }),
    claim("Sarah Dzumba", { registeredDate: null }),
  ];
  const sarah = cardByLabel(
    buildHandlerScorecards({ closingRows: rows, period, roster }),
    "Sarah",
  );
  assert.equal(sarah.new_allocated, 2);
  assert.equal(sarah.gross_registered, 5);
});

test("a claim that moved handler is attributed to the handler on the closing extract", () => {
  // Registered Monday under Lucky, reassigned to Sarah; the closing extract says Sarah.
  const rows = [claim("Sarah Dzumba", { registeredDate: "2026-10-05" })];
  const result = buildHandlerScorecards({ closingRows: rows, period, roster });
  assert.equal(cardByLabel(result, "Sarah").new_allocated, 1);
  assert.equal(cardByLabel(result, "Lucky").new_allocated, 0);
});

test("Cardinal Age is kept for reference only and a difference is not a warning", () => {
  const withAge = (cardinalAge, overrides = {}) =>
    claim("Lucky Mokgomo", {
      sourceEvidence: { cardinalAge },
      ...overrides,
    });
  const rows = [
    withAge(75, { calendarAge: 75 }),
    withAge(40, { calendarAge: 40 }),
    // Settled Date froze Cardinal's Age at 20 although the claim is 200 days old.
    withAge(20, { calendarAge: 200 }),
    claim("Lucky Mokgomo", { calendarAge: 90 }),
  ];
  const result = buildHandlerScorecards({ closingRows: rows, period, roster });
  const lucky = cardByLabel(result, "Lucky");
  assert.equal(lucky.over_60, 3, "headline uses the registration date, as decided");
  // Reference figures stay available for reconciliation and drill-through...
  assert.equal(lucky.over_60_by_cardinal_age, 1);
  assert.equal(lucky.cardinal_age_compared, 3);
  assert.equal(lucky.cardinal_age_disagreements, 1);
  // ...but a decided difference is information, never a warning or an alert.
  assert.deepEqual(lucky.flags, []);
  assert.equal(result.value.alerts.confirm, null);
  assert.ok(!result.warnings.includes("cardinal_age_disagrees_with_registration_age"));
  const { summary, ...check } = result.value.cardinal_age_check;
  assert.deepEqual(check, {
    compared: 3,
    unavailable: 1,
    disagreements: 1,
    over_60_by_cardinal_age: 1,
    status: "disagreements",
  });
  assert.match(summary, /Cardinal Age \(reference only\)/);
  assert.match(summary, /differs from the registration-date age on 1 of 3 open claims/);
});

test("snapshots that predate Cardinal Age preservation report the check as unavailable, not agreeing", () => {
  const result = buildHandlerScorecards({
    closingRows: [claim("Lucky Mokgomo", { calendarAge: 70 })],
    period,
    roster,
  });
  assert.equal(result.value.cardinal_age_check.status, "unavailable");
  assert.ok(!result.warnings.includes("cardinal_age_disagrees_with_registration_age"));
});

test("roster roles order cards and raise the allocation flags", () => {
  const rows = [
    claim("Lucky Mokgomo"),
    claim("Beverly De Beer"),
    claim("Nicole Mentor", { calendarAge: 2, registeredDate: "2026-10-08" }),
    claim("Lesire Make", { calendarAge: 400 }),
    claim("Mystery Person"),
    claim(null),
    claim("  "),
  ];
  const result = buildHandlerScorecards({ closingRows: rows, period, roster });
  assert.deepEqual(
    result.value.cards.map((card) => card.label),
    [
      "Lucky",
      "Naledi",
      "Sarah",
      "Bev",
      "Lesire",
      "Nicole",
      "Mystery Person",
      "Unassigned",
    ],
  );
  const nicole = cardByLabel(result, "Nicole");
  assert.equal(nicole.role, "claims_administrator");
  assert.equal(nicole.flags[0].code, "registration_account_holds_claims");
  assert.equal(nicole.flags[0].severity, "critical");
  assert.match(nicole.flags[0].message, /correct handler must be allocated/i);

  assert.equal(cardByLabel(result, "Bev").flags.length, 0);
  assert.equal(
    cardByLabel(result, "Lesire").flags[0].code,
    "former_handler_open_claims",
  );
  assert.equal(cardByLabel(result, "Lesire").flags[0].severity, "warning");
  assert.equal(
    cardByLabel(result, "Mystery Person").flags[0].code,
    "handler_not_recognised",
  );
  assert.equal(cardByLabel(result, "Unassigned").flags[0].code, "claims_unassigned");
  // Admin (1) + unrecognised (1) + unassigned (2 blank/whitespace rows).
  assert.equal(result.value.allocation_required.claim_count, 4);
  assert.ok(result.warnings.includes("claims_require_handler_allocation"));
  assert.ok(!result.warnings.includes("reporting_roster_not_configured"));
});

test("team totals tie to every open claim across all cards", () => {
  const rows = [
    claim("Lucky Mokgomo"),
    claim("Naledi Moletsane"),
    claim("Nicole Mentor"),
    claim("Mystery Person"),
    claim("Lucky Mokgomo", { open: false, terminal: true }),
  ];
  const result = buildHandlerScorecards({ closingRows: rows, period, roster });
  assert.equal(result.value.totals.gross_registered, 4);
  assert.equal(
    result.value.cards.reduce((sum, card) => sum + card.gross_registered, 0),
    4,
  );
});

test("without a roster, an unmatched full name is surfaced rather than pooled or hidden", () => {
  const users = [
    { id: "u1", email: "lucky@example.test", display_name: "Lucky", role: "handler", active: true },
    { id: "u2", email: "bev@example.test", display_name: "Beverly De Beer", role: "manager", active: true },
  ];
  const rows = [
    claim("Lucky Mokgomo"),
    claim("Beverly De Beer"),
    claim("Beverly De Beer", { resolvedScoutUserId: "u2" }),
  ];
  const result = buildHandlerScorecards({
    closingRows: rows,
    period,
    activeUsers: users,
  });
  const lucky = cardByLabel(result, "Lucky Mokgomo");
  assert.equal(lucky.role, "unrecognised");
  assert.equal(lucky.flags[0].severity, "critical");
  const bev = cardByLabel(result, "Beverly De Beer");
  assert.equal(bev.role, "management");
  assert.equal(bev.gross_registered, 2, "stored and re-resolved ids land on one card");
  assert.ok(result.warnings.includes("reporting_roster_not_configured"));
});

test("snapshots stored before a user existed are re-resolved from the preserved source text", () => {
  const users = [
    { id: "u1", email: "lucky@example.test", display_name: "Lucky Mokgomo", role: "handler", active: true },
  ];
  const result = buildHandlerScorecards({
    closingRows: [claim("Lucky Mokgomo", { resolvedScoutUserId: null })],
    period,
    activeUsers: users,
  });
  const lucky = cardByLabel(result, "Lucky Mokgomo");
  assert.equal(lucky.role, "handler");
  assert.equal(lucky.handler_email, "lucky@example.test");
  assert.equal(lucky.flags.length, 0);
});

test("invalid and ambiguous roster entries never silently attribute claims", () => {
  const parsed = normaliseReportingRoster({
    members: [
      { id: "a", label: "A", role: "handler", match: ["Sam One"] },
      { id: "a", label: "Dup", role: "handler", match: ["Sam Two"] },
      { id: "b", label: "B", role: "boss", match: ["Boss"] },
      { id: "c", label: "C", role: "handler", match: [] },
    ],
  });
  assert.equal(parsed.members.length, 1);
  assert.deepEqual(parsed.errors.sort(), [
    "duplicate_roster_member:a",
    "invalid_roster_member:b",
    "invalid_roster_member:c",
  ]);

  const ambiguous = buildHandlerScorecards({
    closingRows: [claim("Sam Shared")],
    period,
    roster: {
      members: [
        { id: "x", label: "X", role: "handler", match: ["Sam Shared"] },
        { id: "y", label: "Y", role: "handler", match: ["shared sam"] },
      ],
    },
  });
  const card = cardByLabel(ambiguous, "Sam Shared");
  assert.equal(card.role, "unrecognised");
  assert.equal(card.flags[0].code, "ambiguous_roster_match");
  assert.ok(ambiguous.warnings.includes("reporting_roster_invalid_members") === false);
});

test("claims with no known age are counted but never guessed into over-60", () => {
  const result = buildHandlerScorecards({
    closingRows: [
      claim("Lucky Mokgomo", { calendarAge: null }),
      claim("Lucky Mokgomo", { calendarAge: 90 }),
    ],
    period,
    roster,
  });
  const lucky = cardByLabel(result, "Lucky");
  assert.equal(lucky.gross_registered, 2);
  assert.equal(lucky.over_60, 1);
  assert.equal(result.value.claims_without_age, 1);
  assert.ok(result.warnings.includes("handler_scorecard_age_unavailable"));
});

test("previous-period values give per-card and team movement", () => {
  const previousValue = {
    cards: [
      { key: "roster:lucky", gross_registered: 10, new_allocated: 1, over_60: 4 },
    ],
    totals: { gross_registered: 30, new_allocated: 3, over_60: 9 },
  };
  const result = buildHandlerScorecards({
    closingRows: [claim("Lucky Mokgomo", { calendarAge: 80 })],
    period,
    roster,
    previousValue,
  });
  assert.deepEqual(cardByLabel(result, "Lucky").previous, {
    gross_registered: 10,
    new_allocated: 1,
    over_60: 4,
  });
  assert.equal(cardByLabel(result, "Naledi").previous, null);
  assert.equal(result.value.totals.previous.over_60, 9);
});

// --- End to end through the report engine -----------------------------------

function manifest(id, effectiveDate, count) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: `${id}-checksum`,
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

function snapshotRow(claimId, extractId, handlerSource, overrides = {}) {
  return {
    extract_id: extractId,
    claim_id: claimId,
    identity_key: `cardinal_claims:${claimId}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${claimId}`,
    source_claim_number: claimId,
    handler_source: handlerSource,
    handler_email: null,
    resolved_scout_user_id: null,
    handler_resolution: "unrecognised",
    status_raw: "Registered",
    status_normalized: "registered",
    terminal: false,
    open: true,
    registered_date: "2026-08-01",
    dol_date: "2026-07-20",
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
    insured: `Insured ${claimId}`,
    description: "Fixture claim",
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

test("the report engine publishes handler_scorecards that tie to closing inventory", () => {
  const opening = manifest("extract-open", "2026-08-21", 2);
  const closing = manifest("extract-close", "2026-08-28", 4);
  const snapshotsByExtract = new Map([
    [
      opening.id,
      [
        snapshotRow("A", opening.id, "Lucky Mokgomo"),
        snapshotRow("B", opening.id, "Naledi Moletsane"),
      ],
    ],
    [
      closing.id,
      [
        snapshotRow("A", closing.id, "Lucky Mokgomo", { calendar_age: 70 }),
        snapshotRow("B", closing.id, "Naledi Moletsane"),
        snapshotRow("C", closing.id, "Lucky Mokgomo", {
          registered_date: "2026-08-26",
          calendar_age: 2,
        }),
        snapshotRow("D", closing.id, "Nicole Mentor", {
          registered_date: "2026-08-27",
          calendar_age: 1,
        }),
      ],
    ],
  ]);
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract,
    activeUsers: [],
    handlerRoster: roster,
  });
  assert.equal(report.metric_definition_version, "claims-reporting-metrics-v3");
  const scorecards = report.metrics.handler_scorecards;
  assert.equal(scorecards.availability, "available");
  assert.equal(
    scorecards.value.totals.gross_registered,
    report.metrics.closing_inventory.value,
  );
  const byLabel = Object.fromEntries(
    scorecards.value.cards.map((card) => [card.label, card]),
  );
  assert.equal(byLabel.Lucky.gross_registered, 2);
  assert.equal(byLabel.Lucky.new_allocated, 1);
  assert.equal(byLabel.Lucky.over_60, 1);
  assert.equal(byLabel.Nicole.flags[0].code, "registration_account_holds_claims");
  assert.ok(scorecards.coverage_warnings.includes("claims_require_handler_allocation"));
  // Over 60 means more than 60 days, so it ties to the 61-90 and 91+ ageing bands.
  const bands = report.metrics.ageing_distribution.value;
  assert.equal(
    scorecards.value.totals.over_60,
    bands["61-90"] + bands["91+"],
  );
});

test("handler_scorecards is unavailable, not zero, when there is no closing snapshot", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [],
    snapshotsByExtract: new Map(),
    activeUsers: [],
    handlerRoster: roster,
  });
  assert.equal(report.metrics.handler_scorecards.availability, "unavailable");
});

// --- The roster SQL is data the report depends on, so it is tested ------------

function rosterFromSql() {
  const sql = readFileSync(
    new URL("../scout-reporting-roster.sql", import.meta.url),
    "utf8",
  );
  const match = /\$json\$([\s\S]*?)\$json\$/.exec(sql);
  assert.ok(match, "roster JSON block present");
  return JSON.parse(match[1]);
}

test("scout-reporting-roster.sql is a valid roster", () => {
  const parsed = normaliseReportingRoster(rosterFromSql());
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.configured, true);
  assert.deepEqual(
    parsed.members.filter((m) => m.role === "handler").map((m) => m.label),
    ["Lucky", "Naledi", "Sarah"],
  );
});

test("every exact Cardinal handler string maps to its intended role, with no first-name aliases", () => {
  const sqlRoster = rosterFromSql();
  const expected = {
    "Lucky Mokgomo": ["Lucky", "handler"],
    "Naledi Moletsane": ["Naledi", "handler"],
    "Sarah Dzumba": ["Sarah", "handler"],
    "Beverly De Beer": ["Bev", "claims_manager"],
    "De Beer Bev": ["Bev", "claims_manager"],
    "Nicole Mentor": ["Nicole", "claims_administrator"],
    "Lesire Make": ["Lesire", "former_handler"],
    "Juan-Paul Van der Merwe": ["Juan-Paul", "former_handler"],
    "Rakgalakane Karabo": ["Karabo", "former_handler"],
    // Cardinal is allowed to send the surname first.
    "Karabo Rakgalakane": ["Karabo", "former_handler"],
    "Busi Nyangintsimbi": ["Busi", "former_handler"],
    "Johnson Kuhamba": ["Johnson", "former_handler"],
  };
  for (const [cardinal, [label, role]] of Object.entries(expected)) {
    const result = buildHandlerScorecards({
      closingRows: [claim(cardinal)],
      period,
      roster: sqlRoster,
    });
    const card = result.value.cards.find((c) => c.gross_registered === 1);
    assert.equal(card.label, label, cardinal);
    assert.equal(card.role, role, cardinal);
  }
  // First names alone, Lorraine Greyling (approved: stays unknown) and ABSA must NOT match.
  for (const stranger of ["Lucky", "Bev", "Karabo", "Busi", "Johnson", "Lorraine Greyling", "ABSA "]) {
    const result = buildHandlerScorecards({
      closingRows: [claim(stranger)],
      period,
      roster: sqlRoster,
    });
    const card = result.value.cards.find((c) => c.gross_registered === 1);
    assert.equal(card.role, "unrecognised", stranger);
    assert.equal(card.flags[0].severity, "critical", stranger);
  }
});

test("both of Bev's Cardinal spellings land on one manager card with no warning", () => {
  const result = buildHandlerScorecards({
    closingRows: [claim("Beverly De Beer"), claim("De Beer Bev")],
    period,
    roster: rosterFromSql(),
  });
  const bev = result.value.cards.find((c) => c.label === "Bev");
  assert.equal(bev.gross_registered, 2);
  assert.deepEqual(bev.flags, []);
});

test("scorecard figures are published as drillable team metrics tagged per handler card", () => {
  const opening = manifest("e-open", "2026-08-21", 1);
  const closing = manifest("e-close", "2026-08-28", 3);
  const previousClosing = manifest("e-prev", "2026-08-14", 1);
  const snapshotsByExtract = new Map([
    [previousClosing.id, [snapshotRow("A", previousClosing.id, "Lucky Mokgomo")]],
    [opening.id, [snapshotRow("A", opening.id, "Lucky Mokgomo")]],
    [
      closing.id,
      [
        snapshotRow("A", closing.id, "Lucky Mokgomo", { calendar_age: 70 }),
        snapshotRow("C", closing.id, "Lucky Mokgomo", {
          registered_date: "2026-08-26",
          calendar_age: 2,
        }),
        snapshotRow("D", closing.id, "Naledi Moletsane", { calendar_age: 120 }),
      ],
    ],
  ]);
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [previousClosing, opening, closing],
    snapshotsByExtract,
    activeUsers: [],
    handlerRoster: roster,
  });
  const m = report.metrics;
  assert.equal(m.scorecard_gross_registered.value, 3);
  assert.equal(m.scorecard_new_allocated.value, 1);
  assert.equal(m.scorecard_over_60.value, 2);
  assert.deepEqual(m.scorecard_over_60.details.claim_ids_by_band["roster:lucky"], ["A"]);
  assert.deepEqual(m.scorecard_over_60.details.claim_ids_by_band["roster:naledi"], ["D"]);
  assert.deepEqual(m.scorecard_new_allocated.details.claim_ids_by_band["roster:lucky"], ["C"]);
  // Each claim is tagged with its card for the drill-through filter.
  const rowA = report.claim_rows.find((row) => row.source_claim_number === "A");
  assert.equal(rowA.membership_reasons.scorecard_over_60, "roster:lucky");
  assert.equal(rowA.membership_reasons.scorecard_gross_registered, "roster:lucky");
  // Numeric team metrics get previous-period comparison automatically.
  assert.ok("scorecard_gross_registered" in report.comparisons);
});
