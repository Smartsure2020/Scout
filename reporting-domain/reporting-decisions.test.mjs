import test from "node:test";
import assert from "node:assert/strict";
import { buildReportSnapshot } from "./reporting-metrics.mjs";
import { normalizeHistoricalRows } from "./history.mjs";
import {
  isReportingTerminalStatus,
  isTerminalStatus,
} from "./claims-rules.mjs";
import {
  mapCardinalRow,
  parseNullableDate,
  parseNullableNumber,
} from "../scout-smartsure/claims/cardinal-ingestion.mjs";
import { currentStateRowToClaim } from "../scout-smartsure/claims/current-state-adapter.mjs";
import { buildCurrentStateClaimRecord } from "../scout backend.js";

// Management decisions of 2026-10-05, pinned one by one.

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

function row(extractId, claimId, status, overrides = {}) {
  const terminal = overrides.terminal ?? false;
  return {
    extract_id: extractId,
    claim_id: claimId,
    identity_key: `cardinal_claims:${claimId}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${claimId}`,
    source_claim_number: claimId,
    handler_source: "Lucky Mokgomo",
    handler_email: null,
    resolved_scout_user_id: null,
    handler_resolution: "unrecognised",
    status_raw: status,
    status_normalized: status.toLowerCase(),
    terminal,
    open: !terminal,
    registered_date: "2026-07-01",
    dol_date: "2026-06-20",
    movement_date: "2026-08-20",
    repudiation_date: null,
    source_event_at: null,
    outstanding: 100,
    estimate: 200,
    paid: 0,
    mandate: 0,
    insurer: "Insurer",
    peril: "Fire",
    peril_type: "Property",
    insured: `Insured ${claimId}`,
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

function week(openingRows, closingRows) {
  const opening = manifest("e-open", "2026-08-21", openingRows.length);
  const closing = manifest("e-close", "2026-08-28", closingRows.length);
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      [opening.id, openingRows.map((r) => ({ ...r, extract_id: opening.id }))],
      [closing.id, closingRows.map((r) => ({ ...r, extract_id: closing.id }))],
    ]),
    activeUsers: [],
  });
}

// ---- 5 and 6: Repudiated is terminal for reporting; Payment Released stays open ---------------------

test("Repudiated is terminal for reporting only; Payment Released and repudiation workflow statuses stay open", () => {
  assert.equal(isReportingTerminalStatus("Repudiated"), true);
  assert.equal(isReportingTerminalStatus("repudiated"), true);
  assert.equal(isReportingTerminalStatus("Rejected"), true);
  assert.equal(isReportingTerminalStatus("Payment Released"), false);
  assert.equal(isReportingTerminalStatus("Repudiated - Awaiting Closure"), false);
  assert.equal(isReportingTerminalStatus("Awaiting Repudiation Letter"), false);
  // The claims page / briefing worklist rules are deliberately unchanged.
  assert.equal(isTerminalStatus("Repudiated"), false);
});

test("Repudiated claims leave the open book and Total Gross Registered, even from history stored as open", () => {
  const report = week(
    [row("", "A", "Registered"), row("", "R", "Repudiated")],
    [
      row("", "A", "Registered"),
      row("", "R", "Repudiated"), // stored open: history is immutable
      row("", "Q", "Repudiated - Awaiting Closure"),
      row("", "P", "Payment Released"),
    ],
  );
  assert.equal(report.metrics.opening_inventory.value, 1);
  assert.equal(report.metrics.closing_inventory.value, 3);
  assert.equal(report.metrics.handler_scorecards.value.totals.gross_registered, 3);
  assert.equal(report.status_classification_version, "reporting-status-classification-v1");
});

test("changing the classification does not fake a wave of closures", () => {
  // R is Repudiated in BOTH extracts. Under the old rule it was open in both.
  const report = week(
    [row("", "R", "Repudiated"), row("", "A", "Registered")],
    [row("", "R", "Repudiated"), row("", "A", "Registered")],
  );
  assert.equal(report.metrics.claims_closed.value, 0);
});

test("a claim that becomes Repudiated during the period is a terminal closure", () => {
  const report = week(
    [row("", "T", "Registered"), row("", "A", "Registered")],
    [row("", "T", "Repudiated"), row("", "A", "Registered")],
  );
  assert.equal(report.metrics.claims_closed.value, 1);
  assert.deepEqual(report.metrics.claims_closed.claim_population.claim_ids, ["T"]);
  assert.equal(report.metrics.closing_inventory.value, 1);
});

