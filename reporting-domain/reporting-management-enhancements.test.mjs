import test from "node:test";
import assert from "node:assert/strict";
import { buildReportSnapshot } from "./reporting-metrics.mjs";
import { renderClaimsReportHtml } from "./claims-report-pdf.mjs";

function manifest(id, effectiveDate, count, previousExtractId = null) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims", broker_column_present: true, broker_capture_status: "captured", broker_populated_row_count: count },
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
    previous_extract_id: previousExtractId,
    correction_of_extract_id: null,
  };
}

function snapshot(claimNo, extractId, overrides = {}) {
  const terminal = overrides.terminal ?? false;
  return {
    extract_id: extractId,
    claim_id: overrides.claimId ?? `${claimNo}-uuid`,
    identity_key:
      overrides.identityMatchable === false ? null : `cardinal_claims:${claimNo}`,
    identity_matchable: overrides.identityMatchable ?? true,
    identity_confidence: "source_scoped",
    source_row_identity: overrides.rowId ?? `row-${claimNo}`,
    source_claim_number: claimNo,
    handler_source: overrides.handler ?? "Lucky Mokgomo",
    handler_email: null,
    resolved_scout_user_id: null,
    handler_resolution: "unresolved",
    status_raw: overrides.status ?? "Registered",
    status_normalized: String(overrides.status ?? "Registered").toLowerCase(),
    terminal,
    open: !terminal,
    registered_date: overrides.registeredDate ?? "2026-08-01",
    dol_date: "2026-07-20",
    movement_date: overrides.movementDate ?? "2026-10-10",
    repudiation_date: null,
    source_event_at: null,
    outstanding: overrides.outstanding ?? 1000,
    estimate: Object.prototype.hasOwnProperty.call(overrides, "estimate")
      ? overrides.estimate
      : 1500,
    paid: overrides.paid ?? 0,
    mandate: null,
    insurer: Object.prototype.hasOwnProperty.call(overrides, "insurer")
      ? overrides.insurer
      : "Alpha Insurance",
    broker: Object.prototype.hasOwnProperty.call(overrides, "broker")
      ? overrides.broker
      : "HRS",
    peril: "Motor",
    peril_type: "Motor",
    insured: overrides.insured ?? `Insured ${claimNo}`,
    description: overrides.description ?? "Fixture claim",
    comments: overrides.comments ?? null,
    calendar_age: overrides.calendarAge ?? 75,
    working_age: overrides.workingAge ?? 50,
    age_band: "61-90",
    rule_version: "claims-operations-rules-v1",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
    source_evidence: {
      settled: Object.prototype.hasOwnProperty.call(overrides, "settled")
        ? overrides.settled
        : false,
    },
  };
}

function buildManagementFixture() {
  const opening = manifest("opening", "2026-10-09", 1);
  const closing = manifest("closing", "2026-10-16", 8, opening.id);
  const multi = {
    status: "Payment Requested",
    registeredDate: "2026-07-01",
    workingAge: 70,
    insurer: "Beta Insurance",
    estimate: 0,
    identityMatchable: false,
    claimId: null,
  };
  const closingRows = [
    snapshot("HV-BOUNDARY", closing.id, {
      status: "Payment Requested",
      registeredDate: "2026-10-13",
      workingAge: 40,
      outstanding: 100000,
      estimate: 0,
      insurer: "Alpha Insurance",
      broker: " Bryanston ",
    }),
    snapshot("BELOW", closing.id, {
      outstanding: 99999,
      estimate: null,
      insurer: "Alpha Insurance",
      broker: "Bryanston",
    }),
    snapshot("HV-UNKNOWN", closing.id, {
      status: "Awaiting Assessor Report",
      outstanding: 250000,
      estimate: 1200,
      insurer: "",
      broker: "bryanston",
    }),
    snapshot("ZERO-READY", closing.id, {
      status: "Registered",
      workingAge: 90,
      outstanding: 20000,
      estimate: 0,
      insurer: "Beta Insurance",
      broker: "Insure With Us cc",
    }),
    snapshot("ZERO-NOT-READY", closing.id, {
      status: "Awaiting Assessor Report",
      workingAge: 10,
      outstanding: 500,
      estimate: 0,
      insurer: "Beta Insurance",
      broker: "",
    }),
    snapshot("MULTI", closing.id, {
      ...multi,
      rowId: "row-multi-1",
      outstanding: 90000,
    }),
    snapshot("MULTI", closing.id, {
      ...multi,
      rowId: "row-multi-2",
      outstanding: 110000,
    }),
    snapshot("TERMINAL", closing.id, {
      terminal: true,
      status: "Closed Paid",
      outstanding: 500000,
      insurer: "Closed Insurer",
    broker: "Closed Broker",
    }),
  ];
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-10-12",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      [opening.id, [snapshot("BASE", opening.id)]],
      [closing.id, closingRows],
    ]),
    changes: [],
    activeUsers: [],
  });
}

function buildReportWithRows(rows) {
  const opening = manifest("property-opening", "2026-10-09", 1);
  const closing = manifest("property-closing", "2026-10-16", rows.length, opening.id);
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-10-12",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      [opening.id, [snapshot("BASE", opening.id)]],
      [closing.id, rows.map((row) => ({ ...row, extract_id: closing.id }))],
    ]),
    changes: [],
    activeUsers: [],
  });
}

