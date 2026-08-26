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
  metricState,
  normalizeReport,
  reportSnapshot,
  shiftReportPeriod,
} from "../scout-smartsure/claims/reporting-ui.mjs";

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
    "No prior period",
  );
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
  await api.finaliseReport("run-1");
  await api.archiveReport("run-1");
  await api.metricClaims("run-1", "no_movement_over_30");

  assert.equal(calls[0].url, "https://reports.example.workers.dev/reports");
  assert.equal(
    calls[1].url,
    "https://reports.example.workers.dev/reports/generate",
  );
  assert.equal(JSON.parse(calls[1].options.body).scope.kind, "team");
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(
    calls.at(-1).url,
    "https://reports.example.workers.dev/reports/run-1/metrics/no_movement_over_30/claims",
  );
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
  assert.equal(state.periodStarts.weekly, "2026-08-17");
  assert.equal(state.periodStarts.monthly, "2026-08-01");
  assert.deepEqual(state.reports, []);
  assert.equal(state.historyLoaded, false);
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
