import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessReports,
  createReportState,
  createReportingApi,
  defaultReportPeriodStart,
  formatComparison,
  formatPercent,
  formatPeriodLabel,
  formatRand,
  isReportPeriodInProgress,
  latestReportPeriodStart,
  metricState,
  normalizeReport,
  reportPeriodStartForDate,
  reportSnapshot,
  resolveReportLifecycle,
  ReportsController,
  shiftReportPeriod,
  unavailableMetricText,
} from "../scout-smartsure/claims/reporting-ui.mjs";

function reportDocument() {
  const root = { innerHTML: "", addEventListener() {} };
  return {
    getElementById(id) {
      return id === "reports-content" ? root : null;
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    root,
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("Reports access is limited to manager and admin roles", () => {
  assert.equal(canAccessReports("manager"), true);
  assert.equal(canAccessReports("admin"), true);
  assert.equal(canAccessReports("handler"), false);
  assert.equal(canAccessReports("viewer"), false);
});

test("report period defaults use Johannesburg reporting periods", () => {
  const now = new Date("2026-08-25T10:00:00+02:00");
  assert.equal(defaultReportPeriodStart("weekly", now), "2026-08-17");
  assert.equal(defaultReportPeriodStart("monthly", now), "2026-08-01");
  assert.equal(shiftReportPeriod("weekly", "2026-08-17", 1), "2026-08-24");
  assert.equal(shiftReportPeriod("monthly", "2026-08-01", -1), "2026-07-01");
});

test("period labels stay human-friendly and local", () => {
  assert.equal(
    formatPeriodLabel({
      report_type: "weekly",
      period_start_local_date: "2026-08-17",
      period_end_local_date: "2026-08-22",
    }),
    "17–21 Aug 2026",
  );
  assert.equal(
    formatPeriodLabel({
      report_type: "monthly",
      period_start_local_date: "2026-08-01",
      period_end_local_date: "2026-09-01",
    }),
    "August 2026",
  );
});

test("zero remains zero while unavailable remains an unavailable state", () => {
  const snapshot = {
    metrics: {
      zero_metric: {
        value: 0,
        availability: "available",
        precision: "snapshot_exact",
      },
      unavailable_metric: {
        value: null,
        availability: "unavailable",
        precision: "unavailable",
        coverage_warnings: ["payment_event_semantics_unavailable"],
      },
    },
  };
  assert.deepEqual(metricState(snapshot, "zero_metric"), {
    metric: snapshot.metrics.zero_metric,
    available: true,
    value: 0,
    precision: "snapshot_exact",
    reason: "Not available",
    drillable: true,
  });
  assert.equal(metricState(snapshot, "unavailable_metric").available, false);
  assert.equal(metricState(snapshot, "unavailable_metric").value, null);
});

test("financial ambiguity is explained on unavailable report metrics", () => {
  assert.equal(
    unavailableMetricText({
      details: {
        reason: "financial_aggregation_unresolved",
        unresolved_parent_count: 2,
      },
    }),
    "Unavailable — 2 multi-row claims contain conflicting section-level values.",
  );
});

test("on-screen SLA breakdown exposes all six required populations", () => {
  const controller = new ReportsController({ document: reportDocument() });
  const html = controller.renderSla({
    metrics: {
      sla_compliance: {
        value: 0.75,
        availability: "available",
        precision: "snapshot_exact",
      },
      sla_breaches: {
        value: 1,
        availability: "available",
        precision: "snapshot_exact",
      },
      sla_summary: {
        value: {
          compliant: 3,
          breached: 1,
          unmapped: 2,
          unknown: 4,
          total_evaluated: 10,
          denominator: 4,
        },
        availability: "available",
        precision: "snapshot_exact",
      },
    },
  });
  for (const label of [
    "Compliant claims",
    "Breached claims",
    "Unmapped statuses",
    "Age/SLA unavailable",
    "Total open claims",
    "SLA denominator",
  ]) assert.ok(html.includes(label), `missing ${label}`);
  for (const value of ["3", "1", "2", "4", "10", "4"])
    assert.ok(html.includes(value), `missing SLA value ${value}`);
});

test("management formatting is restrained", () => {
  assert.equal(formatRand(4832115), "R 4 832 115");
  assert.equal(formatPercent(0.9142857), "91.4%");
  assert.equal(
    formatComparison({ absolute_delta: 0.036 }, "percent"),
    "↑ 3.6 pts",
  );
  assert.equal(
    formatComparison({ absolute_delta: -12 }, "integer"),
    "↓ 12 vs previous period",
  );
  assert.equal(
    formatComparison({ absolute_delta: null }, "integer"),
    "Comparison unavailable",
  );
});

test("claim-linked Management Attention opens with context and confirms its saved item", async () => {
  const document = reportDocument();
  const controller = new ReportsController({
    document,
    getContext: () => ({ user: { role: "manager" }, freshness: null }),
  });
  controller.api = {
    async listAttention() {
      return { items: [] };
    },
    async createAttention() {
      return { item: { id: "attention-1", claim_number: "CLM-1", title: "Review" } };
    },
  };

  await controller.openAttentionFromClaim({ claimNo: "CLM-1", claimId: "claim-1" });
  assert.equal(controller.state.activeTab, "weekly");
  assert.equal(controller.state.workflowForm.claimNumber, "CLM-1");
  assert.equal(controller.state.workflowForm.claimId, "claim-1");
  assert.match(document.root.innerHTML, /Add Management Attention/);

  const values = {
    title: "Review",
    managementNote: "Escalate before Friday",
    category: "operational",
    priority: "high",
    ownerUserId: "",
    nextAction: "Review",
    dueDate: "2026-09-04",
    status: "open",
    claimId: "claim-1",
    sourceClaimNumber: "CLM-1",
  };
  const form = {
    dataset: { workflowForm: "attention" },
    elements: { namedItem: (name) => ({ value: values[name] || "" }) },
    closest() {
      return this;
    },
  };
  await controller.handleSubmit({ target: form, preventDefault() {} });
  assert.equal(controller.state.workflowSuccess.item.id, "attention-1");
  assert.match(document.root.innerHTML, /View Management Attention item/);
});

test("persisted report responses use the frozen metrics snapshot", () => {
  const run = {
    id: "run-1",
    status: "finalised",
    metrics_snapshot: { metrics: { closing_inventory: { value: 12 } } },
  };
  assert.equal(reportSnapshot(run).metrics.closing_inventory.value, 12);
  assert.equal(normalizeReport(run).run.id, "run-1");
  assert.throws(
    () => normalizeReport({ id: "broken", status: "draft" }),
    /incomplete report/,
  );
});

test("reporting API uses bearer authentication and the Phase 3 routes", async () => {
  const calls = [];
  const api = createReportingApi({
    baseUrl: "https://reports.example.workers.dev/",
    getToken: () => "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ report: { id: "run-1" }, claims: [] });
    },
  });

  await api.listReports();
  await api.generateReport("weekly", "2026-08-17");
  await api.getReport("run-1");
  await api.regenerateReport("run-1");
  await api.generateReport("weekly", "2026-08-17", { allowCompatibleUpgrade: true });
  await api.regenerateReport("run-1", { allowCompatibleUpgrade: true });
  await api.finaliseReport("run-1");
  await api.archiveReport("run-1");
  await api.metricClaims("run-1", "no_movement_over_30");

  assert.equal(calls[0].url, "https://reports.example.workers.dev/reports");
  assert.equal(
    calls[1].url,
    "https://reports.example.workers.dev/reports/generate",
  );
  assert.equal(JSON.parse(calls[1].options.body).scope.kind, "team");
  assert.equal(JSON.parse(calls[1].options.body).allowCompatibleUpgrade, false);
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.parse(calls[4].options.body).allowCompatibleUpgrade, true);
  assert.equal(JSON.parse(calls[5].options.body).allowCompatibleUpgrade, true);
  assert.equal(
    calls.at(-1).url,
    "https://reports.example.workers.dev/reports/run-1/metrics/no_movement_over_30/claims",
  );
});

test("older drafts require confirmation before the UI sends an upgrade flag", async () => {
  const draft = {
    id: "older-draft",
    report_type: "weekly",
    period_start_local_date: "2026-10-12",
    status: "draft",
    metric_definition_version: "claims-reporting-metrics-v4",
    report_schema_version: "scout-report-v4",
    serving_report_engine_version: "claims-report-engine-v5",
  };
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({ user: { role: "manager" } }),
  });
  controller.state.reports = [draft];
  controller.state.selected = draft;
  controller.state.activeTab = "weekly";
  controller.state.periodStarts.weekly = "2026-10-12";
  const requests = [];
  const confirmations = [];
  controller.api = {
    generateReport: async (...args) => requests.push(["generate", ...args]),
    regenerateReport: async (...args) => requests.push(["regenerate", ...args]),
  };
  controller.perform = async (_label, action) => action();
  controller.confirm = async (action) => {
    confirmations.push(action);
    return true;
  };

  await controller.generate();
  await controller.regenerate();
  assert.deepEqual(confirmations, ["upgrade", "upgrade"]);
  assert.equal(requests[0][3].allowCompatibleUpgrade, true);
  assert.equal(requests[1][2].allowCompatibleUpgrade, true);

  controller.confirm = async () => false;
  await controller.generate();
  assert.equal(requests.length, 2);

  const currentDraft = {
    ...draft,
    metric_definition_version: "claims-reporting-metrics-v5",
    report_schema_version: "scout-report-v5",
  };
  controller.state.selected = currentDraft;
  controller.state.reports = [currentDraft];
  controller.confirm = async (action) => {
    confirmations.push(action);
    return true;
  };
  await controller.regenerate();
  assert.equal(confirmations.at(-1), "regenerate");
  assert.equal(requests.at(-1)[2].allowCompatibleUpgrade, false);
});