// ---- 3 and 4: disappearance is not closure, and is reported separately ---------------------------------

test("claims that leave the extract are reported separately and are never closures", () => {
  const report = week(
    [
      row("", "A", "Registered"),
      row("", "X", "Authorised"), // open, then disappears
      row("", "Y", "Rejected", { terminal: true }), // already terminal, then disappears
    ],
    [row("", "A", "Registered")],
  );
  assert.equal(report.metrics.claims_left_extract.value, 1, "only the open claim left while open");
  assert.deepEqual(report.metrics.claims_left_extract.claim_population.claim_ids, ["X"]);
  assert.equal(report.metrics.claims_closed.value, 0, "disappearance is NOT closure");
  assert.match(report.metrics.claims_left_extract.details.note, /not closure/i);
});

test("terminal closures and left-the-extract are independent counts", () => {
  const report = week(
    [row("", "A", "Registered"), row("", "X", "Authorised"), row("", "T", "Authorised")],
    [row("", "A", "Registered"), row("", "T", "Rejected", { terminal: true })],
  );
  assert.equal(report.metrics.claims_closed.value, 1);
  assert.equal(report.metrics.claims_left_extract.value, 1);
});

test("left-the-extract is unavailable, not zero, without a baseline extract", () => {
  const closing = manifest("e-close", "2026-08-28", 1);
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [closing],
    snapshotsByExtract: new Map([[closing.id, [row(closing.id, "A", "Registered")]]]),
    activeUsers: [],
  });
  assert.equal(report.metrics.claims_left_extract.availability, "unavailable");
});

// ---- 16: no movement is unavailable without movement evidence -------------------------------------------

test("no-movement is unavailable, not 0, when no claim has a movement date", () => {
  const noEvidence = week(
    [row("", "A", "Registered", { movement_date: null })],
    [row("", "A", "Registered", { movement_date: null }), row("", "B", "Authorised", { movement_date: null })],
  );
  for (const id of ["no_movement_over_14", "no_movement_over_30"]) {
    assert.equal(noEvidence.metrics[id].availability, "unavailable", id);
    assert.equal(noEvidence.metrics[id].value, null, id);
    assert.ok(noEvidence.metrics[id].coverage_warnings.includes("movement_date_unavailable"));
  }
  const withEvidence = week(
    [row("", "A", "Registered")],
    [row("", "A", "Registered", { movement_date: "2026-07-01" }), row("", "B", "Authorised")],
  );
  assert.equal(withEvidence.metrics.no_movement_over_14.availability, "available");
  assert.equal(withEvidence.metrics.no_movement_over_14.value, 1);
});

// ---- 17: repudiation expiry is unavailable without a repudiation date -------------------------------------

test("repudiation expiry is unavailable without a repudiation date, and never uses registration age", () => {
  const old = { calendar_age: 900, registered_date: "2024-01-01" };
  const report = week(
    [row("", "A", "Registered")],
    [row("", "A", "Registered"), row("", "R", "Repudiated", old)],
  );
  const health = report.metrics.operational_health;
  assert.equal(health.value.repudiation_expired, null);
  assert.deepEqual(health.details.unavailable_reasons, { repudiation_expired: "repudiation_date_unavailable" });
});

test("repudiation expiry is computed from the repudiation date when the source supplies it", () => {
  const report = week(
    [row("", "A", "Registered")],
    [
      row("", "A", "Registered"),
      row("", "R1", "Repudiated", { repudiation_date: "2025-10-01" }), // 331 days
      row("", "R2", "Repudiated", { repudiation_date: "2026-06-01" }), // 88 days
    ],
  );
  assert.equal(report.metrics.operational_health.value.repudiation_expired, 1);
  assert.deepEqual(
    report.metrics.operational_health.details.claim_ids_by_category.repudiation_expired,
    ["R1"],
  );
});

test("with no repudiated claims at all, repudiation expired is a real zero", () => {
  const report = week([row("", "A", "Registered")], [row("", "A", "Registered")]);
  assert.equal(report.metrics.operational_health.value.repudiation_expired, 0);
});

// ---- 13: multi-row financials are not summed, but do not block the rest ------------------------------------

