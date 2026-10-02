import test from "node:test";
import assert from "node:assert/strict";
import { buildReportSnapshot } from "./reporting-metrics.mjs";

const users = [
  {
    id: "handler-1",
    email: "handler@example.test",
    display_name: "Fixture Handler",
    role: "handler",
    active: true,
  },
];

function manifest(id, effectiveDate) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: `${id}-checksum`,
    effective_date: effectiveDate,
    received_at: `${effectiveDate}T12:00:00.000Z`,
    status: "accepted",
    historical_persisted: true,
    claim_count: 1,
    accepted_claim_count: 1,
    quality_summary: {
      completeness_state: "complete",
      comparable_to_previous: true,
      warnings: [],
    },
  };
}

function row(claimNo, index, overrides = {}) {
  return {
    extract_id: "closing",
    claim_id: null,
    identity_key: `cardinal_claims:${claimNo}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${index}`,
    source_row_index: index,
    source_claim_number: claimNo,
    handler_source: "Fixture Handler",
    handler_email: "handler@example.test",
    resolved_scout_user_id: "handler-1",
    handler_resolution: "resolved",
    status_raw: "Registered",
    status_normalized: "registered",
    terminal: false,
    open: true,
    registered_date: "2026-08-01",
    dol_date: "2026-07-20",
    movement_date: null,
    repudiation_date: null,
    source_event_at: null,
    outstanding: 100,
    estimate: 1000,
    paid: 0,
    mandate: 0,
    insurer: "Fixture Insurer",
    peril: "Fixture Peril",
    peril_type: "property",
    insured: `Insured ${claimNo}`,
    description: "Anonymized fixture claim",
    comments: null,
    calendar_age: 26,
    working_age: 15,
    age_band: "0-30",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
    ...overrides,
  };
}

function sourceRows() {
  return [
    row("CASE-A", 0, { outstanding: 0, estimate: 0, paid: 0 }),
    row("CASE-A", 1, { outstanding: 0, estimate: 0, paid: 0 }),
    row("CASE-A", 2, {
      status_raw: "Vendor review pending",
      status_normalized: "vendor review pending",
      data_quality_flags: ["unmapped_status"],
      outstanding: 0,
      estimate: 0,
      paid: 0,
    }),
    row("CASE-B", 3, {
      outstanding: 200,
      estimate: 800,
      paid: 0,
      peril: "Fixture Peril A",
    }),
    row("CASE-B", 4, {
      outstanding: 300,
      estimate: 800,
      paid: 0,
      peril: "Fixture Peril B",
    }),
    row("CASE-C", 5, { outstanding: -2.3e-10, estimate: 1000, paid: 100 }),
    row("CASE-C", 6, { outstanding: 0, estimate: "1000", paid: 200 }),
    row("SINGLE", 7, { outstanding: 1000, estimate: 1500, paid: 0 }),
  ];
}

function build(rows) {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  opening.claim_count = opening.accepted_claim_count = 1;
  closing.claim_count = closing.accepted_claim_count = rows.length;
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      ["opening", [row("OPENING", 0, { extract_id: "opening" })]],
      ["closing", rows],
    ]),
    changes: [],
    activeUsers: users,
  });
}

test("three anonymized production-shaped parents retain safe report metrics", () => {
  const source = sourceRows();
  const before = structuredClone(source);
  const report = build(source);

  assert.deepEqual(source, before, "report generation does not mutate source rows");
  assert.equal(report.metrics.closing_inventory.value, 4);
  const ageing = report.metrics.ageing_distribution.value;
  assert.equal(Object.values(ageing).reduce((sum, value) => sum + value, 0), 4);

  const handlers = report.metrics.handler_performance.value;
  const handlerTotal = handlers.handlers.reduce(
    (sum, item) => sum + item.open_claims,
    handlers.manager_held_other.count + handlers.unassigned_unresolved.count,
  );
  assert.equal(handlerTotal, 4);
  assert.equal(handlers.handlers[0].open_claims, 4);

  const sla = report.metrics.sla_summary.value;
  assert.equal(sla.total_evaluated, 4);
  assert.equal(sla.unknown, 1, "mixed mapped/unmapped child SLA resolves to unavailable");
  assert.equal(sla.denominator, sla.compliant + sla.breached);
  assert.equal(sla.unmapped, 0, "mixed child statuses are not mislabeled as fully unmapped");

  assert.equal(report.metrics.new_claims_registered.value, 0);
  assert.equal(report.metrics.financial_estimate_total.availability, "available");
  assert.equal(report.metrics.financial_estimate_total.value, 3300);
  assert.equal(report.metrics.financial_open_outstanding.availability, "unavailable");
  assert.equal(report.metrics.financial_paid_total.availability, "unavailable");
  assert.equal(report.metrics.zero_estimate_payment_request.availability, "available");
  assert.equal(report.metrics.zero_estimate_payment_request.value, 1);

  const operational = report.metrics.operational_health;
  assert.equal(operational.availability, "available");
  assert.equal(
    operational.value.assessor_overdue,
    0,
    "safe operational categories remain available",
  );
  assert.equal(
    operational.value.high_value_mandate_attention,
    0,
    "non-conflicting low values remain safe for high-value classification",
  );
});

test("an ambiguous high-value predicate hides only that category and regeneration is deterministic", () => {
  const source = sourceRows();
  source[0] = { ...source[0], outstanding: 100 };
  source[1] = { ...source[1], outstanding: 600000 };
  source[2] = { ...source[2], outstanding: 200 };
  const first = build(source);
  const second = build(source);

  assert.deepEqual(first, second);
  assert.equal(first.metrics.operational_health.availability, "available");
  assert.equal(
    first.metrics.operational_health.value.high_value_mandate_attention,
    null,
  );
  assert.equal(first.metrics.operational_health.value.assessor_overdue, 0);
  assert.equal(first.metrics.sla_summary.availability, "available");
  assert.equal(first.metrics.closing_inventory.value, 4);
});