test("reporting API downloads an official PDF as a blob without JSON parsing", async () => {
  const calls = [];
  const pdf = new Blob(["%PDF-test"], { type: "application/pdf" });
  const api = createReportingApi({
    baseUrl: "https://reports.example.workers.dev",
    getToken: () => "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async blob() {
          return pdf;
        },
      };
    },
  });

  const result = await api.exportReportPdf("run-1");
  assert.equal(result, pdf);
  assert.equal(
    calls[0].url,
    "https://reports.example.workers.dev/reports/run-1/pdf",
  );
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
});

test("reporting API exposes manager workflow routes with the same bearer boundary", async () => {
  const calls = [];
  const api = createReportingApi({
    baseUrl: "https://reports.example.workers.dev",
    getToken: () => "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ users: [], items: [], item: { id: "item-1" } });
    },
  });

  await api.listWorkflowUsers();
  await api.listAttention({ status: "waiting", claimNumber: "CLM-1" });
  await api.createAttention({
    title: "A",
    category: "operational",
    priority: "high",
  });
  await api.resolveAttention("item-1", "Resolved after review");
  await api.addReportAttention("run-1", "item-1");
  await api.removeReportAttention("run-1", "item-1");
  await api.listActions({ status: "waiting" });
  await api.createAction({ action: "Call insurer", category: "insurer" });
  await api.completeAction("action-1", "Done");
  await api.addReportAction("run-1", "action-1");
  await api.removeReportAction("run-1", "action-1");

  assert.equal(
    calls[0].url,
    "https://reports.example.workers.dev/management-workflow/users",
  );
  assert.match(
    calls[1].url,
    /management-attention\?status=waiting&claimNumber=CLM-1/,
  );
  assert.equal(
    calls.at(-1).url,
    "https://reports.example.workers.dev/reports/run-1/actions/action-1",
  );
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer test-token");
});