test("insurer distribution reconciles the accepted closing inventory and exact percentages", () => {
  const report = buildManagementFixture();
  const distribution = report.metrics.insurer_distribution;
  assert.equal(distribution.availability, "available");
  assert.equal(distribution.value.total_open_claims, report.metrics.closing_inventory.value);
  assert.equal(
    distribution.value.rows.reduce((sum, row) => sum + row.open_claims, 0),
    report.metrics.closing_inventory.value,
  );
  assert.equal(distribution.value.percentage_basis_points_total, 10000);
  assert.equal(distribution.value.unknown_open_claims, 1);
  assert.deepEqual(
    distribution.value.rows.map(({ name, open_claims, percentage_basis_points }) => ({
      name,
      open_claims,
      percentage_basis_points,
    })),
    [
      { name: "Beta Insurance", open_claims: 3, percentage_basis_points: 5000 },
      { name: "Alpha Insurance", open_claims: 2, percentage_basis_points: 3333 },
      { name: "Unknown / Unmapped", open_claims: 1, percentage_basis_points: 1667 },
    ],
  );
  assert.equal(
    distribution.value.outstanding_exposure_total,
    report.metrics.financial_open_outstanding.value,
  );
});

test("broker distribution preserves exact values, reconciles counts, time subsets and safely resolved finances", () => {
  const report = buildManagementFixture();
  const metric = report.metrics.brokerage_distribution;
  assert.equal(metric.availability, "available");
  assert.equal(metric.details.source_field, "broker");
  assert.equal(metric.value.total_open_claims, report.metrics.closing_inventory.value);
  assert.equal(metric.value.rows.reduce((sum, row) => sum + row.open_claims, 0), report.metrics.closing_inventory.value);
  assert.equal(metric.value.percentage_basis_points_total, 10000);
  assert.equal(metric.value.unknown_open_claims, 1);
  assert.ok(metric.value.rows.some((row) => row.name === "Bryanston"));
  assert.ok(metric.value.rows.some((row) => row.name === "bryanston"));
  assert.equal(metric.value.rows.find((row) => row.name === "Bryanston").open_claims, 2);
  assert.equal(metric.value.rows.find((row) => row.name === "Bryanston").new_this_period, 1);
  assert.equal(metric.value.rows.find((row) => row.name === "Bryanston").over_60_days, 2);
  assert.equal(metric.value.excluded_financial_claim_count, 1);
});

test("REN0002 groups any Broker value as Renault while preserving raw source evidence", () => {
  const rows = [
    snapshot("REN0002-A", "closing", { broker: "Bryanston" }),
    snapshot("REN0002-B", "closing", { broker: "East Rand" }),
    snapshot("REN0002-C", "closing", { broker: "Brian Hodges" }),
    snapshot("OTHER-A", "closing", { broker: "Bryanston" }),
    snapshot("OTHER-B", "closing", { broker: "Brian Hodges" }),
    snapshot("OTHER-C", "closing", { broker: " " }),
  ];
  const closing = manifest("closing", "2026-10-16", rows.length);
  const opening = manifest("opening", "2026-10-09", 1);
  const report = buildReportSnapshot({
    reportType: "weekly", periodStart: "2026-10-12", manifests: [opening, closing],
    snapshotsByExtract: new Map([[opening.id, [snapshot("BASE", opening.id)]], [closing.id, rows.map((row) => ({ ...row, extract_id: closing.id }))]]),
    changes: [], activeUsers: [],
  });
  const distribution = report.metrics.brokerage_distribution.value;
  assert.equal(distribution.rows.find((row) => row.bucket_type === "renault_prefix")?.open_claims, 3);
  assert.equal(distribution.rows.find((row) => row.bucket_type === "source_value" && row.name === "Bryanston")?.open_claims, 1);
  assert.equal(distribution.rows.find((row) => row.bucket_type === "source_value" && row.name === "Brian Hodges")?.open_claims, 1);
  assert.equal(distribution.unknown_open_claims, 1);
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "REN0002-A")?.broker_snapshot, "Bryanston");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "REN0002-A")?.broker_reporting_group_snapshot, "Renault");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "REN0002-B")?.broker_snapshot, "East Rand");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "REN0002-C")?.broker_snapshot, "Brian Hodges");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "OTHER-A")?.broker_reporting_group_snapshot, "Bryanston");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "OTHER-B")?.broker_reporting_group_snapshot, "Brian Hodges");
  assert.equal(report.claim_rows.find((row) => row.source_claim_number === "OTHER-C")?.broker_reporting_group_snapshot, null);
  assert.equal(distribution.total_open_claims, report.metrics.closing_inventory.value);
  assert.equal(distribution.percentage_basis_points_total, 10000);
});

test("pre-Broker extracts mark brokerage unavailable, while captured blank rows remain Unknown", () => {
  const report = buildManagementFixture();
  const oldManifest = manifest("old-closing", "2026-10-16", 1);
  delete oldManifest.source_metadata.broker_column_present;
  delete oldManifest.source_metadata.broker_capture_status;
  const oldReport = buildReportSnapshot({
    reportType: "weekly", periodStart: "2026-10-12", manifests: [oldManifest],
    snapshotsByExtract: new Map([[oldManifest.id, [snapshot("OLD", oldManifest.id, { broker: null })]]]),
    changes: [], activeUsers: [],
  });
  assert.equal(oldReport.metrics.brokerage_distribution.availability, "unavailable");
  assert.equal(oldReport.metrics.brokerage_distribution.coverage_warnings[0], "broker_not_captured");
  const html = renderClaimsReportHtml({ report_type: "weekly", status: "draft", metrics_snapshot: oldReport }, { available: true, attention_items: [], action_items: [] });
  assert.match(html, /Broker was not captured in this source extract\./);
  assert.equal(report.metrics.brokerage_distribution.value.unknown_open_claims, 1);
});

