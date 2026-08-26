const TIME_ZONE = "Africa/Johannesburg";

export const PDF_TEMPLATE_VERSION = "claims-management-pdf-v1";
export const PDF_RENDERER_VERSION = "cloudflare-browser-run-quick-action";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const METRIC_LABELS = {
  opening_inventory: "Opening inventory",
  closing_inventory: "Closing inventory",
  net_inventory_movement: "Net inventory movement",
  new_claims_registered: "New claims registered",
  new_claims_first_observed: "New claims first observed",
  claims_closed: "Claims closed",
  open_claims_60_plus: "Open claims 60+ days",
  open_claims_91_plus: "Open claims 91+ days",
  sla_compliance: "SLA compliance",
  sla_breaches: "SLA breaches",
  no_movement_over_14: "No movement over 14 days",
  no_movement_over_30: "No movement over 30 days",
  ready_to_close: "Ready to close",
  zero_estimate_payment_request: "Payment request with zero estimate",
  financial_open_outstanding: "Open outstanding exposure",
  financial_estimate_total: "Open estimate total",
  financial_paid_total: "Paid total",
  assignment_activity: "Claims with assignment activity",
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
  "0-30": "0-30 days",
  "31-60": "31-60 days",
  "61-90": "61-90 days",
  "91+": "91+ days",
  unknown: "Unknown date",
};

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
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metric(snapshot, id) {
  return asObject(asObject(snapshot).metrics)[id];
}

function metricAvailable(value) {
  return (
    value &&
    value.availability !== "unavailable" &&
    value.value !== null &&
    value.value !== undefined
  );
}

function formatInteger(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round(number).toLocaleString("en-ZA")
    : "-";
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number)
    ? `R ${Math.round(number).toLocaleString("en-ZA")}`
    : "-";
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "-";
}

function metricValue(snapshot, id, formatter = formatInteger) {
  const item = metric(snapshot, id);
  if (!metricAvailable(item)) {
    return { text: "Data unavailable", available: false, item };
  }
  return { text: formatter(item.value), available: true, item };
}

function comparisonText(snapshot, id, formatter = formatInteger) {
  const comparison = asObject(asObject(snapshot).comparisons)[id];
  const delta = Number(asObject(comparison).absolute_delta);
  if (!Number.isFinite(delta)) return "No prior period";
  if (delta === 0) return "Unchanged vs previous period";
  const direction = delta > 0 ? "Up" : "Down";
  return `${direction} ${formatter(Math.abs(delta))} vs previous period`;
}

function localDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateLabel(value) {
  const date = localDate(value);
  if (!date) return "Not available";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()].slice(0, 3)} ${date.getUTCFullYear()}`;
}

function periodLabel(run, snapshot) {
  const type = run.report_type || snapshot.report_type;
  const start = snapshot.period_start_local_date || run.period_start_local_date;
  if (type === "monthly") {
    const date = localDate(start);
    return date
      ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
      : "Monthly reporting period";
  }
  const end = snapshot.period_end_local_date || run.period_end_local_date;
  const startDate = localDate(start);
  const endDate = localDate(end);
  if (!startDate || !endDate) return "Weekly reporting period";
  const inclusiveEnd = new Date(endDate.getTime());
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
  return `${startDate.getUTCDate()}-${inclusiveEnd.getUTCDate()} ${MONTHS[startDate.getUTCMonth()].slice(0, 3)} ${startDate.getUTCFullYear()}`;
}

function coverageLabel(status) {
  return (
    {
      complete: "Complete",
      usable_with_warnings: "Complete with warnings",
      partial: "Partial coverage",
      insufficient: "Insufficient historical coverage",
    }[status] || "Coverage unavailable"
  );
}

function reportSnapshot(run) {
  const snapshot = asObject(run.metrics_snapshot);
  return Object.keys(snapshot).length ? snapshot : run;
}

function workflowItems(workflow, type) {
  return asArray(
    workflow?.[type === "attention" ? "attention_items" : "action_items"],
  );
}

function workflowValue(item, liveKey, snapshotKey) {
  return item?.[snapshotKey] ?? item?.[liveKey] ?? null;
}

function sortByOrder(left, right) {
  return Number(left.display_order || 0) - Number(right.display_order || 0);
}

function safeStatus(item, type) {
  const value = workflowValue(
    item,
    "status",
    type === "attention" ? "status_snapshot" : "status_snapshot",
  );
  return type === "attention"
    ? ATTENTION_STATUS_LABELS[value] || "Not available"
    : ACTION_STATUS_LABELS[value] || "Not available";
}

function warningText(value) {
  return String(value || "Data-quality warning")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function buildClaimsReportPdfViewModel(run = {}, workflow = {}) {
  const source = asObject(run);
  const snapshot = reportSnapshot(source);
  const coverageStatus =
    snapshot.coverage_status || source.coverage_status || "insufficient";
  const coverage = asObject(snapshot.coverage);
  const attentionItems = workflowItems(workflow, "attention")
    .slice()
    .sort(sortByOrder);
  const actionItems = workflowItems(workflow, "action")
    .slice()
    .sort(sortByOrder);
  const warnings = [
    ...asArray(coverage.warnings),
    ...(workflow.available === false
      ? ["management_workflow_unavailable"]
      : []),
  ];
  const metrics = asObject(snapshot.metrics);
  const handlerValue = asObject(metrics.handler_performance?.value);
  const operationalValue = asObject(metrics.operational_health?.value);
  const ageingValue = asObject(metrics.ageing_distribution?.value);
  const slaValue = asObject(
    metrics.sla_summary?.value || metrics.sla_summary?.details,
  );
  return {
    reportType: source.report_type || snapshot.report_type || "weekly",
    periodLabel: periodLabel(source, snapshot),
    periodStart:
      snapshot.period_start_local_date ||
      source.period_start_local_date ||
      null,
    periodEnd:
      snapshot.period_end_local_date || source.period_end_local_date || null,
    status: source.status || "finalised",
    generatedAt: source.generated_at || null,
    generatedBy: source.generated_by || null,
    finalisedAt: source.finalised_at || null,
    finalisedBy: source.finalised_by || null,
    coverageStatus,
    coverageLabel: coverageLabel(coverageStatus),
    coverage,
    warnings: [...new Set(warnings)],
    snapshot,
    metrics,
    handlerRows: asArray(handlerValue.handlers),
    handlerHeldCount: Number(
      asObject(handlerValue.manager_held_other).count || 0,
    ),
    unresolvedCount: Number(
      asObject(handlerValue.unassigned_unresolved).count || 0,
    ),
    operationalRows: Object.entries(operationalValue),
    ageingRows: Object.entries(ageingValue),
    slaSummary: slaValue,
    attentionItems,
    actionItems,
    workflowAvailable: workflow.available !== false,
  };
}

export function reportPdfFilename(run = {}) {
  const view = buildClaimsReportPdfViewModel(run, {});
  const type = view.reportType === "monthly" ? "Monthly" : "Weekly";
  const date = String(view.periodStart || "report").replace(/[^0-9-]/g, "");
  return `Scout-${type}-Claims-Report-${date}.pdf`;
}

function metricCard(view, id, formatter = formatInteger, className = "") {
  const value = metricValue(view.snapshot, id, formatter);
  return `<article class="kpi-card ${className}"><div class="kpi-label">${escapeHtml(METRIC_LABELS[id] || id)}</div><div class="kpi-value ${value.available ? "" : "is-unavailable"}">${escapeHtml(value.text)}</div><div class="kpi-comparison">${escapeHtml(comparisonText(view.snapshot, id, formatter))}</div></article>`;
}

function tableHeader(cells) {
  return `<thead><tr>${cells.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
}

function emptyRow(colspan, text = "No items in the frozen snapshot.") {
  return `<tr><td colspan="${colspan}" class="empty-cell">${escapeHtml(text)}</td></tr>`;
}

