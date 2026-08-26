import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimsReportPdfViewModel,
  PDF_TEMPLATE_VERSION,
  renderClaimsReportHtml,
  reportPdfFilename,
} from "./claims-report-pdf.mjs";

function available(value, details = {}) {
  return {
    value,
    availability: "available",
    precision: "snapshot_exact",
    ...details,
  };
}

function fixtureRun(reportType = "weekly") {
  const snapshot = {
    report_type: reportType,
    period_start_local_date:
      reportType === "monthly" ? "2026-08-01" : "2026-08-17",
    period_end_local_date:
      reportType === "monthly" ? "2026-09-01" : "2026-08-22",
    timezone: "Africa/Johannesburg",
    coverage_status: "usable_with_warnings",
    coverage: { warnings: ["unresolved_handlers"] },
    metric_definition_version: "claims-reporting-metrics-v3",
    report_schema_version: "claims-report-v1",
    comparisons: { closing_inventory: { absolute_delta: 2 } },
    metrics: {
      opening_inventory: available(18),
      closing_inventory: available(20),
      net_inventory_movement: available(2),
      new_claims_registered: available(7),
      new_claims_first_observed: available(6),
      claims_closed: available(5),
      open_claims_60_plus: available(4),
      open_claims_91_plus: available(2),
      ageing_distribution: available({
        "0-30": 8,
        "31-60": 6,
        "61-90": 4,
        "91+": 2,
        unknown: 0,
      }),
      sla_compliance: available(0.875),
      sla_breaches: available(3),
      sla_summary: available({
        compliant: 14,
        breached: 2,
        unmapped: 1,
        denominator: 16,
      }),
      operational_health: available({
        assessor_overdue: 3,
        investigator_overdue: 2,
        broker_overdue: 1,
        high_value_mandate_attention: 4,
        legal_recovery: 1,
        nfo_ombudsman: 0,
        fraud: 2,
        repudiation_expired: 1,
      }),
      handler_performance: available({
        handlers: Array.from({ length: 12 }, (_, index) => ({
          handler_name: `Handler ${index + 1}`,
          open_claims: index,
          claims_60_plus: index % 4,
          claims_91_plus: index % 3,
          sla_breaches: index % 2,
          no_movement_over_30: index % 3,
          ready_to_close: index % 2,
          reassignments_in: index,
          reassignments_out: index + 1,
        })),
        manager_held_other: { count: 2 },
        unassigned_unresolved: { count: 1 },
      }),
      assignment_activity: available(4, {
        details: { reassignments_in: 4, reassignments_out: 3 },
      }),
      no_movement_over_14: available(8),
      no_movement_over_30: available(4),
      ready_to_close: available(3),
      financial_open_outstanding: available(1250000),
      financial_estimate_total: available(1800000),
      financial_paid_total: available(450000),
    },
  };
  return {
    id: "run-2026-08-17",
    report_type: reportType,
    status: "finalised",
    generated_at: "2026-08-22T09:00:00.000Z",
    generated_by: "manager@example.test",
    finalised_at: "2026-08-22T10:00:00.000Z",
    finalised_by: "manager@example.test",
    metrics_snapshot: snapshot,
  };
}

function workflowFixture() {
  return {
    available: true,
    attention_items: Array.from({ length: 12 }, (_, index) => ({
      id: `attention-${index}`,
      title:
        index === 0
          ? "Frozen <script>alert(1)</script> attention"
          : `Attention ${index}`,
      title_snapshot:
        index === 0
          ? "Frozen <script>alert(1)</script> attention"
          : `Attention ${index}`,
      management_note_snapshot:
        index === 0 ? "Long note ".repeat(30) : "Review required",
      category_snapshot: "operational",
      priority_snapshot: "high",
      owner_display_snapshot: `Owner ${index}`,
      next_action_snapshot: "Call insurer",
      due_date_snapshot: "2026-08-28",
      status: "resolved",
      status_snapshot: "waiting",
      claim_number_snapshot: `CLM-${index}`,
      carried_forward_from_report_id: index === 1 ? "previous-run" : null,
    })),
    action_items: Array.from({ length: 16 }, (_, index) => ({
      id: `action-${index}`,
      action: "Live action should not replace frozen action",
      action_snapshot:
        index === 0 ? "Frozen <strong>action</strong>" : `Action ${index}`,
      category_snapshot: "management",
      owner_display_snapshot: `Owner ${index}`,
      due_date_snapshot: "2026-08-30",
      status: "completed",
      status_snapshot: "waiting",
      resolution_note_snapshot:
        index === 0 ? "Waiting on external response" : null,
      claim_number_snapshot: `CLM-A-${index}`,
    })),
  };
}

test("weekly PDF HTML is deterministic, escaped, complete, and snapshot-bound", () => {
  const run = fixtureRun();
  const workflow = workflowFixture();
  const first = renderClaimsReportHtml(run, workflow);
  const second = renderClaimsReportHtml(run, workflow);

  assert.equal(first, second);
  assert.match(first, /Weekly Claims Report/);
  assert.match(first, /Executive Summary/);
  assert.match(first, /Claims Movement/);
  assert.match(first, /Management Ageing/);
  assert.match(first, /SLA Performance/);
  assert.match(first, /Operational Health/);
  assert.match(first, /Handler Performance/);
  assert.match(first, /Activity &amp; Changes/);
  assert.match(first, /Financial Position/);
  assert.match(first, /Management Attention/);
  assert.match(first, /Action Plan/);
  assert.match(first, /Coverage &amp; Methodology/);
  assert.match(first, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first, /<script>alert/);
  assert.match(first, /Data unavailable/);
  assert.match(first, />0<\/td>/);
  assert.match(first, /Waiting/);
  assert.doesNotMatch(first, /Frozen <strong>action<\/strong>/);
  assert.match(first, /Frozen &lt;strong&gt;action&lt;\/strong&gt;/);
  assert.match(first, /Long note Long note/);
  assert.match(first, /Carried forward/);
  assert.match(first, new RegExp(PDF_TEMPLATE_VERSION));
  assert.doesNotMatch(
    first,
    /insured|source_claim_number|attention-0|action-0/i,
  );
  assert.doesNotMatch(first, /manager@example\.test/);
});

test("monthly PDF uses the monthly snapshot period and official filename", () => {
  const run = fixtureRun("monthly");
  const view = buildClaimsReportPdfViewModel(run, workflowFixture());
  assert.equal(view.periodLabel, "August 2026");
  assert.equal(
    reportPdfFilename(run),
    "Scout-Monthly-Claims-Report-2026-08-01.pdf",
  );
  assert.match(
    renderClaimsReportHtml(run, { available: true }),
    /Monthly Claims Report/,
  );
});

test("zero stays zero and unavailable values never become zero", () => {
  const run = fixtureRun();
  run.metrics_snapshot.metrics.financial_paid_total = {
    value: null,
    availability: "unavailable",
  };
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /Data unavailable/);
  assert.match(html, /<td class="numeric">0<\/td>/);
});