test("real-volume PDF fixtures preserve 28/40/60 management exception counts and print rules", () => {
  const scenarios = [
    { label: "28 high-value", rows: 28, highValue: true, zero: false },
    { label: "40 zero-estimate", rows: 40, highValue: false, zero: true },
    { label: "60 high-value", rows: 60, highValue: true, zero: false },
  ];
  for (const scenario of scenarios) {
    const rows = Array.from({ length: scenario.rows }, (_, index) => snapshot(`${scenario.label}-${index}`, "x", {
      outstanding: scenario.highValue ? 100000 + index : 5000 + index,
      estimate: scenario.zero ? 0 : 2500,
      status: scenario.zero ? "TP insurer awaits Section 2 excess" : "Registered",
      registeredDate: "2026-08-01",
    }));
    const report = buildReportWithRows(rows);
    const highCount = report.metrics.high_value_claim_detail.value.open_claims.length;
    const zeroCount = report.metrics.zero_estimate_reserve_review.value.length;
    assert.equal(highCount, scenario.highValue ? scenario.rows : 0, scenario.label);
    assert.equal(zeroCount, scenario.zero ? scenario.rows : 0, scenario.label);
    const html = renderClaimsReportHtml({ report_type: "weekly", status: "draft", metrics_snapshot: report }, { available: true, attention_items: [], action_items: [] });
    assert.match(html, /thead \{ display: table-header-group; \}/);
    assert.match(html, /tfoot, \.brokerage-table tfoot \{ display: table-row-group; \}/);
    assert.match(html, /break-after: avoid; page-break-after: avoid/);
  }
});

test("broker synthetic buckets never collide with literal Other or Unknown / Unmapped values", () => {
  const report = buildReportWithRows([
    snapshot("LITERAL-UNKNOWN", "x", { broker: "Unknown / Unmapped" }),
    snapshot("LITERAL-OTHER", "x", { broker: "Other" }),
    snapshot("SYNTHETIC-UNKNOWN", "x", { broker: "  " }),
  ]);
  const rows = report.metrics.brokerage_distribution.value.rows;
  assert.ok(rows.some((row) => row.bucket_type === "source_value" && row.name === "Unknown / Unmapped"));
  assert.ok(rows.some((row) => row.bucket_type === "unknown" && row.name === "Unknown / Unmapped"));
  assert.ok(rows.some((row) => row.bucket_type === "source_value" && row.name === "Other"));
  assert.equal(report.metrics.brokerage_distribution.value.total_open_claims, 3);
  assert.equal(report.metrics.brokerage_distribution.value.percentage_basis_points_total, 10000);
});

test("basis-point allocations are nonnegative, deterministic, tied safely, and reconcile at large counts and values", () => {
  const tied = buildReportWithRows([
    snapshot("TIE-A", "x", { broker: "Alpha" }),
    snapshot("TIE-B", "x", { broker: "Bravo" }),
    snapshot("TIE-C", "x", { broker: "Charlie" }),
  ]).metrics.brokerage_distribution.value;
  assert.deepEqual(tied.rows.map(({ name, percentage_basis_points }) => [name, percentage_basis_points]), [
    ["Alpha", 3334], ["Bravo", 3333], ["Charlie", 3333],
  ]);
  const codePointTie = buildReportWithRows([
    snapshot("CODEPOINT-A", "x", { broker: "\u{10000}" }),
    snapshot("CODEPOINT-B", "x", { broker: "\uE000" }),
    snapshot("CODEPOINT-C", "x", { broker: "\uF000" }),
  ]).metrics.brokerage_distribution.value;
  assert.equal(codePointTie.rows.find((row) => row.name === "\uE000").percentage_basis_points, 3334);
  for (const count of [17, 257]) {
    const rows = Array.from({ length: count }, (_, index) => snapshot(`PROP-${index}`, "x", {
      broker: `Broker ${String(index).padStart(3, "0")}`,
      outstanding: index + 0.01,
    }));
    const result = buildReportWithRows(rows);
    const distribution = result.metrics.brokerage_distribution.value;
    assert.equal(distribution.percentage_basis_points_total, 10000);
    assert.ok(distribution.rows.every((row) => row.percentage_basis_points >= 0));
    assert.equal(distribution.total_open_claims, count);
    assert.equal(distribution.known_outstanding_exposure_total, rows.reduce((sum, row) => sum + Math.round(row.outstanding * 100), 0) / 100);
  }
  const large = buildReportWithRows([
    snapshot("BIG-A", "x", { outstanding: 123456789.01 }),
    snapshot("BIG-B", "x", { outstanding: 987654321.02 }),
  ]);
  assert.equal(large.metrics.financial_open_outstanding.value, 1111111110.03);
  assert.equal(large.metrics.brokerage_distribution.value.known_outstanding_exposure_total, 1111111110.03);
});

test("broker distribution exposes Top-N cut ties and exact case/whitespace collision warnings without merging", () => {
  const values = ["GrowthHouse", "Growthhouse", "North  Branch", "North Branch", ...Array.from({ length: 8 }, (_, i) => `Unique ${i}`)];
  const report = buildReportWithRows(values.map((broker, index) => snapshot(`COLL-${index}`, "x", { broker })));
  const metric = report.metrics.brokerage_distribution;
  assert.equal(metric.details.top_n_cutoff_tie.claim_count, 1);
  assert.ok(metric.details.collision_warnings.some((warning) => warning.values.includes("GrowthHouse") && warning.values.includes("Growthhouse")));
  assert.ok(metric.details.collision_warnings.some((warning) => warning.values.includes("North  Branch") && warning.values.includes("North Branch")));
  assert.equal(metric.value.rows.length, values.length);
});