function statusPill(value, type) {
  const tone =
    value === "resolved" || value === "completed"
      ? "positive"
      : value === "waiting"
        ? "warning"
        : "neutral";
  const label =
    type === "attention"
      ? ATTENTION_STATUS_LABELS[value]
      : ACTION_STATUS_LABELS[value];
  return `<span class="status-pill ${tone}">${escapeHtml(label || "Not available")}</span>`;
}

function renderAttention(view) {
  const rows = view.attentionItems
    .map((item) => {
      const status = workflowValue(item, "status", "status_snapshot");
      const category = workflowValue(item, "category", "category_snapshot");
      const owner =
        workflowValue(item, "owner_display", "owner_display_snapshot") ||
        "Unassigned";
      const title =
        workflowValue(item, "title", "title_snapshot") || "Untitled attention";
      const note = workflowValue(
        item,
        "management_note",
        "management_note_snapshot",
      );
      const next = workflowValue(item, "next_action", "next_action_snapshot");
      const due = workflowValue(item, "due_date", "due_date_snapshot");
      const claim =
        workflowValue(item, "claim_number", "claim_number_snapshot") ||
        "Portfolio";
      const lineage = item.carried_forward_from_report_id
        ? "Carried forward"
        : "Current report";
      return `<tr><th scope="row">${escapeHtml(title)}<small>${escapeHtml(claim)} - ${escapeHtml(lineage)}</small></th><td>${escapeHtml(ATTENTION_CATEGORY_LABELS[category] || category || "Other")}</td><td>${statusPill(status, "attention")}</td><td>${escapeHtml(owner)}</td><td>${escapeHtml(next || "Not set")}</td><td>${escapeHtml(due ? dateLabel(due) : "Not set")}</td><td>${escapeHtml(note || "")}</td></tr>`;
    })
    .join("");
  return `<section class="report-section"><div class="section-kicker">Management attention</div><h2>Management Attention</h2><p class="section-intro">Human-selected items requiring management visibility at finalisation.</p><table class="management-table attention-table">${tableHeader(["Attention", "Category", "Status", "Owner", "Next action", "Due", "Management note"])}<tbody>${rows || emptyRow(7)}</tbody></table></section>`;
}

function renderActions(view) {
  const rows = view.actionItems
    .map((item) => {
      const status = workflowValue(item, "status", "status_snapshot");
      const category = workflowValue(item, "category", "category_snapshot");
      const owner =
        workflowValue(item, "owner_display", "owner_display_snapshot") ||
        "Unassigned";
      const action =
        workflowValue(item, "action", "action_snapshot") || "Untitled action";
      const due = workflowValue(item, "due_date", "due_date_snapshot");
      const claim =
        workflowValue(item, "claim_number", "claim_number_snapshot") ||
        "Portfolio";
      const resolution = workflowValue(
        item,
        "resolution_note",
        "resolution_note_snapshot",
      );
      const carried = item.carried_forward_from_report_id
        ? "Carried forward"
        : "Current report";
      return `<tr><th scope="row">${escapeHtml(action)}<small>${escapeHtml(claim)} - ${escapeHtml(carried)}</small></th><td>${escapeHtml(ACTION_CATEGORY_LABELS[category] || category || "Other")}</td><td>${statusPill(status, "action")}</td><td>${escapeHtml(owner)}</td><td>${escapeHtml(due ? dateLabel(due) : "Not set")}</td><td>${escapeHtml(resolution || "")}</td></tr>`;
    })
    .join("");
  return `<section class="report-section"><div class="section-kicker">Action plan</div><h2>Action Plan</h2><p class="section-intro">Actions linked to this report, shown exactly as frozen at finalisation.</p><table class="management-table action-table">${tableHeader(["Action", "Category", "Status", "Owner", "Due", "Resolution note"])}<tbody>${rows || emptyRow(6)}</tbody></table></section>`;
}

