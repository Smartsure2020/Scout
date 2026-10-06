import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimsReportPdfViewModel,
  PDF_TEMPLATE_VERSION,
  renderClaimsReportHtml,
  renderClaimsReportPdfFooterTemplate,
  renderClaimsReportPdfHeaderTemplate,
  reportPdfFilename,
} from "./claims-report-pdf.mjs";
import {
  SCORECARD_ROLE_LABELS,
  describeCardinalAgeCheck,
  summariseScorecardAlerts,
} from "./handler-scorecards.mjs";

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
        unknown: 3,
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
  assert.match(first, /<th scope="row">Compliant<\/th>/);
  assert.match(first, /<th scope="row">Breached<\/th>/);
  assert.match(first, /Unmapped status/);
  assert.match(first, /Age\/SLA unavailable/);
  assert.match(first, /Total open claims/);
  assert.match(first, /SLA denominator/);
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
  assert.match(
    renderClaimsReportPdfFooterTemplate(),
    new RegExp(PDF_TEMPLATE_VERSION),
  );
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

test("weekly PDF formats a cross-month period with both month names", () => {
  const run = fixtureRun();
  run.metrics_snapshot.period_start_local_date = "2026-09-28";
  run.metrics_snapshot.period_end_local_date = "2026-10-03";
  const view = buildClaimsReportPdfViewModel(run, workflowFixture());
  assert.equal(view.periodLabel, "28 Sep - 2 Oct 2026");
  assert.match(
    renderClaimsReportHtml(run, { available: true }),
    /28 Sep - 2 Oct 2026/,
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

test("PDF explains unresolved financial aggregation counts", () => {
  const run = fixtureRun();
  run.metrics_snapshot.metrics.financial_open_outstanding = {
    value: null,
    availability: "unavailable",
    details: {
      reason: "financial_aggregation_unresolved",
      unresolved_parent_count: 2,
    },
  };
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(
    html,
    /Unavailable — 2 multi-row claims contain conflicting section-level values\./,
  );
});

test("PDF pagination reserves header and footer areas for table rows", () => {
  const html = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.match(html, /@page \{ size: A4 landscape; margin: 14mm 12mm 15mm; \}/);
  assert.match(html, /body \{ padding: 0; \}/);
  assert.doesNotMatch(html, /\.page-header|\.page-footer|position:\s*fixed/);
  assert.match(html, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(
    html,
    /\.operational-section \{ break-inside: avoid; page-break-inside: avoid; \}/,
  );
  assert.match(
    html,
    /\.operational-table \{ break-inside: auto; page-break-inside: auto; \}/,
  );
  assert.match(
    html,
    /\.operational-table thead \{ display: table-header-group; break-inside: avoid; page-break-inside: avoid; \}/,
  );
});

test("PDF pagination repeats table headers at page breaks and keeps section headings with content", () => {
  const html = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(
    html,
    /thead tr \{ break-inside: avoid; page-break-inside: avoid; \}/,
  );
  assert.match(
    html,
    /\.report-section > \.section-kicker \{ break-after: avoid; page-break-after: avoid; \}/,
  );
  assert.match(
    html,
    /h2 \{ margin-bottom: 3mm; font-size: 16px; line-height: 1\.15; break-after: avoid; page-break-after: avoid; \}/,
  );
  assert.match(html, /\.report-section \{ break-inside: auto;/);
  assert.doesNotMatch(
    html,
    /@media print \{ \.report-section \{ break-inside: avoid;/,
  );
});

test("PDF running header and footer use native print-margin templates", () => {
  const run = fixtureRun();
  const workflow = { available: true };
  const header = renderClaimsReportPdfHeaderTemplate(run, workflow);
  const footer = renderClaimsReportPdfFooterTemplate();

  assert.match(header, /SCOUT \/ CLAIMS MANAGEMENT/);
  assert.ok(
    header.includes(buildClaimsReportPdfViewModel(run, workflow).periodLabel),
  );
  assert.match(header, /height:8mm;padding:2mm 12mm 0;box-sizing:border-box/);
  assert.match(header, /line-height:10px/);
  assert.match(header, /<table style="width:100%;border-collapse:collapse">/);
  assert.match(footer, /claims-management-pdf-v9/);
  assert.match(footer, /padding:0 12mm;box-sizing:border-box/);
  assert.match(footer, /class="pageNumber"/);
  assert.match(footer, /class="totalPages"/);
});

function scorecardCard(overrides) {
  const card = {
    key: `roster:${overrides.label.toLowerCase()}`,
    role: "handler",
    gross_registered: 0,
    new_allocated: 0,
    over_60: 0,
    over_91: 0,
    oldest_open_age_days: null,
    cardinal_age_disagreements: 0,
    over_60_by_cardinal_age: 0,
    flags: [],
    previous: null,
    ...overrides,
  };
  const severities = card.flags.map((flag) => flag.severity);
  card.role_label = SCORECARD_ROLE_LABELS[card.role];
  card.action = severities.includes("critical")
    ? "allocate"
    : severities.includes("warning")
      ? "confirm"
      : "none";
  card.action_label = {
    allocate: "Allocate correct handler",
    confirm: "Confirm ownership",
    none: "No action",
  }[card.action];
  return card;
}

function scorecardRun() {
  const run = fixtureRun();
  const value = {
    definitions: {
      gross_registered: "Open claims held by the handler.",
      new_allocated: "Claims registered inside the period.",
      over_60: "Open claims 60+ days since registration.",
    },
    cards: [
      scorecardCard({
        label: "Lucky",
        gross_registered: 130,
        new_allocated: 4,
        over_60: 52,
        over_91: 30,
        oldest_open_age_days: 312,
        previous: { gross_registered: 128, new_allocated: 6, over_60: 50 },
      }),
      scorecardCard({ label: "Sarah", gross_registered: 0 }),
      scorecardCard({
        label: "Nicole",
        role: "claims_administrator",
        gross_registered: 2,
        flags: [
          {
            code: "registration_account_holds_claims",
            severity: "critical",
            message:
              "2 open claims are still allocated to Nicole (claims administrator). The correct handler must be allocated.",
          },
        ],
      }),
      scorecardCard({
        label: "Lesire",
        role: "former_handler",
        gross_registered: 1,
        flags: [
          {
            code: "former_handler_open_claims",
            severity: "warning",
            message: "1 open claim sits with Lesire. Confirm ownership.",
          },
        ],
      }),
    ],
    totals: {
      gross_registered: 133,
      new_allocated: 4,
      over_60: 52,
      over_91: 30,
      previous: { gross_registered: 130, new_allocated: 6, over_60: 50 },
    },
  };
  value.alerts = summariseScorecardAlerts(value.cards);
  run.metrics_snapshot.metrics.handler_scorecards = available(value);
  run.metrics_snapshot.metrics.claims_left_extract = available(15);
  return run;
}

test("scorecard report leads with handler cards in the manual report's three figures", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  for (const label of [
    "Total Gross Registered",
    "New Allocated Claims",
    "Over 60 Days",
    "Claims Performance",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /<h3>Lucky<\/h3>/);
  assert.match(html, /<h3>Sarah<\/h3>/);
  assert.match(html, /Claims administrator/);
  assert.match(html, /Former handler/);
  assert.match(html, /\+2 vs previous/);
  assert.match(html, /Oldest open: <strong>312 days<\/strong>/);
  // Order follows the manual report: cards, then queries, then recommendations.
  const order = [
    "Claims Performance",
    "Claims Queries &amp; Management Attention",
    "Recommendations &amp; Action Plan",
    "Claims Movement",
    "Coverage &amp; Methodology",
  ].map((heading) => html.indexOf(`<h2>${heading}`));
  assert.ok(order.every((index) => index > 0), "every heading renders");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /<table class="management-table handler-table"/);
  assert.match(html, /not a measure of handler performance/);
});

test("scorecard report shows a red allocation alert and lists non-handler holders in a table", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  assert.match(html, /alert-box critical/);
  assert.match(html, /correct handler must be allocated/i);
  assert.match(html, /alert-box warning/);
  assert.match(html, /<h3 class="holders-heading">Other claim holders<\/h3>/);
  assert.match(html, /<th scope="row">Nicole<\/th><td>Claims administrator<\/td>/);
  assert.match(html, /status-pill critical">Allocate correct handler/);
  assert.match(html, /status-pill warning">Confirm ownership/);
  // Administrator / former-handler claims are never presented as a handler card.
  assert.doesNotMatch(html, /<h3>Nicole<\/h3>/);
  assert.doesNotMatch(html, /<h3>Lesire<\/h3>/);
});

test("scorecard report leads with the cards instead of repeating them as an executive KPI row", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  assert.doesNotMatch(html, /<h2>Executive Summary<\/h2>/);
  assert.match(html, /<div class="team-total"><strong>Team total<\/strong>/);
  assert.match(html, /Terminal closures <b>5<\/b>/);
  assert.match(html, /Left the extract <b>15<\/b> <small>not closures<\/small>/);
  assert.ok(
    html.indexOf("Claims Performance") < html.indexOf("Claims Movement"),
    "cards precede the supporting detail",
  );
  assert.match(html, /Handler scorecard definitions/);
});

test("over-60 movement is coloured by direction and other movement stays neutral", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  // Over 60 went 50 -> 52 (worse); gross 128 -> 130 is neutral.
  assert.match(html, /hc-delta bad">\+2 vs previous/);
  assert.match(html, /hc-delta flat">\+2 vs previous/);
});

test("scorecard text from a handler name is escaped", () => {
  const run = scorecardRun();
  run.metrics_snapshot.metrics.handler_scorecards.value.cards[0].label =
    "<img src=x onerror=alert(1)>";
  const html = renderClaimsReportHtml(run, { available: true });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("reports finalised before scorecards existed keep the handler table layout", () => {
  const html = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.doesNotMatch(html, /<h2>Claims Performance/);
  assert.match(html, /<table class="management-table handler-table"/);
  assert.match(html, /SLA compliance/);
});

test("the final section carries no trailing margin that could spill an empty page", () => {
  const html = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.match(html, /\.report-section:last-child \{ margin-bottom: 0; \}/);
  assert.match(
    html,
    /\.report-section:last-child \.two-column > div > :last-child \{ margin-bottom: 0; \}/,
  );
});

function grouped(run) {
  run.metrics_snapshot.metrics.handler_scorecards.value.cards.forEach((card) => {
    card.aliases = [card.label];
  });
  run.metrics_snapshot.metrics.handler_scorecards.value.cards[0].aliases = [
    "Lucky",
    "Lucky Mokgomo",
  ];
  return run;
}

test("queries are grouped per handler by the exact Cardinal string, with active handlers always listed", () => {
  const run = grouped(scorecardRun());
  const html = renderClaimsReportHtml(run, {
    available: true,
    attention_items: [
      {
        id: "q1",
        title_snapshot: "Hollard payment query",
        claim_number_snapshot: "C-1",
        handler_snapshot: "Lucky Mokgomo",
        category_snapshot: "complaint",
        status_snapshot: "open",
        owner_display_snapshot: "Bev",
      },
      {
        id: "q2",
        title_snapshot: "Portfolio level item",
        category_snapshot: "operational",
        status_snapshot: "open",
      },
      {
        id: "q3",
        title_snapshot: "Claim held by a stranger",
        handler_snapshot: "Somebody Else",
        category_snapshot: "other",
        status_snapshot: "open",
      },
    ],
    action_items: [],
  });
  assert.match(html, /<h3>Lucky<small>Claims handler · 1 query<\/small><\/h3>/);
  assert.match(html, /<h3>Sarah<small>Claims handler · 0 queries<\/small><\/h3>/);
  assert.match(html, /No queries recorded for this handler\./);
  assert.match(html, /<h3>Portfolio &amp; management items<small>/);
  assert.match(html, /<h3>Somebody Else<small>Unrecognised handler · 1 query<\/small><\/h3>/);
  // Group order follows the scorecards: Lucky before Sarah before others.
  assert.ok(html.indexOf("<h3>Lucky<small>") < html.indexOf("<h3>Sarah<small>"));
  assert.ok(html.indexOf("<h3>Sarah<small>") < html.indexOf("<h3>Somebody Else<small>"));
  assert.ok(html.indexOf("<h3>Somebody Else<small>") < html.indexOf("<h3>Portfolio &amp; management items<small>"));
});

test("a first name alone never claims an item for a handler", () => {
  const run = grouped(scorecardRun());
  run.metrics_snapshot.metrics.handler_scorecards.value.cards[0].aliases = ["Lucky Mokgomo"];
  const html = renderClaimsReportHtml(run, {
    available: true,
    attention_items: [
      { id: "q", title_snapshot: "Query", handler_snapshot: "Lucky", category_snapshot: "other", status_snapshot: "open" },
    ],
    action_items: [],
  });
  assert.match(html, /<h3>Lucky<small>Unrecognised handler · 1 query<\/small><\/h3>/);
});

test("report follows the agreed page structure with forced page breaks", () => {
  const html = renderClaimsReportHtml(grouped(scorecardRun()), {
    available: true,
    attention_items: [],
    action_items: [
      { id: "a1", action_snapshot: "Fix Cardinal ticket", category_snapshot: "system", status_snapshot: "open" },
      { id: "a2", action_snapshot: "Chase insurer", category_snapshot: "insurer", status_snapshot: "open" },
      { id: "a3", action_snapshot: "Weekly 1:1s", category_snapshot: "team", status_snapshot: "open" },
    ],
  });
  const at = (heading) => html.indexOf(`<h2>${heading}`);
  const order = [
    "Claims Performance",
    "Claims Queries &amp; Management Attention",
    "Recommendations &amp; Action Plan",
    "Supporting Intelligence",
    "Claims Movement",
    "Financial Position",
    "Operational Health",
    "SLA: Claim Age vs Status Threshold",
    "Coverage &amp; Methodology",
  ].map(at);
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const cls of ["queries-section", "actions-section", "supporting-intro"])
    assert.match(html, new RegExp(`report-section ${cls} page-break`));
  assert.match(html, /\.page-break \{ break-before: page; page-break-before: always; \}/);
  // Ownership issues lead the recommendations page; actions are themed.
  assert.match(html, /<h3>Ownership issues detected by Scout<\/h3>/);
  assert.match(html, /<h3>Cardinal &amp; system<small>1 action<\/small><\/h3>/);
  assert.match(html, /<h3>Queries with insurers, brokers &amp; suppliers<small>1 action<\/small><\/h3>/);
  assert.match(html, /<h3>Notes &amp; management<small>1 action<\/small><\/h3>/);
  assert.match(html, /SLA status is a supporting indicator, not a handler-performance measure/);
});

test("methodology states open-claims-only, the allocation attribution rule and the Cardinal Age QA status", () => {
  const run = scorecardRun();
  const value = run.metrics_snapshot.metrics.handler_scorecards.value;
  value.definitions = {
    gross_registered: "The current open book held by the handler: open claims only.",
    new_allocated: "Open claims whose Claim Registered date falls inside the report period, attributed to the handler shown on the accepted closing Cardinal extract.",
    over_60: "Open claims registered more than 60 calendar days before the closing extract.",
  };
  const disagree = { compared: 100, unavailable: 0, disagreements: 3, over_60_by_cardinal_age: 40, status: "disagreements" };
  value.cardinal_age_check = { ...disagree, summary: describeCardinalAgeCheck(disagree) };
  value.cards[0].cardinal_age_disagreements = 3;
  value.cards[0].over_60_by_cardinal_age = 40;
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /open claims only/);
  assert.match(html, /attributed to the handler shown on the accepted closing Cardinal extract/);
  assert.match(html, /Cardinal Age \(reference only\): Cardinal stops its Age at the Settled Date, so it differs from the registration-date age on 3 of 100 open claims/);
  // Management chose the registration date, so a difference is information, not a card warning.
  assert.doesNotMatch(html, /QA: Cardinal Age gives/);
  assert.match(html, /New claims registered counts every claim registered in the period/);
  const none = { compared: 0, unavailable: 50, disagreements: 0, over_60_by_cardinal_age: 0, status: "unavailable" };
  value.cardinal_age_check = { ...none, summary: describeCardinalAgeCheck(none) };
  assert.match(renderClaimsReportHtml(run, { available: true }), /Cardinal Age \(reference only\): not available for this report/);
});

test("terminal closures and claims that left the extract are reported separately", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  assert.match(html, /<div class="kpi-label">Terminal closures<\/div>/);
  assert.match(html, /<div class="kpi-label">Left the extract \(not closed\)<\/div>/);
  assert.match(html, /Claims that simply disappear from an extract are reported separately as left the extract and are never counted as closed/);
  assert.match(html, /scorecard-layout .compact-grid \{ grid-template-columns: repeat\(5, 1fr\); \}/);
});

test("multi-row claims excluded from financial totals are disclosed, not silently dropped", () => {
  const run = scorecardRun();
  const metrics = run.metrics_snapshot.metrics;
  metrics.financial_open_outstanding = available(1000, { details: { excluded_multi_row_claim_count: 3 } });
  metrics.financial_estimate_total = available(2000, { details: { excluded_multi_row_claim_count: 2 } });
  metrics.financial_paid_total = available(500, { details: { excluded_multi_row_claim_count: 1 } });
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /section amounts are not summed until Cardinal&#39;s section semantics are confirmed: Open outstanding: 3 multi-row claims; Estimate: 2 multi-row claims; Paid: 1 multi-row claim\./);
  // Nothing excluded => no note.
  assert.doesNotMatch(renderClaimsReportHtml(scorecardRun(), { available: true }), /not summed until/);
});

test("unavailable evidence is shown as unavailable, never as zero", () => {
  const run = scorecardRun();
  const metrics = run.metrics_snapshot.metrics;
  metrics.no_movement_over_14 = { value: null, availability: "unavailable", precision: "unavailable" };
  metrics.no_movement_over_30 = { value: null, availability: "unavailable", precision: "unavailable" };
  metrics.operational_health = available({ ...metrics.operational_health.value, repudiation_expired: null });
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /No movement over 14 days<\/div><div class="kpi-value is-unavailable">Data unavailable/);
  assert.match(html, /Repudiation expired is unavailable: it needs the date a claim was repudiated/);
  assert.match(html, /<th scope="row">Repudiation expired<\/th><td class="numeric">-<\/td>/);
});

test("SLA is presented as claim age versus status threshold", () => {
  const html = renderClaimsReportHtml(scorecardRun(), { available: true });
  assert.match(html, /<h2>SLA: Claim Age vs Status Threshold<\/h2>/);
  assert.match(html, /<div class="sla-caption">Within status threshold<\/div>/);
  const legacy = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.match(legacy, /<h2>SLA Performance<\/h2>/);
});

test("renamed metrics: payment status with zero estimate and High value on Outstanding", () => {
  const run = scorecardRun();
  run.metrics_snapshot.metrics.operational_health = available(
    { assessor_overdue: 0, investigator_overdue: 0, broker_overdue: 0, high_value: 4, legal_recovery: 0, nfo_ombudsman: 0, fraud: 0, repudiation_expired: null },
    { details: { high_value_basis: "outstanding", high_value_threshold: 100000, high_value_excluded_multi_row_claim_count: 2 } },
  );
  const html = renderClaimsReportHtml(run, { available: true });
  assert.match(html, /<div class="kpi-label">Payment status with zero estimate<\/div>/);
  assert.match(html, /<th scope="row">High value \(outstanding\)<\/th><td class="numeric">4<\/td>/);
  assert.match(html, /High value is based on Outstanding of R\s100\s000 or more; the Mandate column is not used\. 2 multi-row claims whose sections straddle the threshold are excluded\./);
  assert.match(html, /payment status with zero estimate|Payment status with zero estimate counts open claims whose status is payment-related and whose estimate is exactly zero; a missing estimate is not zero/);
  assert.doesNotMatch(html, /High value \/ mandate attention/);
  assert.doesNotMatch(html, /Payment request with zero estimate/);
});

test("reports finalised before the split still show their combined High value / mandate key", () => {
  const html = renderClaimsReportHtml(fixtureRun(), { available: true });
  assert.match(html, /High value \/ mandate attention/);
  assert.match(html, /Payment request with zero estimate/);
});

test("PDF never prints an up/down figure beside unavailable data or an unavailable previous value", () => {
  const run = fixtureRun("weekly");
  const snapshot = run.metrics_snapshot;
  // Current value unavailable, but a stale numeric comparison exists.
  snapshot.metrics.assignment_activity = {
    value: 0,
    availability: "unavailable",
    precision: "unavailable",
  };
  snapshot.comparisons.assignment_activity = {
    current: 0,
    previous: 4,
    absolute_delta: -4,
    direction: "decrease",
  };
  // Previous unavailable: the comparison carries a null delta.
  snapshot.comparisons.new_claims_registered = {
    current: 7,
    previous: null,
    absolute_delta: null,
    direction: "unavailable",
    unavailable_reason: "previous_unavailable",
  };
  // Available on both sides keeps its real delta.
  snapshot.comparisons.claims_closed = { absolute_delta: -3 };
  const html = renderClaimsReportHtml(run, { available: true, attention_items: [], action_items: [] });
  const card = (label) => {
    const start = html.indexOf(`<div class="kpi-label">${label}</div>`);
    assert.notEqual(start, -1, `card ${label} present`);
    return html.slice(start, html.indexOf("</article>", start));
  };
  const assignment = card("Claims with assignment activity");
  assert.match(assignment, /Data unavailable/);
  assert.match(assignment, /Comparison unavailable/);
  assert.doesNotMatch(assignment, /vs previous period/);
  const registered = card("New claims registered");
  assert.match(registered, /Comparison unavailable/);
  assert.doesNotMatch(registered, /Unchanged vs previous period/);
  assert.doesNotMatch(registered, /vs previous period/);
  assert.match(card("Claims closed"), /Down 3 vs previous period/);
});