test("only unambiguous claims are summed and the exclusion is disclosed", () => {
  const rows = [
    row("", "A", "Authorised", { outstanding: 1000, estimate: 2000, paid: 10 }),
    row("", "B", "Authorised", { outstanding: 500, estimate: 700, paid: 5 }),
    // Multi-row claim whose sections disagree.
    row("", "M", "Authorised", { source_row_identity: "m1", claim_id: "M1", source_claim_number: "M", identity_key: "cardinal_claims:M", outstanding: 111, estimate: 300, paid: 1 }),
    row("", "M", "Authorised", { source_row_identity: "m2", claim_id: "M2", source_claim_number: "M", identity_key: "cardinal_claims:M", outstanding: 222, estimate: 300, paid: 2 }),
  ];
  const report = week([row("", "A", "Authorised")], rows);
  const outstanding = report.metrics.financial_open_outstanding;
  assert.equal(outstanding.availability, "available");
  assert.equal(outstanding.value, 1500, "A + B only: M's section amounts are not summed");
  assert.deepEqual(outstanding.details.excluded_multi_row_claim_numbers, ["M"]);
  // Estimate repeats identically across M's sections, so it IS unambiguous and counted once.
  assert.equal(report.metrics.financial_estimate_total.value, 2000 + 700 + 300);
  assert.equal(report.metrics.financial_estimate_total.details.excluded_multi_row_claim_count, 0);
  assert.equal(report.metrics.financial_paid_total.value, 15);
});

// ---- 14: scientific notation must parse --------------------------------------------------------------------

test("Cardinal floating-point residue written in scientific notation parses as zero", () => {
  for (const text of ["1.16415321826935E-10", "-7.27595761418343E-12", "3.63797880709171E-12", "2.9831426218152E-10", "-1.00044417195022E-11"]) {
    const parsed = parseNullableNumber(text);
    assert.equal(parsed.state, "known", text);
    assert.ok(Object.is(parsed.value, 0), `${text} is exactly +0`);
  }
  assert.deepEqual(parseNullableNumber("1.5E3"), { value: 1500, state: "known" });
  assert.deepEqual(parseNullableNumber("198905.57"), { value: 198905.57, state: "known" });
  assert.deepEqual(parseNullableNumber("R 1,234.50"), { value: 1234.5, state: "known" });
  assert.ok(Object.is(parseNullableNumber(1e-11).value, 0), "numeric residue too");
  assert.equal(parseNullableNumber("Mandate").state, "malformed", "real garbage still fails");
  assert.equal(parseNullableNumber("12E").state, "malformed");
});

test("a real Outstanding stored as scientific-notation text is no longer lost", () => {
  const claim = mapCardinalRow({
    "Claim No.": "TOT0046-00006728",
    "Claims Status": "Attorney negotiating settlement",
    "Claim Handler": "Beverly De Beer",
    Age: 476,
    Insurer: "Infiniti",
    Outstanding: "1.16415321826935E-10",
    Paid: "476206.14",
  });
  assert.equal(claim.outstanding, 0);
  assert.equal(claim.paid, 476206.14);
  assert.ok(!claim.ingestionQualityFlags.includes("source_parse_failure:outstanding"));
});

// ---- 15: Excel's empty date means no date ------------------------------------------------------------------

test("Excel's empty date (1899-12-31 / 1900-01-01) is no date, in every shape it arrives", () => {
  for (const value of [new Date(1899, 11, 31, 0, 0, 0), new Date(1900, 0, 1), "1899-12-31", "1900-01-01", "31/12/1899", "1899-12-31T00:00:00"]) {
    assert.deepEqual(parseNullableDate(value), { value: null, state: "missing" }, String(value));
  }
  assert.deepEqual(parseNullableDate("2026-09-17"), { value: "2026-09-17", state: "known" });
  assert.deepEqual(parseNullableDate(new Date(2026, 8, 17, 23, 54, 21)), { value: "2026-09-17", state: "known" });
  const claim = mapCardinalRow({ "Claim No.": "X", "Claims Status": "Registered", "Claim Handler": "A", Age: 1, Insurer: "I", "Settled Date": new Date(1899, 11, 31) });
  assert.equal(claim.settledDate, null);
});