function renderAgeing(view) {
  const rows = view.ageingRows
    .map(([key, value]) => {
      const number = Number(value);
      const width =
        Number.isFinite(number) && number > 0 ? Math.min(100, number * 8) : 0;
      return `<tr><th scope="row">${escapeHtml(AGEING_LABELS[key] || key)}</th><td><div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div></td><td class="numeric">${escapeHtml(formatInteger(value))}</td></tr>`;
    })
    .join("");
  return `<section class="report-section"><div class="section-kicker">Claims movement and ageing</div><h2>Claims Movement</h2><div class="two-column"><div><div class="kpi-grid compact-grid">${metricCard(view, "new_claims_registered")}${metricCard(view, "new_claims_first_observed")}${metricCard(view, "claims_closed")}${metricCard(view, "net_inventory_movement")}</div><h3>Management Ageing</h3><table class="simple-table">${tableHeader(["Age band", "Distribution", "Claims"])}<tbody>${rows || emptyRow(3)}</tbody></table></div><aside class="callout"><strong>Closing inventory</strong><span>${escapeHtml(metricValue(view.snapshot, "closing_inventory").text)}</span><p>Open claims at the accepted closing boundary. This is a frozen snapshot value.</p></aside></div></section>`;
}

function renderSla(view) {
  const compliance = metricValue(
    view.snapshot,
    "sla_compliance",
    formatPercent,
  );
  const summary = view.slaSummary;
  return `<section class="report-section"><div class="section-kicker">Service performance</div><h2>SLA Performance</h2><div class="two-column"><div class="sla-panel"><div class="sla-score">${escapeHtml(compliance.text)}</div><div class="sla-caption">SLA compliance</div><div class="bar-track large"><span class="bar-fill positive-fill" style="width:${compliance.available ? Math.min(100, Math.max(0, Number(compliance.item.value) * 100)) : 0}%"></span></div></div><table class="simple-table">${tableHeader(["SLA population", "Claims"])}<tbody><tr><th scope="row">Compliant</th><td class="numeric">${escapeHtml(formatInteger(summary.compliant))}</td></tr><tr><th scope="row">Breached</th><td class="numeric">${escapeHtml(formatInteger(summary.breached))}</td></tr><tr><th scope="row">Unmapped / excluded</th><td class="numeric">${escapeHtml(formatInteger(summary.unmapped))}</td></tr><tr><th scope="row">Denominator</th><td class="numeric">${escapeHtml(formatInteger(summary.denominator))}</td></tr></tbody></table></div><p class="method-note">Compliance uses the deterministic SLA denominator from the closing snapshot. Unmapped statuses are not silently treated as compliant.</p></section>`;
}

function renderOperational(view) {
  const rows = view.operationalRows
    .map(
      ([key, value]) =>
        `<tr><th scope="row">${escapeHtml(OPERATIONAL_LABELS[key] || key)}</th><td class="numeric">${escapeHtml(formatInteger(value))}</td></tr>`,
    )
    .join("");
  return `<section class="report-section"><div class="section-kicker">Operational health</div><h2>Operational Health</h2><table class="simple-table operational-table">${tableHeader(["Category", "Open claims"])}<tbody>${rows || emptyRow(2)}</tbody></table></section>`;
}

function renderHandlers(view) {
  const rows = view.handlerRows
    .map(
      (handler) =>
        `<tr><th scope="row">${escapeHtml(handler.handler_name || handler.handler_email || "Unassigned")}</th><td class="numeric">${escapeHtml(formatInteger(handler.open_claims))}</td><td class="numeric">${escapeHtml(formatInteger(handler.claims_60_plus))}</td><td class="numeric">${escapeHtml(formatInteger(handler.claims_91_plus))}</td><td class="numeric">${escapeHtml(formatInteger(handler.sla_breaches))}</td><td class="numeric">${escapeHtml(formatInteger(handler.no_movement_over_30))}</td><td class="numeric">${escapeHtml(formatInteger(handler.ready_to_close))}</td><td class="numeric">${escapeHtml(formatInteger(handler.reassignments_in))}/${escapeHtml(formatInteger(handler.reassignments_out))}</td></tr>`,
    )
    .join("");
  return `<section class="report-section"><div class="section-kicker">Ownership and workload</div><h2>Handler Performance</h2><table class="management-table handler-table">${tableHeader(["Handler", "Open", "60+ days", "91+ days", "SLA breaches", "No movement 30+", "Ready to close", "Reassign in / out"])}<tbody>${rows || emptyRow(8)}<tr class="subtotal-row"><th scope="row">Manager-held / other</th><td colspan="7">${escapeHtml(formatInteger(view.handlerHeldCount))}</td></tr><tr class="subtotal-row"><th scope="row">Unassigned / unresolved</th><td colspan="7">${escapeHtml(formatInteger(view.unresolvedCount))}</td></tr></tbody></table></section>`;
}