test("frontend state has separate weekly, monthly and history contexts", () => {
  const state = createReportState(new Date("2026-08-25T10:00:00+02:00"));
  assert.equal(state.activeTab, "weekly");
  assert.equal(state.reportOriginTab, null);
  assert.equal(state.periodStarts.weekly, "2026-08-17");
  assert.equal(state.periodStarts.monthly, "2026-08-01");
  assert.equal(state.primaryPeriodStarts.weekly, "2026-08-17");
  assert.equal(state.primaryPeriodStarts.monthly, "2026-08-01");
  assert.deepEqual(state.reports, []);
  assert.equal(state.historyLoaded, false);
});

test("Reports history restores History on Back and the same detail on Forward", async () => {
  const document = reportDocument();
  const entries = [{
    url: "/claims/?view=reports&reportTab=weekly",
    route: { reportTab: "weekly", report: "" },
  }];
  let cursor = 0;
  const syncUrlState = ({ reportTab, report }, options = {}) => {
    const route = { reportTab, report: report || "" };
    const url = `/claims/?view=reports&reportTab=${encodeURIComponent(reportTab)}${report ? `&report=${encodeURIComponent(report)}` : ""}`;
    const entry = { url, route };
    if (options.replace) entries[cursor] = entry;
    else {
      entries.splice(cursor + 1);
      entries.push(entry);
      cursor += 1;
    }
  };
  const controller = new ReportsController({
    document,
    syncUrlState,
    getContext: () => ({ user: { role: "manager" }, freshness: null }),
  });
  controller.api = {
    async getReport() {
      return {
        report: {
          id: "monthly-draft",
          report_type: "monthly",
          status: "draft",
          period_start_local_date: "2026-09-01",
          period_end_local_date: "2026-10-01",
          metrics_snapshot: { metrics: {} },
        },
      };
    },
  };

  controller.open("history");
  assert.equal(controller.state.activeTab, "history");
  assert.equal(entries[cursor].url, "/claims/?view=reports&reportTab=history");

  await controller.openReport("monthly-draft");
  assert.equal(controller.state.activeTab, "monthly");
  assert.equal(controller.state.selected.id, "monthly-draft");
  assert.equal(entries[cursor].url, "/claims/?view=reports&reportTab=history&report=monthly-draft");

  cursor -= 1;
  await controller.openFromRoute(entries[cursor].route.reportTab, entries[cursor].route.report);
  assert.equal(controller.state.activeTab, "history");
  assert.equal(controller.state.selected, null);

  cursor += 1;
  await controller.openFromRoute(entries[cursor].route.reportTab, entries[cursor].route.report);
  assert.equal(controller.state.activeTab, "monthly");
  assert.equal(controller.state.selected.id, "monthly-draft");

  controller.open("weekly", { syncUrl: false });
  assert.equal(controller.state.activeTab, "weekly");
  controller.open("monthly", { syncUrl: false });
  assert.equal(controller.state.activeTab, "monthly");
  assert.equal(controller.state.selected, null);
});