test("the backend and the read side also treat the Excel empty date as none", () => {
  const record = buildCurrentStateClaimRecord({ claimNo: "X", status: "registered", handler: "A", settledDate: "1899-12-31", registeredDate: "2026-09-01" }, "2026-10-02", []).record;
  assert.equal(record.settled_date, null);
  assert.equal(record.registered_date, "2026-09-01");
  // Rows already stored before this fix are read as none, without touching the data.
  assert.equal(currentStateRowToClaim({ claim_no: "X", settled_date: "1899-12-31" }).settledDate, null);
  const normalized = normalizeHistoricalRows(
    [{ claimNo: "X", status: "Registered", handler: "A", registeredDate: "1899-12-31", outstanding: "1.2E-10" }],
    { effectiveDate: "2026-10-02" },
  ).snapshots[0];
  assert.equal(normalized.registered_date, null);
  assert.equal(normalized.outstanding, 0);
});

// ======================= final source-truth cleanup (2026-10-05) =======================

import { readFileSync } from "node:fs";
import {
  getStatusEvaluation,
  isPaymentZeroEstimate,
  TERMINAL_STATUSES,
  normalizeStatus,
} from "./claims-rules.mjs";
import { isMandateLabel } from "../scout-smartsure/claims/cardinal-ingestion.mjs";

// ---- 1. Mandate ---------------------------------------------------------------------------------

test("the literal word Mandate is a label: no parse failure, no value, no warning", () => {
  assert.equal(isMandateLabel("Mandate"), true);
  assert.equal(isMandateLabel(" mandate "), true);
  assert.equal(isMandateLabel("Mandate Limit"), false);
  const claim = mapCardinalRow({
    "Claim No.": "X1",
    "Claims Status": "Registered",
    "Claim Handler": "A",
    Age: 1,
    Insurer: "I",
    Outstanding: 100,
    Mandate: "Mandate",
  });
  assert.equal(claim.mandate, null, "no mandate value is derived from the column");
  assert.deepEqual(claim.ingestionQualityFlags, [], "no all-row warning");
  // A genuinely malformed mandate is still reported; a real number is still read.
  assert.ok(
    mapCardinalRow({ "Claim No.": "X2", "Claims Status": "Registered", "Claim Handler": "A", Age: 1, Insurer: "I", Mandate: "abc" })
      .ingestionQualityFlags.includes("source_parse_failure:mandate"),
  );
  assert.equal(
    mapCardinalRow({ "Claim No.": "X3", "Claims Status": "Registered", "Claim Handler": "A", Age: 1, Insurer: "I", Mandate: "R 100,000" }).mandate,
    100000,
  );
});

test("a workbook of Mandate labels raises no quality warning for any row", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    "Claim No.": `C-${i}`,
    "Claims Status": "Registered",
    "Claim Handler": "Lucky Mokgomo",
    Age: i,
    Insurer: "I",
    Mandate: "Mandate",
  }));
  const claims = rows.map((row) => mapCardinalRow(row));
  const quality = normalizeHistoricalRows(claims, { effectiveDate: "2026-10-02" }).quality;
  assert.equal(quality.invalid_numeric_count, 0);
  assert.ok(
    claims.every((claim) => claim.ingestionQualityFlags.length === 0),
    "no row carries a mandate flag",
  );
});

test("the combined High value / mandate metric is gone; High value rests on Outstanding only", () => {
  const report = week(
    [row("", "A", "Registered")],
    [
      row("", "A", "Registered", { outstanding: 100000 }), // at threshold
      row("", "B", "Registered", { outstanding: 99999 }),
      row("", "C", "Not Within Mandate", { outstanding: 10 }), // mandate STATUS: not counted
      row("", "D", "Authorised", { outstanding: null }), // unknown is not high value
    ],
  );
  const health = report.metrics.operational_health;
  assert.ok(!("high_value_mandate_attention" in health.value));
  assert.equal(health.value.high_value, 1);
  assert.deepEqual(health.details.claim_ids_by_category.high_value, ["A"]);
  assert.equal(health.details.high_value_basis, "outstanding");
  assert.equal(health.details.high_value_threshold, 100000);
});

// ---- 2. Payment status with zero estimate ----------------------------------------------------------------

test("payment status with zero estimate is strictly: open + payment-related status + estimate exactly 0", () => {
  assert.equal(isPaymentZeroEstimate({ status: "Payment Requested", estimate: 0 }), true);
  assert.equal(isPaymentZeroEstimate({ status: "Payment - Approved", estimate: "0" }), true);
  assert.equal(isPaymentZeroEstimate({ status: "TP insurer awaits Section 2 excess", estimate: 0 }), true);
  assert.equal(isPaymentZeroEstimate({ status: "Payment Requested", estimate: null }), false, "missing is not zero");
  assert.equal(isPaymentZeroEstimate({ status: "Payment Requested", estimate: 1 }), false);
  assert.equal(isPaymentZeroEstimate({ status: "Awaiting TP approach", estimate: 0 }), false, "not payment-related");
  assert.equal(isPaymentZeroEstimate({ status: "Registered", estimate: 0, outstanding: 0, paid: 0 }), false, "all-zero amounts alone no longer qualify");
  assert.equal(isPaymentZeroEstimate({ status: "Settled", estimate: 0 }), false, "terminal");
  assert.equal(isPaymentZeroEstimate({ status: "Rejected", estimate: 0 }), false, "terminal");
});

