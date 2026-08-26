const REPORTING_TIME_ZONE = "Africa/Johannesburg";
const REPORTING_ROLES = new Set(["manager", "admin"]);

const STATUS_LABELS = {
  draft: "Draft",
  finalised: "Finalised",
  archived: "Archived",
};

const COVERAGE_LABELS = {
  complete: "Complete",
  usable_with_warnings: "Usable with warnings",
  partial: "Partial coverage",
  insufficient: "Insufficient history",
};

const WARNING_LABELS = {
  no_opening_snapshot: "No valid opening snapshot was available.",
  no_closing_snapshot: "No valid closing snapshot was available.",
  boundary_snapshot_unavailable: "A boundary snapshot was unavailable.",
  closing_snapshot_rows_unavailable: "The closing snapshot could not be read.",
  opening_or_closing_snapshot_unavailable:
    "Opening or closing inventory is unavailable.",
  unknown_registration_dates: "Some claims have no trusted registration date.",
  unmapped_statuses: "Some claim statuses are not mapped to SLA rules.",
  unmapped_statuses_excluded_from_denominator:
    "Unmapped statuses are excluded from SLA compliance.",
  unresolved_handlers: "Some claims have unresolved ownership.",
  identity_ambiguity: "Some claim identities need review.",
  payment_activity_unavailable_without_source_event_semantics:
    "Payment activity events are not available from the source.",
  payment_event_semantics_unavailable:
    "Payment event data is not available from the source.",
  missing_expected_coverage_not_identifiable_without_cadence_contract:
    "Expected extract cadence is not configured.",
  exact_closure_event_timestamps_unavailable:
    "Some closure activity was observed between extracts rather than source-dated.",
  first_observed_history_unavailable:
    "First-observed history is not available.",
  assignment_history_unavailable: "Assignment history is not available.",
  working_age_or_sla_mapping_unavailable:
    "Some SLA ages or mappings are unavailable.",
  sla_denominator_zero: "No claims were available for the SLA denominator.",
  movement_date_unavailable: "Some claims have no trusted movement date.",
  financial_value_missing: "Some financial values are missing.",
  user_lookup_unavailable: "Handler configuration could not be resolved.",
};

const READY_REASON_LABELS = {
  payment_made_over_21_days: "Payment Made >21 days",
  payment_released_over_14_days: "Payment Released >14 days",
  repudiated_awaiting_closure_over_7_days:
    "Repudiated Awaiting Closure >7 days",
  settled_over_14_days: "Settled >14 days",
  payment_requested_estimate_zero_over_30_days:
    "Payment Requested / Est. 0 >30 days",
  registered_over_60_days: "Registered >60 days",
};

const OPERATIONAL_LABELS = {
  assessor_overdue: "Assessor overdue",
  investigator_overdue: "Investigator overdue",
  broker_overdue: "Broker overdue",
  high_value_mandate_attention: "High value / mandate attention",
  legal_recovery: "Legal / recovery",
  nfo_ombudsman: "NFO / Ombudsman",
  fraud: "Fraud",
  repudiation_expired: "Repudiation expired",
};

const AGEING_LABELS = {
  "0-30": "0–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "91+": "91+ days",
  unknown: "Unknown date",
};

const UNAVAILABLE_REASON = "Not available";

const ATTENTION_CATEGORY_LABELS = {
  claim_development: "Claim development",
  insurer_facility: "Insurer / facility",
  assessor: "Assessor",
  investigator: "Investigator",
  broker_client: "Broker / client",
  payment: "Payment",
  mandate_high_value: "Mandate / high value",
  complaint: "Complaint",
  legal_nfo: "Legal / NFO",
  fraud: "Fraud",
  data_system: "Data / system",
  operational: "Operational",
  other: "Other",
};

const ACTION_CATEGORY_LABELS = {
  claim: "Claim",
  insurer: "Insurer",
  broker: "Broker",
  supplier: "Supplier",
  payment: "Payment",
  system: "System",
  team: "Team",
  management: "Management",
  other: "Other",
};

const ATTENTION_STATUS_LABELS = {
  open: "Open",
  monitoring: "Monitoring",
  waiting: "Waiting",
  resolved: "Resolved",
};

const ACTION_STATUS_LABELS = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
};

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnly(value) {
  const parsed = parseDate(value);
  if (!parsed) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const found = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return found.year && found.month && found.day
    ? `${found.year}-${found.month}-${found.day}`
    : null;
}

function parseLocalDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const date = parseLocalDate(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return localDateString(date);
}

function startOfWeek(value) {
  const date = parseLocalDate(value);
  if (!date) return null;
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return localDateString(date);
}