test("API failures are surfaced to the reporting layer instead of becoming zero-valued data", async () => {
  const api = createReportingApi({
    baseUrl: "https://reports.example.workers.dev",
    getToken: () => "test-token",
    fetchImpl: async () =>
      response({ error: "relation scout_report_runs does not exist" }, 500),
  });
  await assert.rejects(
    api.listReports(),
    (error) => error.code === "REPORTING_UNAVAILABLE",
  );
});

test("report claim rows carry the parent identifier into workflow, including NULL claim_id (v2)", async () => {
  function make() {
    const controller = new ReportsController({
      document: reportDocument(),
      getContext: () => ({ user: { role: "manager" }, freshness: null }),
    });
    controller.state.selected = { report_type: "weekly" };
    controller.render = () => {};
    controller.loadPeriodReport = async () => {};
    controller.api = { listAttention: async () => ({ items: [] }) };
    return controller;
  }

  // Canonical parent (single-row or future shared-parent): claim_id is a UUID.
  const canonical = make();
  await canonical.openAttentionFromClaim({
    claim_id: "canonical-uuid",
    source_claim_number: "SOLO-1",
  });
  assert.equal(canonical.state.workflowForm.claimId, "canonical-uuid");
  assert.equal(canonical.state.workflowForm.claimNumber, "SOLO-1");

  // Old ambiguous multi-section parent: claim_id NULL -> no UUID sent, the
  // explicit source_claim_number carries the parent identity (never parsed from
  // parent_identity_key, never a child UUID).
  const ambiguous = make();
  await ambiguous.openAttentionFromClaim({
    claim_id: null,
    parent_identity_key: "cardinal_claims:MULTI-1",
    source_claim_number: "MULTI-1",
  });
  assert.equal(ambiguous.state.workflowForm.claimId, "");
  assert.equal(ambiguous.state.workflowForm.claimNumber, "MULTI-1");
});