function renderActivity(view) {
  const activity = metric(view.snapshot, "assignment_activity");
  const details = asObject(activity?.details);
  return `<section class="report-section"><div class="section-kicker">Activity and changes</div><h2>Activity &amp; Changes</h2><div class="kpi-grid compact-grid">${metricCard(view, "assignment_activity")}${metricCard(view, "no_movement_over_14")}${metricCard(view, "no_movement_over_30")}${metricCard(view, "ready_to_close")}${metricCard(view, "zero_estimate_payment_request")}</div><p class="method-note">Assignment activity is observed from accepted change history. Reassignments in: ${escapeHtml(formatInteger(details.reassignments_in))}; out: ${escapeHtml(formatInteger(details.reassignments_out))}.</p></section>`;
}

function renderFinancial(view) {
  return `<section class="report-section"><div class="section-kicker">Financial position</div><h2>Financial Position</h2><div class="kpi-grid">${metricCard(view, "financial_open_outstanding", formatCurrency, "financial")}${metricCard(view, "financial_estimate_total", formatCurrency, "financial")}${metricCard(view, "financial_paid_total", formatCurrency, "financial")}</div><p class="method-note">Financial totals are deterministic sums of known values in the frozen open-claim population. Missing source values remain covered by data-quality warnings.</p></section>`;
}

function renderCoverage(view) {
  const warningRows = view.warnings
    .map((warning) => `<li>${escapeHtml(warningText(warning))}</li>`)
    .join("");
  const snapshot = view.snapshot;
  return `<section class="report-section methodology"><div class="section-kicker">Evidence and controls</div><h2>Coverage &amp; Methodology</h2><div class="two-column"><div><dl class="metadata-list"><dt>Coverage</dt><dd>${escapeHtml(view.coverageLabel)}</dd><dt>Report status</dt><dd>${escapeHtml(String(view.status).replace(/^./, (letter) => letter.toUpperCase()))}</dd><dt>Report timezone</dt><dd>${escapeHtml(snapshot.timezone || TIME_ZONE)}</dd><dt>Metric definition version</dt><dd>${escapeHtml(snapshot.metric_definition_version || "Not available")}</dd><dt>Report schema version</dt><dd>${escapeHtml(snapshot.report_schema_version || "Not available")}</dd><dt>Finalised</dt><dd>${escapeHtml(dateLabel(view.finalisedAt))}${view.finalisedBy ? " by authorized management user" : ""}</dd></dl></div><div><p>This management report is rendered from the immutable metrics and management workflow snapshot captured at finalisation. Weekly and monthly reports are independent period snapshots; the monthly view is not composed from weekly reports.</p><p>Due dates and statuses are shown from the finalised snapshot. Overdue state is not recalculated at download time.</p>${warningRows ? `<h3>Coverage warnings</h3><ul class="warning-list">${warningRows}</ul>` : `<p class="success-note">No coverage warnings were recorded.</p>`}</div></div></section>`;
}

function renderHeader(view) {
  const type = view.reportType === "monthly" ? "Monthly" : "Weekly";
  return `<header class="report-header"><div class="brand-mark">SCOUT</div><div><div class="eyebrow">Smartsure Claims Management</div><h1>${escapeHtml(type)} Claims Report</h1><p class="period">${escapeHtml(view.periodLabel)}</p></div><div class="header-meta"><span class="status-pill positive">${escapeHtml(view.status === "archived" ? "Archived" : "Finalised")}</span><span>Coverage: ${escapeHtml(view.coverageLabel)}</span><span>Generated ${escapeHtml(dateLabel(view.generatedAt))}</span></div></header>`;
}