test("the report metric counts only payment-status claims with a zero estimate, by status", () => {
  const report = week(
    [row("", "A", "Registered")],
    [
      row("", "P1", "Payment Requested", { estimate: 0 }),
      row("", "P2", "Payment Requested", { estimate: 0 }),
      row("", "P3", "Payment - Approved", { estimate: 0 }),
      row("", "P4", "Payment Requested", { estimate: 5000 }),
      row("", "T", "Awaiting TP approach", { estimate: 0 }),
      row("", "R", "Registered", { estimate: 0, outstanding: 0, paid: 0 }),
    ],
  );
  const metric = report.metrics.zero_estimate_payment_request;
  assert.equal(metric.value, 3);
  assert.deepEqual(metric.claim_population.claim_ids, ["P1", "P2", "P3"]);
  assert.deepEqual(metric.details.count_by_status, { "payment requested": 2, "payment - approved": 1 });
  assert.match(metric.details.definition, /payment-related AND whose estimate is exactly zero/);
});

// ---- 3. Closed-like status hardening ----------------------------------------------------------------------

const ADDED_TERMINAL = [
  "Settled repudiated",
  "Settled within excess",
  "Settled no claim from client/claim withdrawn/NTU",
  "Settled Full Recovery",
  "Settled Duplicated",
  "Settled partial recovery made",
  "Settled File Closed",
  "Settled no claim from client",
  "Settled OD and TP claim paid",
  "Settled – Partial Repudiation",
  "Settled each party bears own costs",
  "Settled TP claim repudiated",
  "Settled no claim/no cover/no peril",
  "Settled TP claim Paid",
  "Settled OD paid TP claim repudiated",
  "Settled No TP claim made",
  "Settled – Ex Gratia",
  "Closed - Notification Only",
  "SETTLED – TP APPROACH PENDING", // parity: already terminal on the claims page
];

test("every evidenced closed-like Cardinal string is terminal, matched exactly", () => {
  for (const status of ADDED_TERMINAL) {
    const evaluation = getStatusEvaluation(status);
    assert.equal(evaluation.terminal, true, status);
    assert.equal(evaluation.open, false, status);
  }
});

test("closed-like text that is NOT evidenced stays visible: no fuzzy contains-closed matching", () => {
  for (const status of [
    "Closed", "Duplicate", "Withdrawn", "Canceled", "Settled - Paid", "Closed Paid Out",
    "Settled - awaiting approach", "Settled - Awaiting Salvage", "Incorrectly Registered",
    "No Cover Status", "INV", "PMT", "[None]",
  ]) {
    const evaluation = getStatusEvaluation(status);
    assert.equal(evaluation.terminal, false, `${status} must not terminalise`);
    assert.equal(evaluation.mapped, false, `${status} stays unmapped and therefore visible`);
  }
  // Unmapped and missing statuses are still counted and flagged at ingestion.
  const unmapped = normalizeHistoricalRows(
    [{ claimNo: "U1", status: "Incorrectly Registered", handler: "A" }, { claimNo: "U2", status: "[None]", handler: "A" }],
    { effectiveDate: "2026-10-02" },
  );
  assert.equal(unmapped.quality.unmapped_status_count, 1);
  assert.ok(unmapped.snapshots[1].data_quality_flags.includes("missing_status"));
});