test("formatComparison never shows an up/down figure for an unavailable comparison", () => {
  assert.equal(formatComparison(undefined), "Comparison unavailable");
  assert.equal(
    formatComparison({ absolute_delta: null, direction: "unavailable" }),
    "Comparison unavailable",
  );
  // Even a stale numeric delta is ignored once the comparison says unavailable.
  assert.equal(
    formatComparison({ absolute_delta: -4, direction: "unavailable" }),
    "Comparison unavailable",
  );
  assert.equal(formatComparison({ absolute_delta: 3, direction: "increase" }), "↑ 3 vs previous period");
});

test("report details expose frozen versions and the serving engine", () => {
  const controller = new ReportsController({ document: reportDocument() });
  const html = controller.renderReportDetails({
    metric_definition_version: "claims-reporting-metrics-v3",
    report_schema_version: "scout-report-v3",
    serving_report_engine_version: "claims-report-engine-v3",
    finalised_engine_version: "claims-report-engine-v3",
  }, { metrics: {}, coverage: {} });
  assert.match(html, /claims-reporting-metrics-v3/);
  assert.match(html, /scout-report-v3/);
  assert.match(html, /Serving report engine/);
  assert.match(html, /Finalised by engine/);
});

test("post-settlement open work renders as a distinct drillable management subset", () => {
  const controller = new ReportsController({ document: reportDocument() });
  const html = controller.renderPostSettlementOpenWork({
    metrics: {
      post_settlement_open_work: {
        availability: "available",
        claim_population: { count: 2, claim_ids: ["R", "P"] },
        value: {
          total_open_claim_count: 2,
          categories: [
            {
              key: "recovery_in_progress",
              category: "Recovery in Progress",
              source_status: "AWAITING RECOVERY",
              open_claim_count: 1,
              over_60_days: 1,
              oldest_open_age_days: 120,
              handler_distribution: [
                { label: "Lucky", open_claim_count: 1 },
              ],
            },
            {
              key: "pending_third_party_approach",
              category: "Pending Third-Party Approach",
              source_status: "PENDING APPROACH",
              open_claim_count: 1,
              over_60_days: 0,
              oldest_open_age_days: 30,
              handler_distribution: [
                { label: "Naledi", open_claim_count: 1 },
              ],
            },
          ],
        },
      },
    },
  });
  assert.match(html, /Post-Settlement Open Work/);
  assert.match(html, /Main claim settled; operational recovery \/ third-party work remains open/);
  assert.match(html, /data-metric-id="post_settlement_open_work"/);
  assert.match(html, /data-filter="post-settlement:recovery_in_progress"/);
  assert.match(html, /Settled = False claims.*ordinary open book/);
});