function monthStart(value) {
  const date = parseLocalDate(value);
  return date
    ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`
    : null;
}

function todayInReportingZone(now = new Date()) {
  return dateOnly(now) || localDateString(new Date());
}

export function canAccessReports(role) {
  return REPORTING_ROLES.has(String(role || "").toLowerCase());
}

export function defaultReportPeriodStart(reportType, now = new Date()) {
  const today = todayInReportingZone(now);
  if (reportType === "weekly") return addDays(startOfWeek(today), -7);
  if (reportType === "monthly") return monthStart(today);
  throw new RangeError(`Unsupported report type: ${reportType}`);
}

export function shiftReportPeriod(reportType, periodStart, direction) {
  const amount = Number(direction) || 0;
  if (reportType === "weekly") return addDays(periodStart, amount * 7);
  if (reportType === "monthly") {
    const date = parseLocalDate(periodStart);
    if (!date) return null;
    date.setUTCMonth(date.getUTCMonth() + amount);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  return null;
}

export function isFutureReportPeriod(
  reportType,
  periodStart,
  now = new Date(),
) {
  const today = todayInReportingZone(now);
  const start =
    reportType === "weekly" ? startOfWeek(today) : monthStart(today);
  return String(periodStart || "") > String(start || "");
}

export function reportSnapshot(run) {
  const source = asObject(run);
  const snapshot = asObject(source.metrics_snapshot);
  if (Object.keys(snapshot).length) return snapshot;
  return source;
}

export function normalizeReport(run) {
  const source = asObject(run);
  const snapshot = reportSnapshot(source);
  if (!snapshot.metrics && source.status !== undefined) {
    throw new Error("The reporting service returned an incomplete report.");
  }
  return { run: source, snapshot };
}

export function metricState(snapshot, metricId) {
  const metric = asObject(asObject(snapshot).metrics)[metricId];
  const available =
    metric &&
    metric.availability !== "unavailable" &&
    metric.value !== null &&
    metric.value !== undefined;
  return {
    metric,
    available,
    value: available ? metric.value : null,
    precision: metric?.precision || "unavailable",
    reason: metric?.coverage_warnings?.[0] || UNAVAILABLE_REASON,
    drillable: Boolean(metric && metric.availability !== "unavailable"),
  };
}

export function formatInteger(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round(number).toLocaleString("en-ZA")
    : "—";
}

export function formatRand(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `R ${Math.round(number).toLocaleString("en-ZA")}`;
}

export function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
}

export function formatMetric(metricValue, kind = "integer") {
  if (metricValue === null || metricValue === undefined) return "—";
  if (kind === "currency") return formatRand(metricValue);
  if (kind === "percent") return formatPercent(metricValue);
  return formatInteger(metricValue);
}

export function formatComparison(comparison, kind = "integer") {
  if (
    !comparison ||
    comparison.absolute_delta === null ||
    comparison.absolute_delta === undefined
  ) {
    return "No prior period";
  }
  const delta = Number(comparison.absolute_delta);
  if (!Number.isFinite(delta) || delta === 0) return "— unchanged";
  const arrow = delta > 0 ? "↑" : "↓";
  if (kind === "percent")
    return `${arrow} ${Math.abs(delta * 100).toFixed(1)} pts`;
  const value =
    kind === "currency"
      ? formatRand(Math.abs(delta))
      : formatInteger(Math.abs(delta));
  return `${arrow} ${value} vs previous period`;
}

export function formatPeriodLabel(source, reportType = null) {
  const data = asObject(source);
  const snapshot = reportSnapshot(data);
  const type = reportType || data.report_type || snapshot.report_type;
  const start =
    snapshot.period_start_local_date ||
    data.period_start_local_date ||
    dateOnly(data.period_start);
  if (!start) return "Reporting period";
  const startDate = parseLocalDate(start);
  if (!startDate) return "Reporting period";
  if (type === "monthly") {
    return new Intl.DateTimeFormat("en-ZA", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(startDate);
  }
  const endExclusive =
    snapshot.period_end_local_date ||
    data.period_end_local_date ||
    addDays(start, 5);
  const endDate = parseLocalDate(addDays(endExclusive, -1));
  const dateFormatter = new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const startText = dateFormatter.format(startDate);
  const endText = endDate ? dateFormatter.format(endDate) : "";
  if (
    endDate &&
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCFullYear() === endDate.getUTCFullYear()
  ) {
    const monthYear = new Intl.DateTimeFormat("en-ZA", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(startDate);
    return `${startDate.getUTCDate()}–${endDate.getUTCDate()} ${monthYear}`;
  }
  return endText ? `${startText}–${endText}` : startText;
}

export function reportPeriodKey(run) {
  const source = asObject(run);
  const snapshot = reportSnapshot(source);
  return (
    snapshot.period_start_local_date ||
    source.period_start_local_date ||
    dateOnly(source.period_start)
  );
}

export function coveragePresentation(status, warningCount = 0) {
  const key = String(status || "insufficient");
  const label = COVERAGE_LABELS[key] || "Coverage unavailable";
  return warningCount && key === "usable_with_warnings"
    ? `Complete · ${warningCount} data warning${warningCount === 1 ? "" : "s"}`
    : label;
}

export function precisionPresentation(metric) {
  const precision = metric?.precision;
  if (precision === "source_exact") return "Uses an exact source event.";
  if (precision === "source_date") return "Uses the source registration date.";
  if (precision === "snapshot_exact")
    return "Based on the accepted closing snapshot for this period.";
  if (precision === "observed_period")
    return "Observed during this reporting period; an exact event time was not supplied.";
  if (precision === "mixed")
    return "Combines exact source events with observed period activity.";
  return metric?.coverage_warnings?.length
    ? warningText(metric.coverage_warnings[0])
    : UNAVAILABLE_REASON;
}

export function warningText(value) {
  return (
    WARNING_LABELS[value] ||
    String(value || "Data-quality warning").replaceAll("_", " ")
  );
}

export function createReportingApi({
  baseUrl,
  getToken,
  fetchImpl = globalThis.fetch,
} = {}) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  if (!root || typeof fetchImpl !== "function")
    throw new Error("Reporting API is not configured.");

  async function request(path, options = {}) {
    const { responseType, ...fetchOptions } = options;
    const headers = {
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(fetchOptions.headers || {}),
    };
    const token = typeof getToken === "function" ? getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        ...fetchOptions,
        headers,
      });
    } catch {
      throw Object.assign(
        new Error("The reporting service could not be reached."),
        { code: "NETWORK_ERROR" },
      );
    }
    const payload =
      responseType === "blob"
        ? response.ok
          ? await response.blob()
          : await response.text().then((text) => {
              try {
                return JSON.parse(text);
              } catch {
                return {};
              }
            })
        : await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawMessage = String(payload?.error || payload?.message || "");
      const schemaUnavailable =
        response.status >= 500 &&
        /report|schema|relation|table|migration|database/i.test(rawMessage);
      const code =
        response.status === 401
          ? "AUTHENTICATION_REQUIRED"
          : response.status === 403
            ? "NOT_AUTHORIZED"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 409
                ? "CONFLICT"
                : response.status >= 500 &&
                    /pdf|renderer|browser run/i.test(rawMessage)
                  ? "PDF_UNAVAILABLE"
                  : schemaUnavailable
                    ? "REPORTING_UNAVAILABLE"
                    : "REQUEST_FAILED";
      throw Object.assign(
        new Error(rawMessage || "The reporting service returned an error."),
        { code, status: response.status },
      );
    }
    return payload;
  }

  return {
    listReports: () => request("/reports"),
    getReport: (id) => request(`/reports/${encodeURIComponent(id)}`),
    exportReportPdf: (id) =>
      request(`/reports/${encodeURIComponent(id)}/pdf`, {
        responseType: "blob",
      }),
    generateReport: (reportType, periodStart) =>
      request("/reports/generate", {
        method: "POST",
        body: JSON.stringify({
          reportType,
          periodStart,
          scope: { kind: "team" },
        }),
      }),
    regenerateReport: (id) =>
      request(`/reports/${encodeURIComponent(id)}/regenerate`, {
        method: "POST",
      }),
    finaliseReport: (id) =>
      request(`/reports/${encodeURIComponent(id)}/finalise`, {
        method: "POST",
      }),
    archiveReport: (id) =>
      request(`/reports/${encodeURIComponent(id)}/archive`, { method: "POST" }),
    metricClaims: (id, metricId) =>
      request(
        `/reports/${encodeURIComponent(id)}/metrics/${encodeURIComponent(metricId)}/claims`,
      ),
    listWorkflowUsers: () => request("/management-workflow/users"),
    listAttention: (filters = {}) => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.claimId) params.set("claimId", filters.claimId);
      if (filters.claimNumber) params.set("claimNumber", filters.claimNumber);
      const query = params.toString();
      return request(`/management-attention${query ? `?${query}` : ""}`);
    },
    createAttention: (body) =>
      request("/management-attention", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateAttention: (id, body) =>
      request(`/management-attention/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    resolveAttention: (id, resolutionNote = "Resolved") =>
      request(`/management-attention/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote }),
      }),
    addReportAttention: (reportId, attentionId) =>
      request(`/reports/${encodeURIComponent(reportId)}/attention`, {
        method: "POST",
        body: JSON.stringify({ attentionId }),
      }),
    removeReportAttention: (reportId, attentionId) =>
      request(
        `/reports/${encodeURIComponent(reportId)}/attention/${encodeURIComponent(attentionId)}`,
        { method: "DELETE" },
      ),
    listActions: (filters = {}) => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.claimId) params.set("claimId", filters.claimId);
      const query = params.toString();
      return request(`/management-actions${query ? `?${query}` : ""}`);
    },
    createAction: (body) =>
      request("/management-actions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateAction: (id, body) =>
      request(`/management-actions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    completeAction: (id, resolutionNote = "Completed") =>
      request(`/management-actions/${encodeURIComponent(id)}/complete`, {
        method: "POST",
        body: JSON.stringify({ resolutionNote }),
      }),
    addReportAction: (reportId, actionId) =>
      request(`/reports/${encodeURIComponent(reportId)}/actions`, {
        method: "POST",
        body: JSON.stringify({ actionId }),
      }),
    removeReportAction: (reportId, actionId) =>
      request(
        `/reports/${encodeURIComponent(reportId)}/actions/${encodeURIComponent(actionId)}`,
        { method: "DELETE" },
      ),
  };
}

export function createReportState(now = new Date()) {
  return {
    activeTab: "weekly",
    periodStarts: {
      weekly: defaultReportPeriodStart("weekly", now),
      monthly: defaultReportPeriodStart("monthly", now),
    },
    reports: [],
    selected: null,
    historyLoaded: false,
    loading: false,
    operation: "",
    error: null,
    drill: null,
    workflowForm: null,
    workflowOwners: [],
    workflowExistingAttention: [],
  };
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] || "Unknown";
  const className =
    status === "finalised"
      ? "green"
      : status === "archived"
        ? "accent"
        : "amber";
  return `<span class="section-badge ${className}">${escapeHtml(label)}</span>`;
}

function coverageBadge(status, warningCount = 0) {
  const className =
    status === "complete"
      ? "green"
      : status === "insufficient"
        ? "red"
        : "amber";
  return `<span class="section-badge ${className}">${escapeHtml(coveragePresentation(status, warningCount))}</span>`;
}

function renderMetricValue(state, kind) {
  return state.available ? formatMetric(state.value, kind) : "—";
}

function metricDrillButton(label, metricId, state, content, filter = "") {
  if (!state.drillable)
    return `<span class="report-value-muted" title="${escapeHtml(precisionPresentation(state.metric))}">${content}</span>`;
  return `<button class="report-metric-link" data-report-action="drill" data-metric-id="${escapeHtml(metricId)}" data-filter="${escapeHtml(filter)}" aria-label="Inspect ${escapeHtml(label)} claims">${content}</button>`;
}

function metricCard(
  snapshot,
  label,
  metricId,
  kind = "integer",
  tone = "accent",
) {
  const state = metricState(snapshot, metricId);
  const comparison = asObject(snapshot.comparisons)[metricId];
  const value = renderMetricValue(state, kind);
  const info = precisionPresentation(state.metric);
  const drill = state.drillable
    ? `data-report-action="drill" data-metric-id="${escapeHtml(metricId)}"`
    : "";
  return `<article class="report-kpi-card ${tone}">
    <div class="report-kpi-label">${escapeHtml(label)} <span class="report-info" title="${escapeHtml(info)}" aria-label="${escapeHtml(info)}">ⓘ</span></div>
    <button class="report-kpi-value${state.drillable ? " is-drillable" : ""}" ${drill} ${state.drillable ? `aria-label="Inspect ${escapeHtml(label)} claims"` : "disabled"}>${value}</button>
    <div class="report-kpi-sub">${state.available ? escapeHtml(formatComparison(comparison, kind)) : escapeHtml(state.reason === UNAVAILABLE_REASON ? UNAVAILABLE_REASON : warningText(state.reason))}</div>
  </article>`;
}