test("the claims page and the domain rules agree on every terminal status", () => {
  const html = readFileSync(new URL("../scout-smartsure/claims/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = /const TERMINAL_STATUSES = new Set\(\[([\s\S]*?)\]\);/.exec(html)[1];
  const page = new Set([...block.matchAll(/"([^"]*)"/g)].map((match) => normalizeStatus(match[1])));
  assert.deepEqual([...page].filter((status) => !TERMINAL_STATUSES.has(status)), [], "terminal on page only");
  assert.deepEqual([...TERMINAL_STATUSES].filter((status) => !page.has(status)), [], "terminal in domain only");
});

// ===== Repudiated: terminal for REPORTING only; claims page and briefings unchanged =====

import { evaluateOperationalCategories, evaluateSla } from "./claims-rules.mjs";

const REPUDIATION_WORKFLOW_STATUSES = [
  "Repudiated",
  "Repudiated - Awaiting Closure",
  "Partial Repudiation",
  "Awaiting Repudiation Letter",
  "Partial Rejection",
  "Pending Rejection",
  "Broker Contests Rejection",
];

function pageTerminalSet() {
  const html = readFileSync(new URL("../scout-smartsure/claims/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = /const TERMINAL_STATUSES = new Set\(\[([\s\S]*?)\]\);/.exec(html)[1];
  return new Set([...block.matchAll(/"([^"]*)"/g)].map((match) => normalizeStatus(match[1])));
}

test("Repudiated is terminal for reporting and nowhere else", () => {
  // Reporting: terminal.
  assert.equal(isReportingTerminalStatus("Repudiated"), true);
  // Operational rules shared with the claims page / briefing logic: still NOT terminal.
  assert.equal(isTerminalStatus("Repudiated"), false);
  assert.equal(getStatusEvaluation("Repudiated").open, true);
  assert.equal(getStatusEvaluation("Repudiated").category, "repudiated");
  // The claims page's own terminal list does not contain it.
  assert.equal(pageTerminalSet().has("repudiated"), false);
  // Every repudiation workflow status keeps its operational (open) classification everywhere.
  const page = pageTerminalSet();
  for (const status of REPUDIATION_WORKFLOW_STATUSES) {
    assert.equal(isTerminalStatus(status), false, `${status} (domain)`);
    assert.equal(page.has(normalizeStatus(status)), false, `${status} (claims page)`);
  }
  // Only the explicit override list differs, and it holds exactly one status.
  const reportingOnly = REPUDIATION_WORKFLOW_STATUSES.filter(
    (status) => isReportingTerminalStatus(status) && !isTerminalStatus(status),
  );
  assert.deepEqual(reportingOnly, ["Repudiated"]);
});

test("the claims worklist behaviour for Repudiated is unchanged", () => {
  // Generic working-day SLA still excludes repudiation; its 270-day calendar rule applies instead.
  const sla = evaluateSla({ status: "Repudiated", workingAge: 40, calendarAge: 60 }, { asOfDate: "2026-10-02", onUnsupported: "return" });
  assert.equal(sla.state, "not_applicable");
  assert.equal(sla.reasonCode, "repudiation-calendar-rule");
  // The 270-day close-or-escalate rule still fires for an open Repudiated claim on the worklist.
  assert.equal(evaluateOperationalCategories({ status: "Repudiated", calendarAge: 300 }).repudiationExpired, true);
  assert.equal(evaluateOperationalCategories({ status: "Repudiated", calendarAge: 100 }).repudiationExpired, false);
  // Repudiated stays a stale-threshold-bearing workflow status (14 / 30 days) in the rule table.
  const evaluation = getStatusEvaluation("Repudiated");
  assert.equal(evaluation.staleThreshold, 14);
  assert.equal(evaluation.criticalThreshold, 30);
});

test("the briefing worker's Repudiated handling is untouched (source inspection)", () => {
  const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const terminal = /const TERMINAL_STATUSES = new Set\(\[([\s\S]*?)\]\);/.exec(worker)[1];
  assert.doesNotMatch(terminal, /repudiated/i, "worker does not treat Repudiated as terminal");
  assert.match(worker, /status === "repudiated" && age > 270/, "270-day close-or-escalate flag still present");
});

test("the report loader gives the previous-period comparison its own extract set (source inspection)", () => {
  const backend = readFileSync(new URL("../scout backend.js", import.meta.url), "utf8");
  const loader = /async function loadReportEvidence[\s\S]*?\n}\n/.exec(backend)[0];
  assert.match(loader, /reportEvidencePlan\(/, "loader uses the shared evidence plan");
  // The previous report is built from the PREVIOUS set, the current report from the current set.
  assert.match(loader, /previousReport = buildReportSnapshot\(\{[\s\S]*?snapshotsByExtract: previousSnapshotsByExtract/);
  assert.match(loader, /const report = buildReportSnapshot\(\{[\s\S]*?snapshotsByExtract,[\s\S]*?previousSnapshot: previousReport/);
});