test("latest report defaults use report periods, retain older history, and ignore future or archived runs", async () => {
  const now = new Date("2026-10-16T10:00:00+02:00");
  const reports = [
    { id: "old-week", report_type: "weekly", status: "finalised", period_start_local_date: "2026-10-05" },
    { id: "archived-current-week", report_type: "weekly", status: "archived", period_start_local_date: "2026-10-12" },
    { id: "latest-week", report_type: "weekly", status: "finalised", period_start_local_date: "2026-10-12" },
    { id: "same-week-other-scope", report_type: "weekly", status: "finalised", period_start_local_date: "2026-10-12" },
    { id: "future-week", report_type: "weekly", status: "draft", period_start_local_date: "2026-10-19" },
    { id: "old-month", report_type: "monthly", status: "finalised", period_start_local_date: "2026-09-01" },
    { id: "latest-month", report_type: "monthly", status: "draft", period_start_local_date: "2026-10-01" },
    { id: "archived", report_type: "monthly", status: "archived", period_start_local_date: "2026-10-01" },
  ];
  assert.equal(latestReportPeriodStart(reports, "weekly", now), "2026-10-12");
  assert.equal(latestReportPeriodStart(reports, "monthly", now), "2026-10-01");
  assert.equal(latestReportPeriodStart([], "weekly", now), null);

  const document = reportDocument();
  const controller = new ReportsController({ document, getContext: () => ({ user: { role: "manager" } }), now: () => now });
  const loaded = [];
  controller.api = {
    async listReports() { return { reports }; },
    async getReport(id) {
      loaded.push(id);
      const run = reports.find((report) => report.id === id);
      return { report: { ...run, metrics_snapshot: { metrics: {} } } };
    },
  };
  await controller.loadReports();
  assert.equal(controller.state.selected.id, "latest-week");
  assert.equal(controller.state.periodStarts.weekly, "2026-10-12");
  assert.equal(controller.state.periodStarts.monthly, "2026-10-01");
  controller.state.activeTab = "monthly";
  await controller.loadReports();
  assert.equal(controller.state.selected.id, "latest-month");
  controller.state.activeTab = "history";
  const history = controller.renderHistory();
  assert.match(history, /old-week/);
  assert.match(history, /old-month/);
  assert.match(history, /data-report-id="archived-current-week"/);
  assert.match(history, /data-report-id="same-week-other-scope"/);
  assert.doesNotMatch(history, /data-report-id="latest-week"/);
  assert.doesNotMatch(history, /data-report-id="latest-month"/);
  await controller.openReportWithOptions("old-week", { syncUrl: false, originTab: "history" });
  assert.equal(controller.state.selected.id, "old-week");
  assert.equal(controller.state.periodStarts.weekly, "2026-10-05");
  assert.deepEqual(loaded, ["latest-week", "latest-month", "old-week"]);
  await controller.openFromRoute("history", "latest-week");
  assert.equal(controller.state.selected.id, "latest-week");
});

const lifecycleNow = new Date("2026-10-20T10:00:00+02:00");
const lifecycleFreshness = {
  state: "warning",
  label: "Loaded with warnings",
  extractDate: "2026-10-20",
  extractDateLabel: "20 Oct 2026",
  warningCount: 355,
};

function lifecycleReport({
  id,
  reportType = "weekly",
  status = "finalised",
  periodStart = "2026-10-12",
  coverage = "complete",
} = {}) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const periodEnd = reportType === "weekly"
    ? new Date(start.setUTCDate(start.getUTCDate() + 5)).toISOString().slice(0, 10)
    : "2026-11-01";
  return {
    id,
    report_type: reportType,
    status,
    period_start_local_date: periodStart,
    period_end_local_date: periodEnd,
    period_start: `${periodStart}T00:00:00.000Z`,
    coverage_status: coverage,
    coverage_metadata: { warnings: [] },
    generated_at: "2026-10-20T08:00:00.000Z",
    finalised_at: status === "finalised" ? "2026-10-20T09:00:00.000Z" : null,
    generated_by: "manager@example.com",
  };
}

function lifecycleDetail(run) {
  return {
    ...run,
    metrics_snapshot: {
      report_type: run.report_type,
      period_start_local_date: run.period_start_local_date,
      period_end_local_date: run.period_end_local_date,
      coverage_status: run.coverage_status,
      coverage: { warnings: [] },
      metrics: {},
    },
  };
}