test("high-value detail uses Outstanding >= R100k, registration rules and explicit multi-row exclusion", () => {
  const report = buildManagementFixture();
  const detail = report.metrics.high_value_claim_detail;
  assert.equal(detail.value.threshold, 100000);
  assert.deepEqual(
    detail.value.open_claims.map((row) => row.claim_number),
    ["HV-BOUNDARY", "HV-UNKNOWN"],
  );
  assert.deepEqual(
    detail.value.new_this_period.map((row) => row.claim_number),
    ["HV-BOUNDARY"],
  );
  assert.deepEqual(detail.value.excluded_multi_row_claim_numbers, ["MULTI"]);
  assert.equal(
    detail.value.open_claims.length,
    report.metrics.operational_health.value.high_value,
  );
  assert.equal(detail.value.open_claims.some((row) => row.claim_number === "BELOW"), false);
  assert.equal(detail.value.open_claims[0].brokerage, "Bryanston");
});

test("zero-estimate closure review is exact, deterministic and never treats missing as zero", () => {
  const metric = buildManagementFixture().metrics.zero_estimate_closure_review;
  const numbers = metric.value.map((row) => row.claim_number);
  assert.deepEqual(numbers, ["ZERO-READY"]);
  assert.equal(numbers.includes("BELOW"), false, "missing estimate excluded");
  assert.equal(numbers.includes("HV-UNKNOWN"), false, "non-zero estimate excluded");
  assert.equal(numbers.includes("ZERO-NOT-READY"), false, "zero alone is insufficient");
  assert.ok(metric.value.every((row) => row.estimate === 0));
  assert.match(metric.definition, /payment-related status plus zero estimate alone is not closure evidence/);
  assert.equal(metric.details.mutation_behavior, "report_only_no_claim_state_mutation");
});

test("zero-estimate review separates TP excess, new, recovery-in-progress, and true zero-outstanding candidates", () => {
  const report = buildReportWithRows([
    snapshot("TP-EXCESS", "x", { status: "TP insurer awaits Section 2 excess", estimate: 0, outstanding: 20000, registeredDate: "2026-10-15" }),
    snapshot("NEW-ZERO", "x", { status: "Registered", estimate: 0, outstanding: 5000, registeredDate: "2026-10-15" }),
    snapshot("RECOVERY-ZERO", "x", { status: "Awaiting Recovery", comments: "recovery pending", estimate: 0, outstanding: 1000 }),
    snapshot("TRUE-CLOSE", "x", { status: "Registered", estimate: 0, outstanding: 0 }),
  ]);
  assert.deepEqual(report.metrics.zero_estimate_closure_review.value.map((row) => row.claim_number), ["TRUE-CLOSE"]);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value.map((row) => row.claim_number), ["NEW-ZERO", "TP-EXCESS"]);
  assert.equal(report.metrics.zero_estimate_reserve_review.details.mutation_behavior, "report_only_no_claim_state_mutation");
});