function reportTableRow(label, value, action = "", note = "") {
  return `<div class="report-table-row"><span>${escapeHtml(label)}</span><span>${action || escapeHtml(value)}</span>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function errorMessage(error) {
  switch (error?.code) {
    case "AUTHENTICATION_REQUIRED":
      return "Your session has expired. Sign in again to view Claims Reports.";
    case "NOT_AUTHORIZED":
      return "Claims Reports are available to Claims Managers and Admins only.";
    case "REPORTING_UNAVAILABLE":
      return "Claims Reports are not available yet. An administrator needs to complete the reporting setup.";
    case "PDF_UNAVAILABLE":
      return "PDF export is not available yet. An administrator needs to configure the report renderer.";
    case "NOT_FOUND":
      return "That report is no longer available.";
    case "CONFLICT":
      return "This report changed before the action completed. Refresh the report and try again.";
    case "NETWORK_ERROR":
      return "The reporting service could not be reached. Try again shortly.";
    default:
      return "Scout could not load Claims Reports right now. Try again shortly.";
  }
}

function recordByPeriod(reports, reportType, periodStart) {
  return (
    reports.find(
      (report) =>
        report.report_type === reportType &&
        reportPeriodKey(report) === periodStart,
    ) || null
  );
}

function pdfFilename(run) {
  const type = run?.report_type === "monthly" ? "Monthly" : "Weekly";
  const date = String(reportPeriodKey(run) || "report").replace(/[^0-9-]/g, "");
  return `Scout-${type}-Claims-Report-${date}.pdf`;
}

function claimRowMatchesFilter(row, filter) {
  if (!filter) return true;
  if (filter.startsWith("handler:"))
    return String(row.handler_email_snapshot || "") === filter.slice(8);
  if (filter.startsWith("category:"))
    return (
      String(row.membership_reasons?.operational_health || "") ===
      filter.slice(9)
    );
  if (filter.startsWith("ageing:"))
    return (
      String(row.membership_reasons?.ageing_distribution || "") ===
      filter.slice(7)
    );
  return true;
}

export class ReportsController {
  constructor({ document, getContext, rootId = "reports-content" } = {}) {
    this.document = document;
    this.getContext = getContext;
    this.rootId = rootId;
    this.state = createReportState();
    this.api = null;
    this.confirmResolver = null;
    this.handleClick = this.handleClick.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
  }

  mount() {
    const context = this.getContext?.() || {};
    if (!canAccessReports(context.user?.role)) return false;
    this.api = createReportingApi({
      baseUrl: context.backendUrl,
      getToken: () => this.getContext?.()?.user?.msToken,
    });
    const root = this.document?.getElementById(this.rootId);
    if (!root) return false;
    this.document.addEventListener("click", this.handleClick);
    root.addEventListener("change", this.handleChange);
    root.addEventListener("submit", this.handleSubmit);
    this.document.addEventListener("keydown", this.handleKeydown);
    this.render();
    this.loadWorkflowOwners();
    this.loadReports();
    return true;
  }

  open(tab = "weekly") {
    if (!this.api) return;
    this.state.activeTab = ["weekly", "monthly", "history"].includes(tab)
      ? tab
      : "weekly";
    this.state.selected = null;
    this.state.error = null;
    this.render();
    if (this.state.activeTab === "history") {
      if (!this.state.historyLoaded) this.loadReports();
    } else {
      this.loadPeriodReport(this.state.activeTab);
    }
  }

  async loadReports() {
    if (!this.api || this.state.loading) return;
    this.state.loading = true;
    this.state.operation = "Loading reports…";
    this.render();
    try {
      const response = await this.api.listReports();
      this.state.reports = Array.isArray(response?.reports)
        ? response.reports
        : [];
      this.state.historyLoaded = true;
      this.state.error = null;
      if (this.state.activeTab !== "history")
        await this.loadPeriodReport(this.state.activeTab, true);
    } catch (error) {
      this.state.error = error;
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    } finally {
      if (this.state.activeTab === "history") {
        this.state.loading = false;
        this.state.operation = "";
        this.render();
      }
    }
  }

  async loadWorkflowOwners() {
    if (!this.api) return;
    try {
      const response = await this.api.listWorkflowUsers();
      this.state.workflowOwners = Array.isArray(response?.users)
        ? response.users
        : [];
      this.render();
    } catch {
      this.state.workflowOwners = [];
    }
  }

  async loadPeriodReport(type, preserveLoading = false) {
    if (!this.api) return;
    const periodStart = this.state.periodStarts[type];
    this.state.selected = null;
    if (!preserveLoading) {
      this.state.loading = true;
      this.state.operation = "Loading report…";
      this.render();
    }
    try {
      const summary = recordByPeriod(this.state.reports, type, periodStart);
      if (summary) {
        const response = await this.api.getReport(summary.id);
        this.state.selected = normalizeReport(response?.report).run;
      }
      this.state.error = null;
    } catch (error) {
      this.state.error = error;
    } finally {
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    }
  }

  async perform(operation, action, successMessage = "") {
    if (this.state.loading || !this.api) return;
    this.state.loading = true;
    this.state.operation = operation;
    this.state.error = null;
    this.render();
    try {
      const response = await action();
      const run = response?.report;
      if (run) this.upsertReport(run);
      if (run?.id) {
        const detail = await this.api.getReport(run.id);
        this.state.selected = normalizeReport(detail?.report).run;
      }
      this.state.error = successMessage
        ? { code: "SUCCESS", message: successMessage }
        : null;
    } catch (error) {
      this.state.error = error;
    } finally {
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    }
  }

  upsertReport(run) {
    if (!run?.id) return;
    this.state.reports = [
      run,
      ...this.state.reports.filter((item) => item.id !== run.id),
    ];
  }

  async generate() {
    const type = this.state.activeTab;
    if (!this.api || !["weekly", "monthly"].includes(type)) return;
    await this.perform("Generating report…", () =>
      this.api.generateReport(type, this.state.periodStarts[type]),
    );
  }

  async regenerate() {
    const id = this.state.selected?.id;
    if (!id) return;
    if (!(await this.confirm("regenerate"))) return;
    await this.perform("Regenerating…", () => this.api.regenerateReport(id));
  }

  async finalise() {
    const id = this.state.selected?.id;
    if (!id || !(await this.confirm("finalise"))) return;
    await this.perform("Finalising…", () => this.api.finaliseReport(id));
  }

  async archive() {
    const id = this.state.selected?.id;
    if (!id || !(await this.confirm("archive"))) return;
    await this.perform("Archiving…", () => this.api.archiveReport(id));
  }

  async exportPdf() {
    const run = this.state.selected;
    const snapshot = reportSnapshot(run);
    if (
      !run?.id ||
      !["finalised", "archived"].includes(run.status) ||
      (snapshot.coverage_status || run.coverage_status) === "insufficient" ||
      this.state.loading
    )
      return;
    this.state.loading = true;
    this.state.operation = "Preparing PDF…";
    this.state.error = null;
    this.render();
    try {
      const blob = await this.api.exportReportPdf(run.id);
      const urlApi = this.document?.defaultView?.URL || globalThis.URL;
      if (!urlApi || typeof urlApi.createObjectURL !== "function")
        throw new Error("The browser could not prepare the PDF download.");
      const url = urlApi.createObjectURL(blob);
      const link = this.document.createElement("a");
      link.href = url;
      link.download = pdfFilename(run);
      link.click();
      urlApi.revokeObjectURL?.(url);
      this.state.error = {
        code: "SUCCESS",
        message: "PDF downloaded from the finalised report snapshot.",
      };
    } catch (error) {
      this.state.error = error;
    } finally {
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    }
  }

  confirm(action) {
    const backdrop = this.document?.getElementById("report-confirm-backdrop");
    if (!backdrop) return Promise.resolve(true);
    const title = this.document.getElementById("report-confirm-title");
    const body = this.document.getElementById("report-confirm-body");
    const confirmButton = this.document.getElementById("report-confirm-submit");
    const copy = {
      finalise: [
        "Finalise this report?",
        "Finalising freezes the report metrics and claim populations. It can still be viewed later, but its management figures will no longer regenerate.",
        "Finalise Report",
      ],
      archive: [
        "Archive this report?",
        "Archived reports remain available in History. They are not deleted.",
        "Archive Report",
      ],
      regenerate: [
        "Regenerate this draft?",
        "This replaces the draft snapshot with the latest accepted historical evidence from the reporting service.",
        "Regenerate",
      ],
    }[action];
    if (!copy) return Promise.resolve(false);
    title.textContent = copy[0];
    body.textContent = copy[1];
    confirmButton.textContent = copy[2];
    confirmButton.dataset.confirmAction = action;
    backdrop.classList.add("show");
    confirmButton.focus();
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  closeConfirm(result) {
    const backdrop = this.document?.getElementById("report-confirm-backdrop");
    if (backdrop) backdrop.classList.remove("show");
    const resolve = this.confirmResolver;
    this.confirmResolver = null;
    if (resolve) resolve(Boolean(result));
  }

  async drill(metricId, filter = "") {
    const reportId = this.state.selected?.id;
    if (!reportId || !metricId || this.state.loading) return;
    const metric = metricState(reportSnapshot(this.state.selected), metricId);
    if (!metric.drillable) return;
    this.state.drill = {
      metricId,
      filter,
      loading: true,
      claims: [],
      error: null,
    };
    this.renderDrill();
    try {
      const response = await this.api.metricClaims(reportId, metricId);
      this.state.drill.claims = Array.isArray(response?.claims)
        ? response.claims.filter((row) => claimRowMatchesFilter(row, filter))
        : [];
      this.state.drill.loading = false;
    } catch (error) {
      this.state.drill.loading = false;
      this.state.drill.error = error;
    }
    this.renderDrill();
  }

  closeDrill() {
    this.state.drill = null;
    this.renderDrill();
  }

  workflowItems(run, type) {
    const key = type === "attention" ? "attention_items" : "action_items";
    return Array.isArray(run?.[key])
      ? run[key]
      : Array.isArray(run?.workflow?.[key])
        ? run.workflow[key]
        : [];
  }

  openWorkflowForm(type, item = null, defaults = {}) {
    if (
      !item &&
      this.state.selected?.id &&
      this.state.selected?.status !== "draft"
    )
      return;
    this.state.workflowForm = {
      type,
      mode: item ? "edit" : "create",
      item,
      ...defaults,
    };
    this.render();
  }

  closeWorkflowForm() {
    this.state.workflowForm = null;
    this.render();
  }

  async performWorkflow(operation, callback) {
    if (this.state.loading || !this.api) return;
    this.state.loading = true;
    this.state.operation = operation;
    this.state.error = null;
    this.render();
    try {
      await callback();
      if (this.state.selected?.id) {
        const response = await this.api.getReport(this.state.selected.id);
        this.state.selected = normalizeReport(response?.report).run;
        this.upsertReport(this.state.selected);
      }
      this.state.workflowForm = null;
      this.state.error = null;
    } catch (error) {
      this.state.error = error;
    } finally {
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    }
  }

  formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim() || "";
  }

  async handleSubmit(event) {
    const form = event.target.closest?.("[data-workflow-form]");
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.workflowForm;
    const item = this.state.workflowForm?.item;
    const reportId = this.state.selected?.id;
    if (type === "attention") {
      const payload = {
        title: this.formValue(form, "title"),
        managementNote: this.formValue(form, "managementNote"),
        category: this.formValue(form, "category"),
        priority: this.formValue(form, "priority"),
        ownerUserId: this.formValue(form, "ownerUserId") || null,
        nextAction: this.formValue(form, "nextAction"),
        dueDate: this.formValue(form, "dueDate") || null,
        status: this.formValue(form, "status") || "open",
        claimId: this.formValue(form, "claimId") || null,
        sourceClaimNumber: this.formValue(form, "sourceClaimNumber") || null,
      };
      await this.performWorkflow(
        item ? "Updating attention…" : "Adding attention…",
        async () => {
          const response = item
            ? await this.api.updateAttention(item.id, payload)
            : await this.api.createAttention({
                ...payload,
                ...(reportId ? { originatingReportId: reportId } : {}),
              });
          const created = response?.item;
          if (!item && reportId && created?.id)
            await this.api.addReportAttention(reportId, created.id);
        },
      );
      return;
    }
    if (type === "attention-resolve") {
      await this.performWorkflow("Resolving attention…", () =>
        this.api.resolveAttention(
          item.id,
          this.formValue(form, "resolutionNote") || "Resolved",
        ),
      );
      return;
    }
    if (type === "action") {
      if (!reportId) return;
      const payload = {
        action: this.formValue(form, "action"),
        category: this.formValue(form, "category"),
        ownerUserId: this.formValue(form, "ownerUserId") || null,
        dueDate: this.formValue(form, "dueDate") || null,
        status: this.formValue(form, "status") || "open",
        claimId: this.formValue(form, "claimId") || null,
        sourceClaimNumber: this.formValue(form, "sourceClaimNumber") || null,
        attentionItemId: this.formValue(form, "attentionItemId") || null,
      };
      await this.performWorkflow(
        item ? "Updating action…" : "Adding action…",
        async () => {
          const response = item
            ? await this.api.updateAction(item.id, payload)
            : await this.api.createAction({
                ...payload,
                originatingReportId: reportId,
              });
          const created = response?.item;
          if (!item && created?.id)
            await this.api.addReportAction(reportId, created.id);
        },
      );
      return;
    }
    if (type === "action-complete") {
      await this.performWorkflow("Completing action…", () =>
        this.api.completeAction(
          item.id,
          this.formValue(form, "resolutionNote") || "Completed",
        ),
      );
    }
  }

  handleClick(event) {
    const target = event.target.closest?.("[data-report-action]");
    if (!target) return;
    const action = target.dataset.reportAction;
    if (action === "tab") this.open(target.dataset.tab);
    if (action === "period") this.movePeriod(Number(target.dataset.direction));
    if (action === "generate") this.generate();
    if (action === "regenerate") this.regenerate();
    if (action === "finalise") this.finalise();
    if (action === "archive") this.archive();
    if (action === "export-pdf") this.exportPdf();
    if (action === "drill")
      this.drill(target.dataset.metricId, target.dataset.filter || "");
    if (action === "open-report") this.openReport(target.dataset.reportId);
    if (action === "close-drill") this.closeDrill();
    if (action === "close-confirm") this.closeConfirm(false);
    if (action === "confirm-submit") this.closeConfirm(true);
    if (action === "retry") this.loadReports();
    if (action === "new-attention") this.openWorkflowForm("attention");
    if (action === "new-action")
      this.openWorkflowForm("action", null, {
        attentionId: target.dataset.attentionId || "",
        claimId: target.dataset.claimId || "",
        claimNumber: target.dataset.claimNumber || "",
      });
    if (action === "open-existing-attention")
      this.openWorkflowForm(
        "attention",
        this.state.workflowExistingAttention.find(
          (item) => item.id === target.dataset.itemId,
        ),
      );
    if (action === "edit-attention")
      this.openWorkflowForm(
        "attention",
        this.workflowItems(this.state.selected, "attention").find(
          (item) => item.id === target.dataset.itemId,
        ),
      );
    if (action === "edit-action")
      this.openWorkflowForm(
        "action",
        this.workflowItems(this.state.selected, "action").find(
          (item) => item.id === target.dataset.itemId,
        ),
      );
    if (action === "resolve-attention")
      this.openWorkflowForm(
        "attention-resolve",
        this.workflowItems(this.state.selected, "attention").find(
          (item) => item.id === target.dataset.itemId,
        ),
      );
    if (action === "complete-action")
      this.openWorkflowForm(
        "action-complete",
        this.workflowItems(this.state.selected, "action").find(
          (item) => item.id === target.dataset.itemId,
        ),
      );
    if (action === "remove-attention")
      this.performWorkflow("Removing attention…", () =>
        this.api.removeReportAttention(
          this.state.selected.id,
          target.dataset.itemId,
        ),
      );
    if (action === "remove-action")
      this.performWorkflow("Removing action…", () =>
        this.api.removeReportAction(
          this.state.selected.id,
          target.dataset.itemId,
        ),
      );
    if (action === "cancel-workflow") this.closeWorkflowForm();
  }

  handleChange(event) {
    if (event.target.matches("[data-history-filter]")) this.render();
  }

  handleKeydown(event) {
    if (event.key === "Escape") {
      if (this.state.drill) this.closeDrill();
      else if (this.confirmResolver) this.closeConfirm(false);
    }
  }

  movePeriod(direction) {
    const type = this.state.activeTab;
    const next = shiftReportPeriod(
      type,
      this.state.periodStarts[type],
      direction,
    );
    if (!next || isFutureReportPeriod(type, next)) return;
    this.state.periodStarts[type] = next;
    this.loadPeriodReport(type);
  }

  async openAttentionFromClaim(claim = {}) {
    this.state.activeTab = "weekly";
    if (this.state.selected?.report_type !== "weekly")
      this.state.selected = null;
    this.state.workflowForm = {
      type: "attention",
      mode: "create",
      item: null,
      claimNumber:
        claim.claimNo || claim.claim_no || claim.source_claim_number || "",
    };
    this.state.workflowExistingAttention = [];
    this.state.error = null;
    this.render();
    if (this.state.workflowForm.claimNumber && this.api) {
      try {
        const response = await this.api.listAttention({
          claimNumber: this.state.workflowForm.claimNumber,
        });
        this.state.workflowExistingAttention = (response?.items || []).filter(
          (item) => item.status !== "resolved",
        );
        this.render();
      } catch {
        this.state.workflowExistingAttention = [];
      }
    }
    if (!this.state.selected || this.state.selected.report_type !== "weekly")
      this.loadPeriodReport("weekly");
  }

  async openReport(id) {
    if (!id || !this.api) return;
    this.state.loading = true;
    this.state.operation = "Loading report…";
    this.render();
    try {
      const response = await this.api.getReport(id);
      this.state.selected = normalizeReport(response?.report).run;
      this.state.activeTab = this.state.selected.report_type || "history";
      this.state.error = null;
    } catch (error) {
      this.state.error = error;
    } finally {
      this.state.loading = false;
      this.state.operation = "";
      this.render();
    }
  }

  render() {
    const root = this.document?.getElementById(this.rootId);
    if (!root) return;
    root.innerHTML = `<div class="reports-tabs" role="tablist" aria-label="Claims report type">
      ${["weekly", "monthly", "history"].map((tab) => `<button class="tab ${this.state.activeTab === tab ? "active" : ""}" role="tab" aria-selected="${this.state.activeTab === tab}" data-report-action="tab" data-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}
    </div>
    ${this.state.operation ? `<div class="reports-operation" role="status"><span class="upload-spinner"></span>${escapeHtml(this.state.operation)}</div>` : ""}
    ${this.state.error && this.state.error.code !== "SUCCESS" ? `<div class="report-alert report-alert-error" role="alert">${escapeHtml(errorMessage(this.state.error))}<button class="btn-ghost" data-report-action="retry">Try again</button></div>` : ""}
    ${this.state.error?.code === "SUCCESS" ? `<div class="report-alert report-alert-success" role="status">${escapeHtml(this.state.error.message)}</div>` : ""}
    ${this.state.activeTab === "history" ? this.renderHistory() : this.renderPeriod()}`;
    this.renderDrill();
  }

  renderPeriod() {
    const type = this.state.activeTab;
    const periodStart = this.state.periodStarts[type];
    const report = this.state.selected;
    if (!report) {
      return `<section class="report-period-shell">
        <div class="report-period-header">
          <div><div class="report-period-label">${type === "weekly" ? "Weekly" : "Monthly"}</div><h2>${escapeHtml(formatPeriodLabel({ report_type: type, period_start_local_date: periodStart, period_end_local_date: type === "weekly" ? addDays(periodStart, 5) : addDays(shiftReportPeriod("monthly", periodStart, 1), 0) }))}</h2></div>
          <div class="report-period-actions"><button class="btn-secondary" data-report-action="period" data-direction="-1">Previous ${type === "weekly" ? "Week" : "Month"}</button><button class="btn-secondary" data-report-action="period" data-direction="1" ${isFutureReportPeriod(type, shiftReportPeriod(type, periodStart, 1)) ? "disabled" : ""}>Next ${type === "weekly" ? "Week" : "Month"}</button></div>
        </div>
        <div class="report-empty-card"><div class="report-empty-icon">↗</div><h3>No ${type} report yet</h3><p>Generate the Claims Report for this period when you are ready.</p><button class="btn-primary" data-report-action="generate" ${this.state.loading ? "disabled" : ""}>Generate Report</button></div>
        ${type === "weekly" && this.state.workflowForm?.type === "attention" ? `<section class="report-section workflow-section workflow-standalone">${this.renderExistingClaimAttention()}<div class="section-header"><div><div class="section-title">Add Management Attention</div><p class="section-help">Create a live attention item now; add it to a Draft report later if needed.</p></div></div>${this.workflowForm(this.state.workflowForm)}</section>` : ""}
      </section>`;
    }
    return this.renderReport(report, type);
  }

  renderReport(run, type = run.report_type) {
    const snapshot = reportSnapshot(run);
    const coverage =
      snapshot.coverage_status || run.coverage_status || "insufficient";
    const warnings =
      snapshot.coverage?.warnings || run.coverage_metadata?.warnings || [];
    const isDraft = run.status === "draft";
    const isFinalised = run.status === "finalised";
    const isArchived = run.status === "archived";
    const canExportPdf =
      (isFinalised || isArchived) && coverage !== "insufficient";
    const canArchive = this.getContext?.()?.user?.role === "admin";
    return `<section class="report-period-shell">
      <div class="report-period-header">
        <div><div class="report-period-label">${type === "weekly" ? "Weekly" : "Monthly"} Claims Report</div><h2>${escapeHtml(formatPeriodLabel(snapshot, type))}</h2><div class="report-meta-line">${statusBadge(run.status)} <span>Generated ${escapeHtml(this.formatDateTime(run.generated_at))}</span>${run.finalised_at ? `<span>· Finalised ${escapeHtml(this.formatDateTime(run.finalised_at))}</span>` : ""}</div></div>
        <div class="report-period-actions">${isDraft ? `<button class="btn-secondary" data-report-action="regenerate" ${this.state.loading ? "disabled" : ""}>Regenerate</button><button class="btn-primary" data-report-action="finalise" ${coverage === "insufficient" || this.state.loading ? "disabled" : ""}>Finalise</button>` : ""}${canExportPdf ? `<button class="btn-primary" data-report-action="export-pdf" ${this.state.loading ? "disabled" : ""}>Export PDF</button>` : ""}${isFinalised && canArchive ? `<button class="btn-secondary" data-report-action="archive" ${this.state.loading ? "disabled" : ""}>Archive</button>` : ""}${isArchived ? `<span class="report-action-note">Historical snapshot</span>` : ""}</div>
      </div>
      <div class="report-coverage-banner ${coverage === "complete" ? "is-complete" : coverage === "insufficient" ? "is-insufficient" : "is-warning"}"><div><strong>Coverage</strong> ${coverageBadge(coverage, warnings.length)}</div><span>${escapeHtml(this.coverageCopy(coverage, snapshot))}</span></div>
      ${!isDraft && this.state.workflowForm?.type === "attention" ? `<section class="report-section workflow-section workflow-standalone">${this.renderExistingClaimAttention()}<div class="section-header"><div><div class="section-title">Add Management Attention</div><p class="section-help">This creates a live item without changing the historical report snapshot.</p></div></div>${this.workflowForm(this.state.workflowForm)}</section>` : ""}
      ${coverage === "insufficient" ? this.renderInsufficient(snapshot) : this.renderReportSections(snapshot)}
      ${coverage === "insufficient" ? "" : this.renderWorkflow(run)}
      ${this.renderReportDetails(run, snapshot)}
    </section>`;
  }

  workflowStatus(status, type) {
    const labels =
      type === "attention" ? ATTENTION_STATUS_LABELS : ACTION_STATUS_LABELS;
    const className =
      status === "resolved" || status === "completed"
        ? "green"
        : status === "waiting"
          ? "amber"
          : "accent";
    return `<span class="section-badge ${className}">${escapeHtml(labels[status] || status || "Open")}</span>`;
  }

  workflowOverdue(item) {
    const status = item.status || item.status_snapshot;
    const dueDate = item.due_date || item.due_date_snapshot;
    return Boolean(
      dueDate &&
      dueDate < todayInReportingZone() &&
      status !== "resolved" &&
      status !== "completed",
    );
  }

  workflowOwnerOptions(selected = "") {
    return `<option value="">Unassigned</option>${this.state.workflowOwners
      .map(
        (owner) =>
          `<option value="${escapeHtml(owner.id || owner.email)}" ${String(selected || "") === String(owner.id || owner.email) ? "selected" : ""}>${escapeHtml(owner.displayName || owner.email)}</option>`,
      )
      .join("")}`;
  }

  workflowForm(form) {
    if (!form) return "";
    const item = form.item || {};
    const isAttention =
      form.type === "attention" || form.type === "attention-resolve";
    const isResolution =
      form.type === "attention-resolve" || form.type === "action-complete";
    if (isResolution) {
      return `<form class="workflow-form workflow-form-compact" data-workflow-form="${escapeHtml(form.type)}"><div><label>${form.type === "attention-resolve" ? "Resolution note" : "Completion note"}<textarea name="resolutionNote" rows="2" placeholder="Record the outcome">${escapeHtml(item.resolution_note || "")}</textarea></label></div><div class="workflow-form-actions"><button type="button" class="btn-secondary" data-report-action="cancel-workflow">Cancel</button><button type="submit" class="btn-primary">${form.type === "attention-resolve" ? "Resolve attention" : "Complete action"}</button></div></form>`;
    }
    if (isAttention) {
      return `<form class="workflow-form" data-workflow-form="attention"><div class="workflow-form-grid"><label>Title<input name="title" required value="${escapeHtml(item.title || "")}" placeholder="What needs management attention?"></label><label>Category<select name="category" required>${Object.entries(
        ATTENTION_CATEGORY_LABELS,
      )
        .map(
          ([value, label]) =>
            `<option value="${value}" ${item.category === value ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label><label>Priority<select name="priority"><option value="high" ${item.priority === "high" ? "selected" : ""}>High</option><option value="medium" ${!item.priority || item.priority === "medium" ? "selected" : ""}>Medium</option><option value="low" ${item.priority === "low" ? "selected" : ""}>Low</option></select></label><label>Status<select name="status"><option value="open" ${!item.status || item.status === "open" ? "selected" : ""}>Open</option><option value="monitoring" ${item.status === "monitoring" ? "selected" : ""}>Monitoring</option><option value="waiting" ${item.status === "waiting" ? "selected" : ""}>Waiting</option><option value="resolved" ${item.status === "resolved" ? "selected" : ""}>Resolved</option></select></label><label>Owner<select name="ownerUserId">${this.workflowOwnerOptions(item.owner_user_id || item.owner_user_id_snapshot || "")}</select></label><label>Next action<input name="nextAction" value="${escapeHtml(item.next_action || "")}" placeholder="Next step"></label><label>Due date<input type="date" name="dueDate" value="${escapeHtml(item.due_date || "")}"></label><label>Claim number<input name="sourceClaimNumber" value="${escapeHtml(item.claim_number || form.claimNumber || "")}" placeholder="Optional claim number"></label><input type="hidden" name="claimId" value="${escapeHtml(item.claim_id || "")}"><label class="workflow-form-wide">Management note<textarea name="managementNote" rows="2" placeholder="Short context for management">${escapeHtml(item.management_note || "")}</textarea></label></div><div class="workflow-form-actions"><button type="button" class="btn-secondary" data-report-action="cancel-workflow">Cancel</button><button type="submit" class="btn-primary">${item.id ? "Save attention" : "Add attention"}</button></div></form>`;
    }
    return `<form class="workflow-form" data-workflow-form="action"><div class="workflow-form-grid"><label>Action<input name="action" required value="${escapeHtml(item.action || "")}" placeholder="What must happen?"></label><label>Category<select name="category" required>${Object.entries(
      ACTION_CATEGORY_LABELS,
    )
      .map(
        ([value, label]) =>
          `<option value="${value}" ${item.category === value ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Status<select name="status"><option value="open" ${!item.status || item.status === "open" ? "selected" : ""}>Open</option><option value="in_progress" ${item.status === "in_progress" ? "selected" : ""}>In progress</option><option value="waiting" ${item.status === "waiting" ? "selected" : ""}>Waiting</option><option value="completed" ${item.status === "completed" ? "selected" : ""}>Completed</option></select></label><label>Owner<select name="ownerUserId">${this.workflowOwnerOptions(item.owner_user_id || item.owner_user_id_snapshot || "")}</select></label><label>Due date<input type="date" name="dueDate" value="${escapeHtml(item.due_date || "")}"></label><label>Claim number<input name="sourceClaimNumber" value="${escapeHtml(item.claim_number || form.claimNumber || "")}" placeholder="Optional claim number"></label><input type="hidden" name="claimId" value="${escapeHtml(item.claim_id || form.claimId || "")}"><label>Attention item<input name="attentionItemId" value="${escapeHtml(item.attention_item_id || form.attentionId || "")}" placeholder="Optional attention ID"></label></div><div class="workflow-form-actions"><button type="button" class="btn-secondary" data-report-action="cancel-workflow">Cancel</button><button type="submit" class="btn-primary">${item.id ? "Save action" : "Add action"}</button></div></form>`;
  }

  workflowClaimContext(item) {
    const claim =
      item.claim_number ||
      item.source_claim_number_snapshot ||
      item.claim_number_snapshot;
    if (!claim) return "Operational item";
    const context = [
      claim,
      item.handler_snapshot || item.claim_handler_snapshot,
      item.claim_status_snapshot || item.status_snapshot,
      item.insurer_snapshot || item.claim_insurer_snapshot,
    ].filter(Boolean);
    return `Claim-linked · ${context.map((value) => escapeHtml(value)).join(" · ")}`;
  }

  renderExistingClaimAttention() {
    const items = this.state.workflowExistingAttention || [];
    if (!items.length) return "";
    return `<div class="workflow-existing"><div><strong>Active attention already exists for this claim.</strong><span>Open the existing item or create another if the issue is genuinely separate.</span></div>${items.map((item) => `<button class="btn-ghost" data-report-action="open-existing-attention" data-item-id="${escapeHtml(item.id)}">Open: ${escapeHtml(item.title || "Untitled attention")}</button>`).join("")}</div>`;
  }

  renderAttentionItems(items, isDraft) {
    if (!items.length)
      return `<div class="workflow-empty"><strong>No management attention items selected.</strong><span>Add only the items that require deliberate management focus.</span></div>`;
    return `<div class="workflow-list">${items.map((item) => `<article class="workflow-card ${this.workflowOverdue(item) ? "is-overdue" : ""}"><div class="workflow-card-main"><div class="workflow-card-top"><span class="workflow-card-title">${escapeHtml(item.title || item.title_snapshot || "Untitled attention")}</span>${this.workflowStatus(item.status || item.status_snapshot, "attention")}${item.priority ? `<span class="workflow-priority ${escapeHtml(item.priority)}">${escapeHtml(item.priority)} priority</span>` : ""}${this.workflowOverdue(item) ? `<span class="workflow-overdue">Overdue</span>` : ""}</div><div class="workflow-card-context">${this.workflowClaimContext(item)} · ${escapeHtml(ATTENTION_CATEGORY_LABELS[item.category || item.category_snapshot] || item.category || "Other")}</div>${item.management_note || item.management_note_snapshot ? `<p>${escapeHtml(item.management_note || item.management_note_snapshot)}</p>` : ""}<div class="workflow-card-meta"><span>Owner: ${escapeHtml(item.owner_display || item.owner_display_snapshot || "Unassigned")}</span><span>Next: ${escapeHtml(item.next_action || item.next_action_snapshot || "Not set")}</span><span>Due: ${escapeHtml(item.due_date || item.due_date_snapshot || "Not set")}</span>${item.carried_forward_from_report_id ? `<span class="workflow-lineage">Carried forward</span>` : ""}</div></div>${isDraft ? `<div class="workflow-card-actions"><button class="btn-ghost" data-report-action="edit-attention" data-item-id="${escapeHtml(item.id)}">Edit</button><button class="btn-ghost" data-report-action="new-action" data-attention-id="${escapeHtml(item.id)}" data-claim-id="${escapeHtml(item.claim_id || "")}" data-claim-number="${escapeHtml(item.claim_number || "")}">Create action</button>${item.status !== "resolved" ? `<button class="btn-ghost" data-report-action="resolve-attention" data-item-id="${escapeHtml(item.id)}">Resolve</button>` : ""}<button class="btn-ghost danger" data-report-action="remove-attention" data-item-id="${escapeHtml(item.id)}">Remove</button></div>` : ""}</article>`).join("")}</div>`;
  }

  renderActionItems(items, isDraft) {
    if (!items.length)
      return `<div class="workflow-empty"><strong>No actions in this plan.</strong><span>Add a focused action with an owner and due date when needed.</span></div>`;
    return `<div class="workflow-list">${items.map((item) => `<article class="workflow-card ${this.workflowOverdue(item) ? "is-overdue" : ""}"><div class="workflow-card-main"><div class="workflow-card-top"><span class="workflow-card-title">${escapeHtml(item.action || item.action_snapshot || "Untitled action")}</span>${this.workflowStatus(item.status || item.status_snapshot, "action")}${this.workflowOverdue(item) ? `<span class="workflow-overdue">Overdue</span>` : ""}</div><div class="workflow-card-context">${this.workflowClaimContext(item)} · ${escapeHtml(ACTION_CATEGORY_LABELS[item.category || item.category_snapshot] || item.category || "Other")}</div><div class="workflow-card-meta"><span>Owner: ${escapeHtml(item.owner_display || item.owner_display_snapshot || "Unassigned")}</span><span>Due: ${escapeHtml(item.due_date || item.due_date_snapshot || "Not set")}</span>${item.carried_forward_from_report_id ? `<span class="workflow-lineage">Carried forward</span>` : ""}</div>${item.resolution_note || item.resolution_note_snapshot ? `<p>${escapeHtml(item.resolution_note || item.resolution_note_snapshot)}</p>` : ""}</div>${isDraft ? `<div class="workflow-card-actions"><button class="btn-ghost" data-report-action="edit-action" data-item-id="${escapeHtml(item.id)}">Edit</button>${item.status !== "completed" ? `<button class="btn-ghost" data-report-action="complete-action" data-item-id="${escapeHtml(item.id)}">Complete</button>` : ""}<button class="btn-ghost danger" data-report-action="remove-action" data-item-id="${escapeHtml(item.id)}">Remove</button></div>` : ""}</article>`).join("")}</div>`;
  }

  renderWorkflow(run) {
    const isDraft = run.status === "draft";
    const workflow = run.workflow || run;
    if (workflow.available === false)
      return `<section class="report-section workflow-section"><div class="section-header"><div class="section-title">Management workflow</div></div><div class="workflow-empty"><strong>Management workflow is not available yet.</strong><span>An administrator needs to complete the Phase 5 database setup.</span></div></section>`;
    const attention = this.workflowItems(run, "attention");
    const actions = this.workflowItems(run, "action");
    return `<section class="report-section workflow-section"><div class="section-header"><div><div class="section-title">Management Attention</div><p class="section-help">Human-selected items requiring management visibility.</p></div>${isDraft ? `<button class="btn-secondary" data-report-action="new-attention">Add attention item</button>` : `<span class="section-badge accent">Historical snapshot</span>`}</div>${isDraft && this.state.workflowForm?.type === "attention" ? this.workflowForm(this.state.workflowForm) : ""}${this.renderAttentionItems(attention, isDraft)}</section><section class="report-section workflow-section"><div class="section-header"><div><div class="section-title">Action Plan</div><p class="section-help">Lightweight actions linked to this report.</p></div>${isDraft ? `<button class="btn-secondary" data-report-action="new-action">Add action</button>` : `<span class="section-badge accent">Historical snapshot</span>`}</div>${isDraft && this.state.workflowForm?.type === "action" ? this.workflowForm(this.state.workflowForm) : ""}${this.renderActionItems(actions, isDraft)}</section>${isDraft && (this.state.workflowForm?.type === "attention-resolve" || this.state.workflowForm?.type === "action-complete") ? this.workflowForm(this.state.workflowForm) : ""}`;
  }

  renderInsufficient(snapshot) {
    const start = snapshot.coverage?.historical_capability_start_date;
    return `<div class="report-insufficient"><div class="report-insufficient-mark">!</div><div><h3>Insufficient historical coverage</h3><p>Scout does not have a valid historical snapshot for this reporting period. No zero-valued report is being shown.</p>${start ? `<p class="report-muted">Earliest trustworthy reporting date: <strong>${escapeHtml(start)}</strong></p>` : ""}</div></div>`;
  }

  renderReportSections(snapshot) {
    return `<div class="report-section"><div class="section-header"><div class="section-title">Executive Summary</div></div><div class="reports-kpi-grid">
      ${metricCard(snapshot, "Open Claims", "closing_inventory", "integer", "brand")}
      ${metricCard(snapshot, "New Claims Registered", "new_claims_registered", "integer", "accent")}
      ${metricCard(snapshot, "Claims Closed / Closure Activity", "claims_closed", "integer", "accent")}
      ${metricCard(snapshot, "Net Inventory Movement", "net_inventory_movement", "integer", "accent")}
      ${metricCard(snapshot, "60+ Days", "open_claims_60_plus", "integer", "amber")}
      ${metricCard(snapshot, "91+ Days", "open_claims_91_plus", "integer", "red")}
      ${metricCard(snapshot, "SLA Compliance", "sla_compliance", "percent", "green")}
      ${metricCard(snapshot, "Ready to Close", "ready_to_close", "integer", "amber")}
    </div></div>
    <div class="report-two-col"><section class="report-section"><div class="section-header"><div class="section-title">Claims Movement</div></div>${this.renderMovement(snapshot)}</section><section class="report-section"><div class="section-header"><div class="section-title">Management Ageing</div></div>${this.renderAgeing(snapshot)}</section></div>
    <section class="report-section"><div class="section-header"><div class="section-title">Operational Health</div><span class="section-badge amber">Categories may overlap</span></div>${this.renderOperational(snapshot)}</section>
    <div class="report-two-col"><section class="report-section"><div class="section-header"><div class="section-title">SLA Performance</div><span class="section-badge accent">Working days</span></div>${this.renderSla(snapshot)}</section><section class="report-section"><div class="section-header"><div class="section-title">Financial Position</div></div>${this.renderFinancial(snapshot)}</section></div>
    <section class="report-section"><div class="section-header"><div class="section-title">Handler Performance</div><span class="section-badge accent">From report-time ownership</span></div>${this.renderHandlers(snapshot)}</section>
    <div class="report-two-col"><section class="report-section"><div class="section-header"><div class="section-title">Activity &amp; Changes</div></div>${this.renderActivity(snapshot)}</section><section class="report-section"><div class="section-header"><div class="section-title">Registration &amp; Closure Evidence</div></div>${this.renderEvidence(snapshot)}</section></div>`;
  }

  renderMovement(snapshot) {
    const items = [
      ["Opening Inventory", "opening_inventory"],
      ["New Claims Registered", "new_claims_registered"],
      [
        "First observed without trusted registration date",
        "new_claims_first_observed",
      ],
      ["Closure Activity", "claims_closed"],
      ["Closing Inventory", "closing_inventory"],
      ["Net Inventory Movement", "net_inventory_movement"],
    ];
    return `<div class="report-data-table">${items
      .map(([label, id]) => {
        const state = metricState(snapshot, id);
        return reportTableRow(
          label,
          "",
          metricDrillButton(
            label,
            id,
            state,
            renderMetricValue(state, "integer"),
          ),
          state.available
            ? precisionPresentation(state.metric)
            : warningText(state.reason),
        );
      })
      .join(
        "",
      )}</div><p class="report-footnote">Closing inventory minus opening inventory is the authoritative net movement. Activity counts may not reconcile to inventory because observed changes and correction lineage are kept separate.</p>`;
  }

  renderAgeing(snapshot) {
    const state = metricState(snapshot, "ageing_distribution");
    if (!state.available || !state.value || typeof state.value !== "object")
      return `<div class="report-unavailable">— <span>Ageing is not available for this report.</span></div>`;
    const values = state.value;
    const max = Math.max(1, ...Object.values(values).map(Number));
    return `<div class="report-ageing-chart">${Object.entries(AGEING_LABELS)
      .map(([band, label]) => {
        const value = Number(values[band] || 0);
        return `<div class="report-ageing-row"><span>${escapeHtml(label)}</span><div class="report-ageing-track"><div class="report-ageing-fill" style="width:${Math.min(100, (value / max) * 100)}%"></div></div>${metricDrillButton(label, "ageing_distribution", { ...state, drillable: true }, `<strong>${formatInteger(value)}</strong>`, `ageing:${band}`)}</div>`;
      })
      .join(
        "",
      )}</div><p class="report-footnote">Management ageing uses calendar days. SLA performance uses working days.</p>`;
  }

  renderSla(snapshot) {
    const compliance = metricState(snapshot, "sla_compliance");
    const summary = metricState(snapshot, "sla_summary").value || {};
    const breach = metricState(snapshot, "sla_breaches");
    return `<div class="report-sla-highlight"><span>SLA Compliance</span><strong>${renderMetricValue(compliance, "percent")}</strong><small>${escapeHtml(precisionPresentation(compliance.metric))}</small></div><div class="report-data-table">${reportTableRow("Compliant claims", formatInteger(summary.compliant), metricDrillButton("compliant", "sla_compliance", compliance, formatInteger(summary.compliant)))}${reportTableRow("Breached claims", "", metricDrillButton("breached", "sla_breaches", breach, renderMetricValue(breach, "integer")))}${reportTableRow("Unmapped statuses", formatInteger(summary.unmapped), "", "Excluded from denominator")}</div>`;
  }

  renderOperational(snapshot) {
    const rows = [
      ["No Movement >14 Days", "no_movement_over_14"],
      ["No Movement >30 Days", "no_movement_over_30"],
      ["Ready to Close", "ready_to_close"],
      ["Payment Requested / Estimate Zero", "zero_estimate_payment_request"],
      ...Object.entries(OPERATIONAL_LABELS).map(([id, label]) => [
        label,
        `operational_health:${id}`,
      ]),
    ];
    return `<div class="report-health-grid">${rows
      .map(([label, id]) => {
        const [metricId, filter] = id.split(":");
        const state = metricState(snapshot, metricId);
        const value =
          metricId === "operational_health"
            ? state.value?.[filter]
            : state.value;
        const drillState = {
          ...state,
          drillable:
            state.drillable &&
            (metricId !== "operational_health" || value !== null),
        };
        return `<div class="report-health-row"><span>${escapeHtml(label)}</span>${metricDrillButton(label, metricId, drillState, renderMetricValue({ ...state, value, available: state.available && value !== null }, "integer"), filter ? `category:${filter}` : "")}</div>`;
      })
      .join("")}</div>`;
  }

  renderHandlers(snapshot) {
    const state = metricState(snapshot, "handler_performance");
    if (!state.available || !state.value)
      return `<div class="report-unavailable">— <span>Handler performance is not available for this report.</span></div>`;
    const handlers = Array.isArray(state.value.handlers)
      ? state.value.handlers
      : [];
    const rows = handlers
      .map(
        (handler) =>
          `<tr><th scope="row">${escapeHtml(handler.handler_name || handler.handler_email || "Unnamed handler")}</th>${[
            ["open_claims", "open_claims"],
            ["claims_60_plus", "claims_60_plus"],
            ["claims_91_plus", "claims_91_plus"],
            ["sla_breaches", "sla_breaches"],
            ["no_movement_over_14", "no_movement_over_14"],
            ["no_movement_over_30", "no_movement_over_30"],
            ["ready_to_close", "ready_to_close"],
          ]
            .map(
              ([key, metricId]) =>
                `<td>${metricDrillButton(`${handler.handler_name || "handler"} ${key}`, "handler_performance", { ...state, drillable: true }, formatInteger(handler[key]), `handler:${handler.handler_email || ""}`)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    return `<div class="report-table-scroll"><table class="report-handler-table"><thead><tr><th scope="col">Handler</th><th scope="col">Open</th><th scope="col">60+</th><th scope="col">91+</th><th scope="col">SLA breach</th><th scope="col">14+ stuck</th><th scope="col">30+ stuck</th><th scope="col">Ready</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="report-table-empty">No handler populations supplied.</td></tr>`}</tbody></table></div><div class="report-ownership-notes"><span>Manager-held: <strong>${formatInteger(state.value.manager_held_other?.count || 0)}</strong></span><span>Unassigned / unresolved: <strong>${formatInteger(state.value.unassigned_unresolved?.count || 0)}</strong></span></div>`;
  }

  renderFinancial(snapshot) {
    return `<div class="reports-kpi-grid reports-kpi-grid-3">${metricCard(snapshot, "Open Outstanding Exposure", "financial_open_outstanding", "currency", "brand")}${metricCard(snapshot, "Estimate Total", "financial_estimate_total", "currency", "accent")}${metricCard(snapshot, "Paid Total", "financial_paid_total", "currency", "green")}</div><div class="report-data-table report-financial-events">${reportTableRow("Payment Requested", "—", `<span class="report-value-muted">— <small>Source event data unavailable</small></span>`)}${reportTableRow("Payment Released", "—", `<span class="report-value-muted">— <small>Source event data unavailable</small></span>`)}</div>`;
  }

  renderActivity(snapshot) {
    const assignment = metricState(snapshot, "assignment_activity");
    const details = assignment.metric?.details || {};
    return `<div class="report-data-table">${reportTableRow("Observed assignment changes", "", metricDrillButton("assignment changes", "assignment_activity", assignment, renderMetricValue(assignment, "integer")))}${reportTableRow("Assigned in", formatInteger(details.reassignments_in))}${reportTableRow("Assigned out", formatInteger(details.reassignments_out))}</div><p class="report-footnote">Assignment activity is observed between accepted extracts unless the source supplies an exact event.</p>`;
  }

  renderEvidence(snapshot) {
    const closed = metricState(snapshot, "claims_closed");
    const details = closed.metric?.details || {};
    const registered = metricState(snapshot, "new_claims_registered");
    return `<div class="report-data-table">${reportTableRow("Source-dated registrations", "", metricDrillButton("source-dated registrations", "new_claims_registered", registered, renderMetricValue(registered, "integer")))}${reportTableRow("Source-dated closures", formatInteger(details.exact_source_count))}${reportTableRow("Observed terminal transitions", formatInteger(details.observed_terminal_transition_count))}</div><p class="report-footnote">${escapeHtml(precisionPresentation(closed.metric))}</p>`;
  }

  renderReportDetails(run, snapshot) {
    const coverage = snapshot.coverage || asObject(run.coverage_metadata);
    const warnings = coverage.warnings || [];
    return `<details class="report-details"><summary>Report details &amp; data quality</summary><div class="report-details-grid"><div><span>Opening extract</span><strong>${escapeHtml(snapshot.opening_extract_id || run.opening_extract_id || "Not available")}</strong></div><div><span>Closing extract</span><strong>${escapeHtml(snapshot.closing_extract_id || run.closing_extract_id || "Not available")}</strong></div><div><span>Accepted extracts in period</span><strong>${formatInteger(coverage.accepted_extract_count)}</strong></div><div><span>Warning-quality extracts</span><strong>${formatInteger(coverage.warning_quality_extract_count)}</strong></div><div><span>Historical capability start</span><strong>${escapeHtml(coverage.historical_capability_start_date || "Not available")}</strong></div><div><span>Metric definition</span><strong>${escapeHtml(run.metric_definition_version || snapshot.metric_definition_version || "Not available")}</strong></div><div><span>Claims rules</span><strong>${escapeHtml(run.claims_rule_version || snapshot.claims_rule_version || "Not available")}</strong></div><div><span>Quality rules</span><strong>${escapeHtml(run.quality_rule_version || snapshot.quality_rule_version || "Not available")}</strong></div></div><div class="report-warning-list">${warnings.length ? warnings.map((warning) => `<span>• ${escapeHtml(warningText(warning))}</span>`).join("") : "<span>No additional data-quality warnings.</span>"}</div></details>`;
  }

  coverageCopy(status, snapshot) {
    if (status === "insufficient")
      return "A trustworthy closing snapshot is not available for this period.";
    if (status === "partial")
      return "Supported metrics are shown; other values remain unavailable until coverage improves.";
    if (status === "usable_with_warnings")
      return `${formatInteger(snapshot.coverage?.warnings?.length || 0)} data-quality warning${(snapshot.coverage?.warnings?.length || 0) === 1 ? "" : "s"} are included below.`;
    return "The report has usable opening and closing evidence for this period.";
  }

  formatDateTime(value) {
    const parsed = parseDate(value);
    return parsed
      ? new Intl.DateTimeFormat("en-ZA", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: REPORTING_TIME_ZONE,
        }).format(parsed)
      : "Not available";
  }

  renderHistory() {
    const type =
      this.document.querySelector("[data-history-filter='type']")?.value ||
      "all";
    const status =
      this.document.querySelector("[data-history-filter='status']")?.value ||
      "all";
    const reports = this.state.reports
      .filter(
        (report) =>
          (type === "all" || report.report_type === type) &&
          (status === "all" || report.status === status),
      )
      .sort((a, b) =>
        String(b.period_start || "").localeCompare(
          String(a.period_start || ""),
        ),
      );
    return `<section class="report-history-shell"><div class="report-history-header"><div><div class="report-period-label">Report archive</div><h2>History</h2><p class="page-sub">Draft, finalised and archived Claims Reports.</p></div><div class="report-history-filters"><label>Type<select data-history-filter="type"><option value="all" ${type === "all" ? "selected" : ""}>All types</option><option value="weekly" ${type === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${type === "monthly" ? "selected" : ""}>Monthly</option></select></label><label>Status<select data-history-filter="status"><option value="all" ${status === "all" ? "selected" : ""}>All statuses</option><option value="draft" ${status === "draft" ? "selected" : ""}>Draft</option><option value="finalised" ${status === "finalised" ? "selected" : ""}>Finalised</option><option value="archived" ${status === "archived" ? "selected" : ""}>Archived</option></select></label></div></div><div class="report-history-table" role="table"><div class="report-history-row report-history-head" role="row"><span>Period</span><span>Type</span><span>Status</span><span>Coverage</span><span>Generated</span><span>Finalised</span><span>Generated by</span></div>${reports.length ? reports.map((report) => `<button class="report-history-row" role="row" data-report-action="open-report" data-report-id="${escapeHtml(report.id)}"><span>${escapeHtml(formatPeriodLabel(report))}</span><span>${escapeHtml(String(report.report_type || "").replace(/^./, (letter) => letter.toUpperCase()))}</span><span>${statusBadge(report.status)}</span><span>${coverageBadge(report.coverage_status, report.coverage_metadata?.warnings?.length || 0)}</span><span>${escapeHtml(this.formatDateTime(report.generated_at))}</span><span>${escapeHtml(this.formatDateTime(report.finalised_at))}</span><span>${escapeHtml(report.generated_by || "Not available")}</span></button>`).join("") : `<div class="report-empty-card compact"><h3>No reports yet</h3><p>Finalised and draft reports will appear here.</p></div>`}</div></section>`;
  }

  renderDrill() {
    const backdrop = this.document?.getElementById("report-drill-backdrop");
    const panel = this.document?.getElementById("report-drill-panel");
    if (!backdrop || !panel) return;
    if (!this.state.drill) {
      backdrop.classList.remove("show");
      panel.classList.remove("open");
      return;
    }
    const snapshot = reportSnapshot(this.state.selected);
    const label = this.drillLabel(
      this.state.drill.metricId,
      this.state.drill.filter,
    );
    panel.innerHTML = `<div class="detail-header"><div><div class="detail-claim-no">${escapeHtml(formatPeriodLabel(snapshot))}</div><div class="detail-insured">${escapeHtml(label)}</div><div class="report-muted">Frozen report-time claim population</div></div><button class="detail-close" data-report-action="close-drill" aria-label="Close claim population">×</button></div><div class="detail-body">${this.state.drill.loading ? `<div class="empty-state"><span class="upload-spinner"></span>Loading claims…</div>` : this.state.drill.error ? `<div class="empty-state empty-state-error">${escapeHtml(errorMessage(this.state.drill.error))}</div>` : this.renderDrillClaims(this.state.drill.claims)}</div>`;
    backdrop.classList.add("show");
    panel.classList.add("open");
  }

  drillLabel(metricId, filter) {
    if (metricId === "ageing_distribution")
      return AGEING_LABELS[filter.slice(7)] || "Ageing claims";
    if (metricId === "operational_health")
      return OPERATIONAL_LABELS[filter.slice(9)] || "Operational health";
    if (metricId === "handler_performance") return "Handler claim population";
    return (
      {
        no_movement_over_14: "No Movement >14 Days",
        no_movement_over_30: "No Movement >30 Days",
        ready_to_close: "Ready to Close",
        sla_breaches: "SLA breaches",
        sla_compliance: "Compliant claims",
        claims_closed: "Closure activity",
      }[metricId] || metricId.replaceAll("_", " ")
    );
  }

  renderDrillClaims(claims) {
    if (!claims.length)
      return `<div class="empty-state"><h3>No claims matched this metric.</h3><p>The report-time population is empty.</p></div>`;
    return `<div class="report-drill-count">${formatInteger(claims.length)} claim${claims.length === 1 ? "" : "s"}</div><div class="report-table-scroll"><table class="report-drill-table"><thead><tr><th scope="col">Claim No.</th><th scope="col">Handler</th><th scope="col">Report status</th><th scope="col">Age</th><th scope="col">Outstanding</th></tr></thead><tbody>${claims.map((row) => `<tr><th scope="row">${escapeHtml(row.source_claim_number || row.claim_id || "Not available")}</th><td>${escapeHtml(row.handler_snapshot || "Unassigned / unresolved")}</td><td>${escapeHtml(row.status_snapshot || "Not available")}</td><td>${escapeHtml(row.calendar_age_snapshot == null ? "—" : formatInteger(row.calendar_age_snapshot))}</td><td>${escapeHtml(formatRand(row.outstanding_snapshot))}</td></tr>`).join("")}</tbody></table></div>`;
  }
}

if (typeof window !== "undefined") {
  window.ScoutReporting = {
    ReportsController,
    canAccessReports,
    createReportingApi,
    createReportState,
    formatRand,
    formatPercent,
    formatComparison,
    formatPeriodLabel,
  };
  window.addEventListener("scout-auth-ready", () => {
    if (
      !window.__scoutReportsController &&
      typeof window.getScoutReportsContext === "function"
    ) {
      const controller = new ReportsController({
        document: window.document,
        getContext: window.getScoutReportsContext,
      });
      if (controller.mount()) window.__scoutReportsController = controller;
    }
  });
  window.openReportsView = (tab) => window.__scoutReportsController?.open(tab);
  window.openManagementAttentionForm = (claim) =>
    window.__scoutReportsController?.openAttentionFromClaim(claim);
  if (window.__scoutAuthReady)
    window.dispatchEvent(new Event("scout-auth-ready"));
}