test("accepted extract resolves Weekly to its exact in-progress period without falling back to the latest report", async () => {
  const oldFinalised = lifecycleReport({ id: "week-12-finalised" });
  const olderFinalised = lifecycleReport({
    id: "week-05-finalised",
    periodStart: "2026-10-05",
  });
  const reports = [oldFinalised, olderFinalised];
  const lifecycle = resolveReportLifecycle({
    reports,
    reportType: "weekly",
    freshness: lifecycleFreshness,
    now: lifecycleNow,
  });
  assert.equal(reportPeriodStartForDate("weekly", "2026-10-20"), "2026-10-19");
  assert.equal(lifecycle.periodStart, "2026-10-19");
  assert.equal(lifecycle.state, "not_generated");
  assert.equal(lifecycle.report, null);
  assert.equal(lifecycle.inProgress, true);

  const document = reportDocument();
  const controller = new ReportsController({
    document,
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.api = {
    async listReports() { return { reports }; },
    async getReport() { throw new Error("an older report must not be selected"); },
  };
  await controller.loadReports();

  assert.equal(controller.state.periodStarts.weekly, "2026-10-19");
  assert.equal(controller.state.selected, null);
  assert.match(document.root.innerHTML, /19–23 Oct 2026/);
  assert.match(document.root.innerHTML, /In progress/);
  assert.match(document.root.innerHTML, /No report generated yet/);
  assert.match(document.root.innerHTML, /Generate Weekly Report/);
  assert.match(document.root.innerHTML, /Latest accepted extract: 20 Oct 2026/);

  controller.state.activeTab = "history";
  const history = controller.renderHistory();
  assert.match(history, /data-report-id="week-12-finalised"/);
  assert.match(history, /data-report-id="week-05-finalised"/);
});

test("an exact-period Weekly draft is selected with Draft, Regenerate Draft and permitted Finalise actions", async () => {
  const draft = lifecycleReport({
    id: "week-19-draft",
    status: "draft",
    periodStart: "2026-10-19",
  });
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.api = {
    async listReports() { return { reports: [draft] }; },
    async getReport() { return { report: lifecycleDetail(draft) }; },
  };
  await controller.loadReports();
  const html = controller.document.root.innerHTML;

  assert.equal(controller.state.selected.id, draft.id);
  assert.match(html, />Draft</);
  assert.match(html, /Regenerate Draft/);
  assert.match(html, /data-report-action="finalise"/);
  assert.match(html, /in-progress Draft and is not yet authoritative/);
  assert.doesNotMatch(html, /Generate Weekly Report/);
});

test("an exact-period finalised report exposes only immutable snapshot actions", async () => {
  const finalised = lifecycleReport({
    id: "week-19-finalised",
    periodStart: "2026-10-19",
  });
  const original = structuredClone(finalised);
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "admin" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  let mutationCalls = 0;
  controller.api = {
    async listReports() { return { reports: [finalised] }; },
    async getReport() { return { report: lifecycleDetail(finalised) }; },
    async generateReport() { mutationCalls += 1; },
    async regenerateReport() { mutationCalls += 1; },
  };
  await controller.loadReports();
  const html = controller.document.root.innerHTML;

  assert.match(html, />Finalised</);
  assert.match(html, /Export PDF/);
  assert.match(html, /data-report-action="archive"/);
  assert.doesNotMatch(html, /Regenerate Draft|data-report-action="generate"/);
  await controller.generate();
  await controller.regenerate();
  assert.equal(mutationCalls, 0);
  assert.deepEqual(finalised, original);
});

test("the shared resolver keeps Monthly on the accepted extract month", async () => {
  const monthly = lifecycleReport({
    id: "october-draft",
    reportType: "monthly",
    status: "draft",
    periodStart: "2026-10-01",
  });
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.state.activeTab = "monthly";
  controller.api = {
    async listReports() { return { reports: [monthly] }; },
    async getReport() { return { report: lifecycleDetail(monthly) }; },
  };
  await controller.loadReports();

  assert.equal(controller.state.periodStarts.monthly, "2026-10-01");
  assert.equal(controller.state.selected.id, monthly.id);
  assert.match(controller.document.root.innerHTML, /October 2026/);
  assert.match(controller.document.root.innerHTML, /Regenerate Draft/);
});

test("generation success opens the newly created exact-period draft", async () => {
  const oldFinalised = lifecycleReport({ id: "week-12-finalised" });
  const draft = lifecycleReport({
    id: "week-19-draft",
    status: "draft",
    periodStart: "2026-10-19",
  });
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.state.reports = [oldFinalised];
  controller.state.periodStarts.weekly = "2026-10-19";
  controller.state.primaryPeriodStarts.weekly = "2026-10-19";
  const generated = [];
  controller.api = {
    async generateReport(type, periodStart) {
      generated.push({ type, periodStart });
      return { report: draft };
    },
    async getReport(id) {
      assert.equal(id, draft.id);
      return { report: lifecycleDetail(draft) };
    },
  };

  await controller.generate();
  assert.deepEqual(generated, [{ type: "weekly", periodStart: "2026-10-19" }]);
  assert.equal(controller.state.selected.id, draft.id);
  assert.equal(controller.state.selected.status, "draft");
  assert.match(controller.document.root.innerHTML, /Regenerate Draft/);
});

test("generation failure keeps the no-report state, visible error and usable History", async () => {
  const oldFinalised = lifecycleReport({ id: "week-12-finalised" });
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.state.reports = [oldFinalised];
  controller.state.periodStarts.weekly = "2026-10-19";
  controller.state.primaryPeriodStarts.weekly = "2026-10-19";
  controller.api = {
    async generateReport() {
      throw Object.assign(new Error("Generation unavailable"), {
        code: "REQUEST_FAILED",
      });
    },
  };

  await controller.generate();
  assert.equal(controller.state.selected, null);
  assert.equal(controller.state.reports.length, 1);
  assert.match(
    controller.document.root.innerHTML,
    /report action could not be completed\. No report was changed/,
  );
  assert.match(controller.document.root.innerHTML, /No report generated yet/);
  assert.match(controller.document.root.innerHTML, /Generate Weekly Report/);
  assert.match(controller.renderHistory(), /data-report-id="week-12-finalised"/);
});

test("repeated generation clicks create only one in-flight request", async () => {
  const draft = lifecycleReport({
    id: "week-19-draft",
    status: "draft",
    periodStart: "2026-10-19",
  });
  const controller = new ReportsController({
    document: reportDocument(),
    getContext: () => ({
      user: { role: "manager" },
      freshness: lifecycleFreshness,
    }),
    now: () => lifecycleNow,
  });
  controller.state.periodStarts.weekly = "2026-10-19";
  controller.state.primaryPeriodStarts.weekly = "2026-10-19";
  let release;
  let generateCalls = 0;
  controller.api = {
    generateReport() {
      generateCalls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ report: draft });
      });
    },
    async getReport() { return { report: lifecycleDetail(draft) }; },
  };

  const first = controller.generate();
  const second = controller.generate();
  assert.equal(generateCalls, 1);
  assert.equal(controller.state.loading, true);
  assert.match(controller.document.root.innerHTML, /data-report-action="generate" disabled/);
  release();
  await Promise.all([first, second]);
  assert.equal(controller.state.selected.id, draft.id);
});

test("weekly in-progress status ends after the Friday reporting boundary", () => {
  assert.equal(
    isReportPeriodInProgress("weekly", "2026-10-19", lifecycleNow),
    true,
  );
  assert.equal(
    isReportPeriodInProgress(
      "weekly",
      "2026-10-19",
      new Date("2026-10-24T10:00:00+02:00"),
    ),
    false,
  );
});