test("post-settlement operational work is exact-status driven for every Settled evidence state", () => {
  const statuses = [
    {
      key: "RECOVERY",
      status: "AWAITING RECOVERY",
      category: "recovery_in_progress",
      handler: "Lucky Mokgomo",
    },
    {
      key: "RECOVERY-PENDING",
      status: "SETTLED - RECOVERY PENDING",
      category: "recovery_in_progress",
      handler: "Lucky Mokgomo",
    },
    {
      key: "RECOVERY-AWAITING",
      status: "SETTLED - AWAITING RECOVERY",
      category: "recovery_in_progress",
      handler: "Lucky Mokgomo",
    },
    {
      key: "RECOVERY-IN-PROGRESS",
      status: "RECOVERY IN PROGRESS",
      category: "recovery_in_progress",
      handler: "Lucky Mokgomo",
    },
    {
      key: "APPROACH",
      status: "PENDING APPROACH",
      category: "pending_third_party_approach",
      handler: "Naledi Moletsane",
    },
    {
      key: "APPROACH-AWAITING",
      status: "SETTLED - AWAITING APPROACH",
      category: "pending_third_party_approach",
      handler: "Naledi Moletsane",
    },
    {
      key: "APPROACH-TP-PENDING",
      status: "SETTLED - TP APPROACH PENDING",
      category: "pending_third_party_approach",
      handler: "Naledi Moletsane",
    },
    {
      key: "APPROACH-AWAITING-TP",
      status: "AWAITING TP APPROACH",
      category: "pending_third_party_approach",
      handler: "Naledi Moletsane",
    },
  ];
  const evidenceStates = [
    { key: "TRUE", values: [true] },
    { key: "FALSE", values: [false] },
    { key: "UNAVAILABLE", values: [null] },
    { key: "CONFLICTING", values: [true, false] },
  ];
  const targetRows = [];
  const expectedClaims = [];
  for (const definition of statuses) {
    for (const evidence of evidenceStates) {
      const claimNo = `${definition.key}-${evidence.key}`;
      expectedClaims.push({
        id: `${claimNo}-uuid`,
        claimNo,
        category: definition.category,
      });
      evidence.values.forEach((settled, index) => {
        targetRows.push(
          snapshot(claimNo, "x", {
            status: definition.status,
            settled,
            terminal: true,
            rowId: `row-${claimNo}-${index}`,
            registeredDate: "2026-07-01",
            estimate: 0,
            outstanding: 100,
            paid: 5000,
            handler: definition.handler,
          }),
        );
      });
    }
  }
  const report = buildReportWithRows([
    ...targetRows,
    snapshot("ORDINARY-SETTLED-FLAG", "x", {
      status: "Registered",
      settled: true,
      registeredDate: "2026-10-01",
      calendarAge: 15,
      estimate: 100,
      outstanding: 100,
    }),
    snapshot("TRUE-TERMINAL", "x", {
      status: "SETTLED",
      settled: true,
      terminal: true,
      registeredDate: "2026-07-01",
    }),
  ]);
  const closingIds = report.metrics.closing_inventory.claim_population.claim_ids;
  for (const id of [
    ...expectedClaims.map((claim) => claim.id),
    "ORDINARY-SETTLED-FLAG-uuid",
  ])
    assert.ok(closingIds.includes(id), `${id} remains operationally open`);
  assert.equal(closingIds.includes("TRUE-TERMINAL-uuid"), false);
  assert.equal(report.metrics.closing_inventory.value, 33);
  assert.equal(
    report.metrics.handler_scorecards.value.totals.gross_registered,
    report.metrics.closing_inventory.value,
  );
  assert.equal(report.metrics.handler_scorecards.value.totals.gross_registered, 33);
  assert.equal(report.metrics.handler_scorecards.value.totals.over_60, 32);
  assert.equal(report.metrics.ready_to_close.value, 0);
  assert.equal(report.metrics.zero_estimate_payment_request.value, 0);
  assert.deepEqual(report.metrics.zero_estimate_closure_review.value, []);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value, []);
  assert.equal(report.metrics.financial_open_outstanding.value, 3300);
  assert.equal(
    report.metrics.financial_open_outstanding.details.total_open_claim_count,
    33,
  );

  const metric = report.metrics.post_settlement_open_work;
  assert.equal(metric.value.total_open_claim_count, 32);
  assert.deepEqual(
    new Set(metric.claim_population.claim_ids),
    new Set(expectedClaims.map((claim) => claim.id)),
  );
  assert.deepEqual(metric.coverage_warnings, []);
  assert.equal(
    metric.details.settled_requirement,
    "not_consulted_exact_status_is_authoritative",
  );
  assert.equal("settled_false_open_claim_count" in metric.details, false);
  assert.equal("settled_unavailable_open_claim_count" in metric.details, false);
  assert.ok(
    metric.claim_population.claim_ids.every((id) =>
      report.metrics.scorecard_gross_registered.claim_population.claim_ids.includes(id),
    ),
    "the management subclass is already counted in Total Gross Registered",
  );
  assert.equal(
    metric.value.categories.reduce((sum, category) => sum + category.open_claim_count, 0),
    32,
  );
  const recovery = metric.value.categories.find(
    (category) => category.key === "recovery_in_progress",
  );
  const approach = metric.value.categories.find(
    (category) => category.key === "pending_third_party_approach",
  );
  assert.deepEqual(recovery.source_statuses, [
    "AWAITING RECOVERY",
    "SETTLED - RECOVERY PENDING",
    "SETTLED - AWAITING RECOVERY",
    "RECOVERY IN PROGRESS",
  ]);
  assert.equal(recovery.open_claim_count, 16);
  assert.equal(recovery.over_60_days, 16);
  assert.deepEqual(recovery.handler_distribution.map((handler) => handler.label), [
    "Lucky Mokgomo",
  ]);
  assert.equal(approach.source_status, "PENDING APPROACH");
  assert.deepEqual(approach.source_statuses, [
    "PENDING APPROACH",
    "SETTLED - AWAITING APPROACH",
    "SETTLED - TP APPROACH PENDING",
    "AWAITING TP APPROACH",
  ]);
  assert.equal(approach.open_claim_count, 16);
  assert.equal(approach.over_60_days, 16);
  assert.deepEqual(approach.handler_distribution.map((handler) => handler.label), [
    "Naledi Moletsane",
  ]);
  for (const expected of expectedClaims) {
    const row = report.claim_rows.find(
      (candidate) => candidate.source_claim_number === expected.claimNo,
    );
    assert.equal(
      row.membership_reasons.post_settlement_open_work,
      expected.category,
      expected.claimNo,
    );
  }
  assert.deepEqual(
    report.management_reporting.post_settlement_open_work.operational_statuses,
    statuses.map((definition) => definition.status),
  );
  assert.equal(
    report.management_reporting.post_settlement_open_work.settled_requirement,
    "not_consulted_exact_status_is_authoritative",
  );
  const html = renderClaimsReportHtml(
    {
      report_type: "weekly",
      status: "finalised",
      metrics_snapshot: report,
    },
    { available: true, attention_items: [], action_items: [] },
  );
  assert.match(html, /Post-Settlement Open Work/);
  assert.match(html, /Recovery in Progress/);
  assert.match(html, /Pending Third-Party Approach/);
  for (const { status } of statuses) assert.match(html, new RegExp(status));
  assert.match(html, /Lucky Mokgomo \(16\)/);
  assert.match(html, /Naledi Moletsane \(16\)/);
  assert.doesNotMatch(html, /six approved/i, "wording must not hard-code the taxonomy size");
  assert.match(html, /Settled flag.*not consulted/);
});