export function renderClaimsReportHtml(run = {}, workflow = {}) {
  const view = buildClaimsReportPdfViewModel(run, workflow);
  const type = view.reportType === "monthly" ? "Monthly" : "Weekly";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scout ${escapeHtml(type)} Claims Report - ${escapeHtml(view.periodLabel)}</title><style>${PDF_CSS}</style></head><body><div class="page-header"><span>SCOUT / CLAIMS MANAGEMENT</span><span>${escapeHtml(view.periodLabel)}</span></div><main>${renderHeader(view)}<section class="report-section executive"><div class="section-kicker">Executive summary</div><h2>Executive Summary</h2><p class="lead">A deterministic ${escapeHtml(type.toLowerCase())} management view of the accepted historical claim population for <strong>${escapeHtml(view.periodLabel)}</strong>. This report is frozen at finalisation and is suitable for management circulation.</p><div class="kpi-grid">${metricCard(view, "closing_inventory")}${metricCard(view, "new_claims_registered")}${metricCard(view, "claims_closed")}${metricCard(view, "sla_compliance", formatPercent)}</div></section>${renderAgeing(view)}${renderSla(view)}${renderOperational(view)}${renderHandlers(view)}${renderActivity(view)}${renderFinancial(view)}${renderAttention(view)}${renderActions(view)}${renderCoverage(view)}</main><footer class="page-footer"><span>Scout management reporting - ${escapeHtml(PDF_TEMPLATE_VERSION)}</span><span>Finalised snapshot | Page <span class="page-number"></span></span></footer></body></html>`;
}

const PDF_CSS = `
@page { size: A4 landscape; margin: 15mm 12mm 16mm; }
:root { color-scheme: light; --ink: #17324d; --muted: #617286; --line: #dce5ec; --wash: #f4f7fa; --blue: #23658b; --teal: #168b85; --amber: #b8781c; --red: #a63d3d; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: var(--ink); font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 1.4; }
body { padding: 16mm 0 13mm; }
.page-header, .page-footer { position: fixed; left: 0; right: 0; color: var(--muted); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; display: flex; justify-content: space-between; }
.page-header { top: 5mm; }
.page-footer { bottom: 5mm; border-top: 1px solid var(--line); padding-top: 2mm; }
.report-header { display: grid; grid-template-columns: 28mm 1fr 58mm; gap: 7mm; align-items: center; border-bottom: 3px solid var(--teal); padding-bottom: 6mm; margin-bottom: 7mm; }
.brand-mark { color: #fff; background: var(--ink); border-radius: 4px; font-weight: 700; letter-spacing: .14em; padding: 8mm 3mm; text-align: center; font-size: 14px; }
.eyebrow, .section-kicker { color: var(--teal); font-size: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 1mm; font-size: 24px; line-height: 1.1; letter-spacing: -.02em; }
h2 { margin-bottom: 3mm; font-size: 16px; line-height: 1.15; }
h3 { margin: 5mm 0 2mm; font-size: 11px; }
.period { color: var(--muted); font-size: 13px; margin: 0; }
.header-meta { display: grid; gap: 2mm; justify-items: end; text-align: right; color: var(--muted); font-size: 9px; }
.report-section { break-inside: avoid; margin: 0 0 8mm; }
.executive { break-inside: auto; }
.section-intro, .lead, .method-note { color: var(--muted); }
.lead { font-size: 12px; max-width: 210mm; margin-bottom: 5mm; }
.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.compact-grid { grid-template-columns: repeat(4, 1fr); }
.kpi-card { min-height: 25mm; background: var(--wash); border: 1px solid var(--line); border-top: 3px solid var(--blue); border-radius: 3px; padding: 3mm; break-inside: avoid; }
.kpi-card.financial { border-top-color: var(--teal); }
.kpi-label { color: var(--muted); font-size: 9px; min-height: 8mm; }
.kpi-value { color: var(--ink); font-size: 19px; font-weight: 700; line-height: 1.1; margin: 2mm 0; }
.kpi-value.is-unavailable { color: var(--amber); font-size: 13px; }
.kpi-comparison { color: var(--muted); font-size: 8px; }
.two-column { display: grid; grid-template-columns: 1.7fr 1fr; gap: 7mm; align-items: start; }
.callout, .sla-panel { border: 1px solid var(--line); background: #fbfcfd; border-radius: 3px; padding: 5mm; }
.callout strong { display: block; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
.callout span { display: block; font-size: 25px; font-weight: 700; margin: 3mm 0; }
.callout p { color: var(--muted); margin: 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { border-bottom: 1px solid var(--line); padding: 2.5mm 2mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--ink); font-weight: 700; }
thead th { background: var(--ink); color: #fff; font-size: 8px; text-transform: uppercase; letter-spacing: .06em; }
tbody th { font-weight: 600; }
td.numeric { text-align: right; white-space: nowrap; }
small { display: block; color: var(--muted); font-size: 8px; font-weight: 400; margin-top: 1mm; }
.simple-table th:first-child { width: 45%; }
.simple-table td { text-align: right; }
.simple-table .empty-cell, .management-table .empty-cell { text-align: left; color: var(--muted); }
.management-table { font-size: 8.5px; }
.attention-table th:nth-child(1) { width: 19%; } .attention-table th:nth-child(2) { width: 11%; } .attention-table th:nth-child(3) { width: 9%; } .attention-table th:nth-child(4) { width: 12%; } .attention-table th:nth-child(5) { width: 16%; } .attention-table th:nth-child(6) { width: 10%; } .attention-table th:nth-child(7) { width: 23%; }
.action-table th:nth-child(1) { width: 29%; } .action-table th:nth-child(2) { width: 13%; } .action-table th:nth-child(3) { width: 11%; } .action-table th:nth-child(4) { width: 15%; } .action-table th:nth-child(5) { width: 11%; } .action-table th:nth-child(6) { width: 21%; }
.handler-table th:nth-child(1) { width: 19%; } .handler-table th:not(:first-child) { width: 11.6%; }
.status-pill { display: inline-block; border-radius: 10px; padding: 1mm 2mm; white-space: nowrap; font-size: 8px; font-weight: 700; background: #edf1f4; color: var(--ink); }
.status-pill.positive { color: #0d625d; background: #dff3f0; } .status-pill.warning { color: #83520e; background: #fff0d6; } .status-pill.neutral { color: #405466; background: #e9eef2; }
.bar-track { height: 5mm; background: #e8edf1; border-radius: 3px; overflow: hidden; min-width: 35mm; }
.bar-track.large { height: 7mm; margin-top: 5mm; }
.bar-fill { display: block; height: 100%; background: var(--blue); border-radius: 3px; }
.positive-fill { background: var(--teal); }
.sla-score { color: var(--teal); font-size: 34px; font-weight: 700; }
.sla-caption { color: var(--muted); text-transform: uppercase; font-size: 8px; letter-spacing: .08em; }
.subtotal-row th, .subtotal-row td { background: var(--wash); color: var(--muted); }
.metadata-list { display: grid; grid-template-columns: 45% 55%; margin: 0; }
.metadata-list dt, .metadata-list dd { border-bottom: 1px solid var(--line); padding: 2mm 0; margin: 0; }
.metadata-list dt { color: var(--muted); } .metadata-list dd { font-weight: 700; overflow-wrap: anywhere; }
.warning-list { margin: 2mm 0 0; padding-left: 5mm; color: var(--amber); }
.success-note { color: var(--teal); font-weight: 700; }
.methodology { break-before: auto; }
@media print { .report-section { break-inside: avoid; } .executive, .handler-table, .attention-table, .action-table { break-inside: auto; } }
`;