test("same-category multi-row status variants retain one protected parent classification", () => {
  const fixtures = [
    {
      claimNo: "MULTI-RECOVERY",
      statuses: ["AWAITING RECOVERY", "SETTLED - AWAITING RECOVERY"],
      category: "recovery_in_progress",
    },
    {
      claimNo: "MULTI-APPROACH",
      statuses: ["PENDING APPROACH", "SETTLED - TP APPROACH PENDING"],
      category: "pending_third_party_approach",
    },
    {
      claimNo: "MULTI-RECOVERY-IN-PROGRESS",
      statuses: ["AWAITING RECOVERY", "RECOVERY IN PROGRESS"],
      category: "recovery_in_progress",
    },
    {
      claimNo: "MULTI-APPROACH-AWAITING-TP",
      statuses: ["PENDING APPROACH", "AWAITING TP APPROACH"],
      category: "pending_third_party_approach",
    },
  ];
  const rows = fixtures.flatMap(({ claimNo, statuses }) =>
    statuses.map((status, index) =>
      snapshot(claimNo, "x", {
        status,
        terminal: true,
        rowId: `row-${claimNo}-${index}`,
        registeredDate: "2026-07-01",
        estimate: 0,
        outstanding: 0,
        paid: 0,
      }),
    ),
  );
  const report = buildReportWithRows(rows);
  const expectedIds = fixtures.map(({ claimNo }) => `${claimNo}-uuid`);

  assert.deepEqual(new Set(report.metrics.closing_inventory.claim_population.claim_ids), new Set(expectedIds));
  assert.deepEqual(new Set(report.metrics.scorecard_gross_registered.claim_population.claim_ids), new Set(expectedIds));
  assert.deepEqual(new Set(report.metrics.open_claims_60_plus.claim_population.claim_ids), new Set(expectedIds));
  assert.equal(report.metrics.handler_scorecards.value.totals.gross_registered, 4);
  assert.equal(report.metrics.handler_scorecards.value.totals.over_60, 4);
  assert.equal(report.metrics.ready_to_close.value, 0);
  assert.equal(report.metrics.zero_estimate_payment_request.value, 0);
  assert.deepEqual(report.metrics.zero_estimate_closure_review.value, []);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value, []);

  const postSettlement = report.metrics.post_settlement_open_work;
  assert.equal(postSettlement.value.total_open_claim_count, 4);
  assert.deepEqual(new Set(postSettlement.claim_population.claim_ids), new Set(expectedIds));
  for (const fixture of fixtures) {
    const category = postSettlement.value.categories.find(({ key }) => key === fixture.category);
    assert.equal(
      category.open_claim_count,
      fixtures.filter(({ category: key }) => key === fixture.category).length,
      fixture.claimNo,
    );
    const claimRow = report.claim_rows.find(({ source_claim_number }) => source_claim_number === fixture.claimNo);
    assert.equal(claimRow.status_snapshot, null, `${fixture.claimNo}: raw textual consensus remains unresolved`);
    assert.equal(claimRow.membership_reasons.post_settlement_open_work, fixture.category);
  }
  assert.deepEqual(postSettlement.coverage_warnings, []);
});

test("cross-category multi-row status conflict remains protected and is disclosed without category assignment", () => {
  const claimNo = "MULTI-CROSS-CATEGORY";
  const claimId = `${claimNo}-uuid`;
  const report = buildReportWithRows([
    snapshot(claimNo, "x", {
      status: "AWAITING RECOVERY",
      terminal: true,
      rowId: `row-${claimNo}-0`,
      registeredDate: "2026-07-01",
      estimate: 0,
      outstanding: 0,
      paid: 0,
    }),
    snapshot(claimNo, "x", {
      status: "PENDING APPROACH",
      terminal: true,
      rowId: `row-${claimNo}-1`,
      registeredDate: "2026-07-01",
      estimate: 0,
      outstanding: 0,
      paid: 0,
    }),
  ]);

  assert.deepEqual(report.metrics.closing_inventory.claim_population.claim_ids, [claimId]);
  assert.deepEqual(report.metrics.scorecard_gross_registered.claim_population.claim_ids, [claimId]);
  assert.deepEqual(report.metrics.open_claims_60_plus.claim_population.claim_ids, [claimId]);
  assert.equal(report.metrics.handler_scorecards.value.totals.gross_registered, 1);
  assert.equal(report.metrics.handler_scorecards.value.totals.over_60, 1);
  assert.equal(report.metrics.ready_to_close.value, 0);
  assert.equal(report.metrics.zero_estimate_payment_request.value, 0);
  assert.deepEqual(report.metrics.zero_estimate_closure_review.value, []);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value, []);

  const postSettlement = report.metrics.post_settlement_open_work;
  assert.equal(postSettlement.value.total_open_claim_count, 0);
  assert.deepEqual(postSettlement.claim_population.claim_ids, []);
  assert.ok(postSettlement.value.categories.every(({ open_claim_count }) => open_claim_count === 0));
  assert.deepEqual(postSettlement.coverage_warnings, ["post_settlement_category_ambiguous"]);
  assert.equal(postSettlement.details.protected_open_claim_count, 1);
  assert.equal(postSettlement.details.category_counted_claim_count, 0);
  assert.deepEqual(postSettlement.details.ambiguous_category_claim_numbers, [claimNo]);
  assert.deepEqual(postSettlement.details.ambiguous_category_keys_by_claim[claimNo], [
    "pending_third_party_approach",
    "recovery_in_progress",
  ]);
  const claimRow = report.claim_rows.find(({ source_claim_number }) => source_claim_number === claimNo);
  assert.equal(claimRow.status_snapshot, null);
  assert.ok(claimRow.relevant_flags.parent_quality_flags.includes("post_settlement_category_ambiguous"));
  assert.equal("post_settlement_open_work" in claimRow.membership_reasons, false);
});

test("recovery-in-progress and awaiting-TP-approach stay out of closure and both zero-estimate reviews", () => {
  const protectedRows = [
    { claimNo: "RIP-ZERO-OUTSTANDING", status: "RECOVERY IN PROGRESS", outstanding: 0 },
    { claimNo: "RIP-OUTSTANDING", status: "RECOVERY IN PROGRESS", outstanding: 66078.68 },
    { claimNo: "ATA-ZERO-OUTSTANDING", status: "AWAITING TP APPROACH", outstanding: 0 },
    { claimNo: "ATA-OUTSTANDING", status: "AWAITING TP APPROACH", outstanding: 20000 },
  ];
  const report = buildReportWithRows([
    ...protectedRows.map(({ claimNo, status, outstanding }) =>
      snapshot(claimNo, "x", {
        status,
        registeredDate: "2026-07-01",
        estimate: 0,
        outstanding,
        paid: 0,
      }),
    ),
    // Controls prove the reviews still fire for unprotected zero-estimate claims.
    snapshot("TRUE-CLOSE", "x", { status: "Registered", estimate: 0, outstanding: 0 }),
    snapshot("NEW-ZERO", "x", { status: "Registered", estimate: 0, outstanding: 5000, registeredDate: "2026-10-15" }),
  ]);
  const protectedIds = protectedRows.map(({ claimNo }) => `${claimNo}-uuid`);

  assert.deepEqual(report.metrics.zero_estimate_closure_review.value.map((row) => row.claim_number), ["TRUE-CLOSE"]);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value.map((row) => row.claim_number), ["NEW-ZERO"]);
  assert.equal(report.metrics.ready_to_close.value, 0);
  for (const id of protectedIds) {
    assert.ok(report.metrics.closing_inventory.claim_population.claim_ids.includes(id), `${id} in closing inventory`);
    assert.ok(report.metrics.scorecard_gross_registered.claim_population.claim_ids.includes(id), `${id} in Total Gross Registered`);
    assert.ok(report.metrics.open_claims_60_plus.claim_population.claim_ids.includes(id), `${id} in registration-date ageing`);
  }
  // Four protected claims plus the two unprotected controls.
  assert.equal(report.metrics.handler_scorecards.value.totals.gross_registered, 6);

  const postSettlement = report.metrics.post_settlement_open_work;
  assert.equal(postSettlement.value.total_open_claim_count, 4);
  assert.deepEqual(new Set(postSettlement.claim_population.claim_ids), new Set(protectedIds));
  assert.deepEqual(postSettlement.coverage_warnings, []);
  const counts = Object.fromEntries(
    postSettlement.value.categories.map((category) => [category.key, category.open_claim_count]),
  );
  assert.deepEqual(counts, { recovery_in_progress: 2, pending_third_party_approach: 2 });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(postSettlement.details.claim_ids_by_category).map(([key, ids]) => [key, [...ids].sort()]),
    ),
    {
      recovery_in_progress: ["RIP-OUTSTANDING-uuid", "RIP-ZERO-OUTSTANDING-uuid"],
      pending_third_party_approach: ["ATA-OUTSTANDING-uuid", "ATA-ZERO-OUTSTANDING-uuid"],
    },
  );
  assert.equal(postSettlement.details.settled_requirement, "not_consulted_exact_status_is_authoritative");
});

test("cross-category conflict using the new statuses stays protected and is disclosed without category assignment", () => {
  const claimNo = "MULTI-CROSS-NEW-STATUSES";
  const claimId = `${claimNo}-uuid`;
  const report = buildReportWithRows(
    ["RECOVERY IN PROGRESS", "AWAITING TP APPROACH"].map((status, index) =>
      snapshot(claimNo, "x", {
        status,
        rowId: `row-${claimNo}-${index}`,
        registeredDate: "2026-07-01",
        estimate: 0,
        outstanding: 0,
        paid: 0,
      }),
    ),
  );

  assert.deepEqual(report.metrics.closing_inventory.claim_population.claim_ids, [claimId]);
  assert.deepEqual(report.metrics.scorecard_gross_registered.claim_population.claim_ids, [claimId]);
  assert.deepEqual(report.metrics.zero_estimate_closure_review.value, []);
  assert.deepEqual(report.metrics.zero_estimate_reserve_review.value, []);
  assert.equal(report.metrics.ready_to_close.value, 0);

  const postSettlement = report.metrics.post_settlement_open_work;
  assert.equal(postSettlement.value.total_open_claim_count, 0);
  assert.deepEqual(postSettlement.coverage_warnings, ["post_settlement_category_ambiguous"]);
  assert.equal(postSettlement.details.protected_open_claim_count, 1);
  assert.deepEqual(postSettlement.details.ambiguous_category_claim_numbers, [claimNo]);
  assert.deepEqual(postSettlement.details.ambiguous_category_keys_by_claim[claimNo], [
    "pending_third_party_approach",
    "recovery_in_progress",
  ]);
});

test("management data contract and detail values are frozen into the persisted snapshot shape", () => {
  const report = buildManagementFixture();
  assert.equal(report.management_reporting.frozen_at_generation, true);
  assert.equal(report.management_reporting.pdf_reads_snapshot_only, true);
  assert.equal(report.management_reporting.portfolio_distribution.insurer_source_field, "insurer");
  assert.equal(report.management_reporting.portfolio_distribution.brokerage_source_field, "broker");
  assert.equal(
    report.claim_rows.find((row) => row.source_claim_number === "HV-BOUNDARY")?.broker_snapshot,
    "Bryanston",
  );
  const regenerated = buildManagementFixture();
  assert.deepEqual(report.management_reporting, regenerated.management_reporting);
  assert.deepEqual(report.metrics.insurer_distribution, regenerated.metrics.insurer_distribution);
  assert.deepEqual(report.metrics.brokerage_distribution, regenerated.metrics.brokerage_distribution);
  assert.deepEqual(report.metrics.high_value_claim_detail, regenerated.metrics.high_value_claim_detail);
  assert.deepEqual(
    report.metrics.zero_estimate_closure_review,
    regenerated.metrics.zero_estimate_closure_review,
  );
});

test("management PDF uses the consolidated page hierarchy and omits an empty queries page", () => {
  const snapshot = buildManagementFixture();
  const run = {
    report_type: "weekly",
    status: "finalised",
    generated_at: "2026-10-17T08:00:00.000Z",
    finalised_at: "2026-10-17T09:00:00.000Z",
    metrics_snapshot: snapshot,
  };
  const html = renderClaimsReportHtml(run, {
    available: true,
    attention_items: [],
    action_items: [],
  });
  assert.match(html, /Claims Performance/);
  assert.match(html, /Post-Settlement Open Work/);
  assert.match(
    html,
    /Main claim settled; operational recovery \/ third-party work remains open/,
  );
  assert.ok(
    html.indexOf("Claims Performance") <
      html.indexOf("Post-Settlement Open Work"),
  );
  assert.ok(
    html.indexOf("Post-Settlement Open Work") <
      html.indexOf("Portfolio distribution"),
  );
  assert.match(html, /Portfolio distribution/);
  assert.match(html, /conic-gradient/);
  assert.match(html, /Unknown \/ Unmapped/);
  assert.match(html, /Broker \/ Brokerage Distribution/);
  assert.doesNotMatch(html, /Source evidence gap/);
  assert.match(html, /Known outstanding/);
  assert.match(html, /NEW THIS PERIOD|New this period/);
  const highValueBlock = html.slice(
    html.indexOf("<h3>High value (outstanding)</h3>"),
    html.indexOf("Zero-estimate claims requiring review"),
  );
  assert.equal((highValueBlock.match(/<th scope="row">HV-BOUNDARY<\/th>/g) || []).length, 1);
  assert.match(html, /Zero-estimate claims requiring review/);
  assert.match(html, /Estimate \/ reserve review/);
  assert.match(html, /High-value items requiring review/);
  assert.match(html, /Sections straddle threshold \/ additive semantics unresolved/);
  assert.match(html, /Supporting intelligence/);
  assert.match(html, /SLA and methodology/);
  assert.doesNotMatch(html, /What needs follow-through\?/);
  assert.doesNotMatch(html, /No actions were recorded against this report/);
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
});

test("management PDF includes one conditional workflow page when queries or actions exist", () => {
  const snapshot = buildManagementFixture();
  const html = renderClaimsReportHtml(
    {
      report_type: "weekly",
      status: "finalised",
      metrics_snapshot: snapshot,
    },
    {
      available: true,
      attention_items: [
        {
          title_snapshot: "Confirm reserve",
          status_snapshot: "open",
          category_snapshot: "claim_development",
          owner_display_snapshot: "Lucky",
        },
      ],
      action_items: [],
    },
  );
  assert.equal((html.match(/What needs follow-through\?/g) || []).length, 1);
  assert.match(html, /Confirm reserve/);
  assert.doesNotMatch(html, /No actions were recorded against this report/);
});

test("broker PDF summary keeps Top 10, aggregates only display remainder, and always shows Unknown", () => {
  const snapshot = buildManagementFixture();
  const sourceRows = Array.from({ length: 12 }, (_, index) => ({
    name: `Broker ${String(index + 1).padStart(2, "0")}`,
    bucket_type: "source_value",
    open_claims: 12 - index,
    percentage_basis_points: 750,
    new_this_period: 0,
    over_60_days: 1,
    known_outstanding_exposure: 100,
    excluded_financial_claim_count: 0,
  }));
  sourceRows.push({
    name: "Unknown / Unmapped",
    bucket_type: "unknown",
    open_claims: 1,
    percentage_basis_points: 1000,
    new_this_period: 0,
    over_60_days: 0,
    known_outstanding_exposure: 0,
    excluded_financial_claim_count: 0,
  });
  snapshot.metrics.brokerage_distribution.value = {
    rows: sourceRows,
    total_open_claims: sourceRows.reduce((sum, row) => sum + row.open_claims, 0),
    percentage_basis_points_total: 10000,
    known_outstanding_exposure_total: 1200,
  };
  snapshot.metrics.brokerage_distribution.details = {
    top_n_cutoff_tie: { claim_count: 3, values_beyond_cutoff: 2 },
    collision_warnings: [{ values: ["GrowthHouse", "Growthhouse"], kind: "case_insensitive" }],
  };
  const html = renderClaimsReportHtml(
    { report_type: "weekly", status: "finalised", metrics_snapshot: snapshot },
    { available: true, attention_items: [], action_items: [] },
  );
  assert.match(html, /Broker 01/);
  assert.match(html, /Broker 10/);
  assert.doesNotMatch(html, /Broker 11|Broker 12/);
  assert.match(html, /Unknown \/ Unmapped/);
  assert.match(html, />Other \(2 values\)</);
  assert.match(html, /Top 10 cutoff splits a tie at 3 claims/);
  assert.match(html, /GrowthHouse \/ Growthhouse/);
  assert.match(html, /Exact source values remain separate; no consolidation is applied/);
});
