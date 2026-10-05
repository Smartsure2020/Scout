import { identityKey } from "./roles.mjs";

const TIME_ZONE = "Africa/Johannesburg";

export const PDF_TEMPLATE_VERSION = "claims-management-pdf-v9";
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
  claims_left_extract: "Left the extract (not closed)",
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
  high_value: "High value (outstanding)",
  high_value_mandate_attention: "High value / mandate attention", // reports finalised before the split
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
    const details = asObject(item?.details);
    if (details.reason === "financial_aggregation_unresolved") {
      const count = Number(details.unresolved_parent_count);
      if (Number.isFinite(count)) {
        const noun = count === 1 ? "multi-row claim" : "multi-row claims";
        return {
          text: `Unavailable — ${count} ${noun} contain conflicting section-level values.`,
          available: false,
          item,
        };
      }
    }
    return { text: "Data unavailable", available: false, item };
  }
  return { text: formatter(item.value), available: true, item };
}

function comparisonText(snapshot, id, formatter = formatInteger) {
  const comparison = asObject(asObject(snapshot).comparisons)[id];
  const delta = Number(asObject(comparison).absolute_delta);
  if (!Number.isFinite(delta)) return "Comparison unavailable";
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
  const startMonth = MONTHS[startDate.getUTCMonth()].slice(0, 3);
  const endMonth = MONTHS[inclusiveEnd.getUTCMonth()].slice(0, 3);
  const startYear = startDate.getUTCFullYear();
  const endYear = inclusiveEnd.getUTCFullYear();
  if (
    startDate.getUTCMonth() === inclusiveEnd.getUTCMonth() &&
    startYear === endYear
  ) {
    return `${startDate.getUTCDate()}-${inclusiveEnd.getUTCDate()} ${startMonth} ${startYear}`;
  }
  if (startYear === endYear) {
    return `${startDate.getUTCDate()} ${startMonth} - ${inclusiveEnd.getUTCDate()} ${endMonth} ${endYear}`;
  }
  return `${startDate.getUTCDate()} ${startMonth} ${startYear} - ${inclusiveEnd.getUTCDate()} ${endMonth} ${endYear}`;
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
    scorecards: metricAvailable(metrics.handler_scorecards)
      ? asObject(metrics.handler_scorecards.value)
      : null,
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

function metricCard(view, id, formatter = formatInteger, className = "", label = null) {
  const value = metricValue(view.snapshot, id, formatter);
  return `<article class="kpi-card ${className}"><div class="kpi-label">${escapeHtml(label || METRIC_LABELS[id] || id)}</div><div class="kpi-value ${value.available ? "" : "is-unavailable"}">${escapeHtml(value.text)}</div><div class="kpi-comparison">${escapeHtml(comparisonText(view.snapshot, id, formatter))}</div></article>`;
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

function signedInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number === 0) return "No change";
  return `${number > 0 ? "+" : "−"}${formatInteger(Math.abs(number))}`;
}

// `worseWhenUp` colours movement in over-60 (more ageing claims is bad news).
function deltaLabel(current, previous, worseWhenUp = false) {
  if (previous === null || previous === undefined) return "";
  const delta = Number(current) - Number(previous);
  if (!Number.isFinite(delta)) return "";
  const tone =
    delta === 0 || !worseWhenUp ? "flat" : delta > 0 ? "bad" : "good";
  return `<span class="hc-delta ${tone}">${escapeHtml(signedInteger(delta))} vs previous</span>`;
}

function scorecardMetric(label, value, previous, worseWhenUp = false) {
  return `<div class="hc-metric"><span class="hc-label">${escapeHtml(label)}</span><span class="hc-value">${escapeHtml(formatInteger(value))}</span>${deltaLabel(value, previous, worseWhenUp)}</div>`;
}

function renderHandlerCard(card) {
  const previous = asObject(card.previous);
  const hasPrevious = card.previous !== null && card.previous !== undefined;
  const critical = asArray(card.flags).some(
    (flag) => flag.severity === "critical",
  );
  const warning = asArray(card.flags).some(
    (flag) => flag.severity === "warning",
  );
  const tone = critical ? "is-critical" : warning ? "is-warning" : "";
  const oldest =
    card.oldest_open_age_days === null || card.oldest_open_age_days === undefined
      ? "n/a"
      : `${formatInteger(card.oldest_open_age_days)} days`;
  return `<article class="handler-card ${tone}"><header><h3>${escapeHtml(card.label)}</h3><span class="role-tag">${escapeHtml(card.role_label || "Handler")}</span></header>${scorecardMetric("Total Gross Registered", card.gross_registered, hasPrevious ? previous.gross_registered : null)}${scorecardMetric("New Allocated Claims", card.new_allocated, hasPrevious ? previous.new_allocated : null)}${scorecardMetric("Over 60 Days", card.over_60, hasPrevious ? previous.over_60 : null, true)}<footer>91+ days: <strong>${escapeHtml(formatInteger(card.over_91))}</strong> &middot; Oldest open: <strong>${escapeHtml(oldest)}</strong></footer></article>`;
}

const PRIMARY_SCORECARD_ROLES = new Set(["handler", "claims_manager", "management"]);

function holderStatus(card) {
  const tone = card.action === "allocate" ? "critical" : card.action === "confirm" ? "warning" : "neutral";
  return `<span class="status-pill ${tone}">${escapeHtml(card.action_label || "No action")}</span>`;
}

function renderOtherHolders(cards) {
  if (!cards.length) return "";
  const rows = cards
    .map(
      (card) =>
        `<tr><th scope="row">${escapeHtml(card.label)}</th><td>${escapeHtml(card.role_label || "Handler")}</td><td class="numeric">${escapeHtml(formatInteger(card.gross_registered))}</td><td class="numeric">${escapeHtml(formatInteger(card.new_allocated))}</td><td class="numeric">${escapeHtml(formatInteger(card.over_60))}</td><td>${holderStatus(card)}</td></tr>`,
    )
    .join("");
  return `<div class="holders-block"><h3 class="holders-heading">Other claim holders</h3><table class="management-table holders-table">${tableHeader(["Holder", "Role", "Total Gross Registered", "New Allocated Claims", "Over 60 Days", "Action"])}<tbody>${rows}</tbody></table></div>`;
}

function renderScorecards(view) {
  const scorecards = view.scorecards;
  const cards = asArray(scorecards.cards);
  const primary = cards.filter((card) => PRIMARY_SCORECARD_ROLES.has(card.role));
  const others = cards.filter((card) => !PRIMARY_SCORECARD_ROLES.has(card.role));
  const alerts = asObject(scorecards.alerts);
  const alertBox = (alert, tone) =>
    alert
      ? `<div class="alert-box ${tone}"><strong>${escapeHtml(alert.title)}</strong>${escapeHtml(alert.text)}</div>`
      : "";
  const criticalBox = alertBox(alerts.critical, "critical");
  const confirmBox = alertBox(alerts.confirm, "warning");
  const totals = asObject(scorecards.totals);
  const previous = asObject(totals.previous);
  const hasPrevious = totals.previous !== null && totals.previous !== undefined;
  const closed = metricValue(view.snapshot, "claims_closed");
  const left = metricValue(view.snapshot, "claims_left_extract");
  return `<section class="report-section scorecards-section"><div class="section-kicker">Claims performance</div><h2>Claims Performance</h2><p class="section-intro">${escapeHtml(view.periodLabel)}. Open claims only. New Allocated Claims: registered in the period. Over 60 Days: registered more than 60 days before close. Full definitions are under Coverage &amp; Methodology.</p>${criticalBox}${confirmBox}<div class="team-total"><strong>Team total</strong><span>Total Gross Registered <b>${escapeHtml(formatInteger(totals.gross_registered))}</b>${hasPrevious ? deltaLabel(totals.gross_registered, previous.gross_registered) : ""}</span><span>New Allocated Claims <b>${escapeHtml(formatInteger(totals.new_allocated))}</b>${hasPrevious ? deltaLabel(totals.new_allocated, previous.new_allocated) : ""}</span><span>Over 60 Days <b>${escapeHtml(formatInteger(totals.over_60))}</b>${hasPrevious ? deltaLabel(totals.over_60, previous.over_60, true) : ""}</span><span>Terminal closures <b>${escapeHtml(closed.text)}</b></span><span>Left the extract <b>${escapeHtml(left.text)}</b> <small>not closures</small></span></div><div class="handler-cards">${primary.map(renderHandlerCard).join("") || `<p class="empty-cell">No handler data in the frozen snapshot.</p>`}</div>${renderOtherHolders(others)}</section>`;
}

function attentionRowHtml(item) {
  const status = workflowValue(item, "status", "status_snapshot");
  const category = workflowValue(item, "category", "category_snapshot");
  const owner =
    workflowValue(item, "owner_display", "owner_display_snapshot") ||
    "Unassigned";
  const title =
    workflowValue(item, "title", "title_snapshot") || "Untitled attention";
  const note = workflowValue(item, "management_note", "management_note_snapshot");
  const next = workflowValue(item, "next_action", "next_action_snapshot");
  const due = workflowValue(item, "due_date", "due_date_snapshot");
  const claim =
    workflowValue(item, "claim_number", "claim_number_snapshot") || "Portfolio";
  const lineage = item.carried_forward_from_report_id
    ? "Carried forward"
    : "Current report";
  return `<tr><th scope="row">${escapeHtml(title)}<small>${escapeHtml(claim)} - ${escapeHtml(lineage)}</small></th><td>${escapeHtml(ATTENTION_CATEGORY_LABELS[category] || category || "Other")}</td><td>${statusPill(status, "attention")}</td><td>${escapeHtml(owner)}</td><td>${escapeHtml(next || "Not set")}</td><td>${escapeHtml(due ? dateLabel(due) : "Not set")}</td><td>${escapeHtml(note || "")}</td></tr>`;
}

function actionRowHtml(item) {
  const status = workflowValue(item, "status", "status_snapshot");
  const category = workflowValue(item, "category", "category_snapshot");
  const owner =
    workflowValue(item, "owner_display", "owner_display_snapshot") ||
    "Unassigned";
  const action =
    workflowValue(item, "action", "action_snapshot") || "Untitled action";
  const due = workflowValue(item, "due_date", "due_date_snapshot");
  const claim =
    workflowValue(item, "claim_number", "claim_number_snapshot") || "Portfolio";
  const resolution = workflowValue(
    item,
    "resolution_note",
    "resolution_note_snapshot",
  );
  const carried = item.carried_forward_from_report_id
    ? "Carried forward"
    : "Current report";
  return `<tr><th scope="row">${escapeHtml(action)}<small>${escapeHtml(claim)} - ${escapeHtml(carried)}</small></th><td>${escapeHtml(ACTION_CATEGORY_LABELS[category] || category || "Other")}</td><td>${statusPill(status, "action")}</td><td>${escapeHtml(owner)}</td><td>${escapeHtml(due ? dateLabel(due) : "Not set")}</td><td>${escapeHtml(resolution || "")}</td></tr>`;
}

const ATTENTION_HEADERS = ["Attention", "Category", "Status", "Owner", "Next action", "Due", "Management note"];
const ACTION_HEADERS = ["Action", "Category", "Status", "Owner", "Due", "Resolution note"];

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function plural(count, one, many) {
  return `${formatInteger(count)} ${count === 1 ? one : many}`;
}

// Group frozen items by the exact Cardinal handler string recorded with them.
// A card claims an item only through its roster / user aliases; there is no
// first-name guessing. Active handlers always get a group so a missing query is
// visible; items with no handler are "portfolio" items.
function groupItemsByHandler(view, items) {
  const cards = asArray(view.scorecards?.cards);
  const byAlias = new Map();
  for (const card of cards)
    for (const alias of asArray(card.aliases))
      if (!byAlias.has(identityKey(alias))) byAlias.set(identityKey(alias), card);
  const groups = new Map();
  const ensure = (key, label, role, roleLabel) => {
    if (!groups.has(key)) groups.set(key, { key, label, role, roleLabel, items: [] });
    return groups.get(key);
  };
  for (const card of cards)
    if (card.role === "handler") ensure(card.key, card.label, card.role, card.role_label);
  for (const item of items) {
    const raw = text(item?.handler_snapshot ?? item?.claim_handler_snapshot);
    const card = raw ? byAlias.get(identityKey(raw)) : null;
    if (card) ensure(card.key, card.label, card.role, card.role_label).items.push(item);
    else if (raw) ensure(`raw:${identityKey(raw)}`, raw, "unrecognised").items.push(item);
    else ensure("portfolio", "Portfolio & management items", "portfolio").items.push(item);
  }
  const order = new Map(cards.map((card, index) => [card.key, index]));
  const rank = (group) =>
    order.has(group.key) ? order.get(group.key) : group.key === "portfolio" ? 1e6 : 1e5;
  return [...groups.values()]
    .filter((group) => group.items.length || group.role === "handler")
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        String(left.label).localeCompare(String(right.label)),
    );
}

const GROUP_ROLE_LABELS = {
  handler: "Claims handler",
  claims_manager: "Claims manager",
  management: "Management",
  former_handler: "Former handler",
  claims_administrator: "Claims administrator",
  unrecognised: "Unrecognised handler",
};

function groupRoleLabel(group) {
  return group.roleLabel || GROUP_ROLE_LABELS[group.role] || "";
}

function renderHandlerGroups(view, items, rowHtml, headers, nouns, emptyText) {
  return groupItemsByHandler(view, items)
    .map((group) => {
      const role = groupRoleLabel(group);
      const meta = [role, plural(group.items.length, nouns[0], nouns[1])]
        .filter(Boolean)
        .join(" · ");
      const body = group.items.length
        ? `<table class="management-table attention-table">${tableHeader(headers)}<tbody>${group.items.map(rowHtml).join("")}</tbody></table>`
        : `<p class="group-empty">${escapeHtml(emptyText)}</p>`;
      return `<div class="handler-group"><h3>${escapeHtml(group.label)}<small>${escapeHtml(meta)}</small></h3>${body}</div>`;
    })
    .join("");
}

function renderAttention(view) {
  if (view.scorecards) {
    return `<section class="report-section queries-section page-break"><div class="section-kicker">Claims queries</div><h2>Claims Queries &amp; Management Attention</h2><p class="section-intro">Grouped by the handler recorded against each claim. Items not tied to a handler are listed last.</p>${renderHandlerGroups(view, view.attentionItems, attentionRowHtml, ATTENTION_HEADERS, ["query", "queries"], "No queries recorded for this handler.")}</section>`;
  }
  const rows = view.attentionItems.map(attentionRowHtml).join("");
  return `<section class="report-section"><div class="section-kicker">Claims queries</div><h2>Claims Queries &amp; Management Attention</h2><p class="section-intro">Human-selected items requiring management visibility at finalisation.</p><table class="management-table attention-table">${tableHeader(ATTENTION_HEADERS)}<tbody>${rows || emptyRow(7)}</tbody></table></section>`;
}

const ACTION_THEMES = [
  ["Cardinal & system", new Set(["system"])],
  [
    "Queries with insurers, brokers & suppliers",
    new Set(["claim", "insurer", "broker", "supplier", "payment"]),
  ],
  ["Notes & management", null],
];

function ownershipIssues(view) {
  return asArray(view.scorecards?.cards).flatMap((card) =>
    asArray(card.flags)
      .filter((flag) => flag.code !== "cardinal_age_differs")
      .map((flag) => ({ ...flag, label: card.label })),
  );
}

function renderOwnershipIssues(view) {
  const issues = ownershipIssues(view);
  if (!issues.length) return "";
  const rows = issues
    .map(
      (issue) =>
        `<tr><th scope="row">${escapeHtml(issue.label)}</th><td>${escapeHtml(issue.message)}</td><td><span class="status-pill ${issue.severity === "critical" ? "critical" : "warning"}">${issue.severity === "critical" ? "Allocate correct handler" : "Confirm ownership"}</span></td></tr>`,
    )
    .join("");
  return `<div class="ownership-issues"><h3>Ownership issues detected by Scout</h3><table class="management-table ownership-table">${tableHeader(["Holder", "Issue", "Required"])}<tbody>${rows}</tbody></table></div>`;
}

function renderActions(view) {
  if (view.scorecards) {
    const claimed = new Set();
    const themed = ACTION_THEMES.map(([label, categories]) => {
      const items = view.actionItems.filter((item) => {
        if (claimed.has(item)) return false;
        const category = workflowValue(item, "category", "category_snapshot");
        const match = categories ? categories.has(category) : true;
        if (match) claimed.add(item);
        return match;
      });
      return { label, items };
    }).filter((theme) => theme.items.length);
    const body = themed.length
      ? themed
          .map(
            (theme) =>
              `<div class="handler-group"><h3>${escapeHtml(theme.label)}<small>${escapeHtml(plural(theme.items.length, "action", "actions"))}</small></h3><table class="management-table action-table">${tableHeader(ACTION_HEADERS)}<tbody>${theme.items.map(actionRowHtml).join("")}</tbody></table></div>`,
          )
          .join("")
      : `<p class="group-empty">No actions were recorded against this report.</p>`;
    return `<section class="report-section actions-section page-break"><div class="section-kicker">Action plan</div><h2>Recommendations &amp; Action Plan</h2><p class="section-intro">Ownership issues first, then the agreed actions exactly as frozen at finalisation.</p>${renderOwnershipIssues(view)}${body}</section>`;
  }
  const rows = view.actionItems.map(actionRowHtml).join("");
  return `<section class="report-section"><div class="section-kicker">Action plan</div><h2>Recommendations &amp; Action Plan</h2><p class="section-intro">Actions linked to this report, shown exactly as frozen at finalisation.</p><table class="management-table action-table">${tableHeader(ACTION_HEADERS)}<tbody>${rows || emptyRow(6)}</tbody></table></section>`;
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
  return `<section class="report-section keep-together"><div class="section-kicker">Claims movement and ageing</div><h2>Claims Movement</h2><div class="two-column"><div><div class="kpi-grid compact-grid">${metricCard(view, "new_claims_registered")}${metricCard(view, "new_claims_first_observed")}${view.scorecards ? metricCard(view, "claims_closed", formatInteger, "", "Terminal closures") + metricCard(view, "claims_left_extract") : metricCard(view, "claims_closed")}${metricCard(view, "net_inventory_movement")}</div><h3>Management Ageing</h3><table class="simple-table">${tableHeader(["Age band", "Distribution", "Claims"])}<tbody>${rows || emptyRow(3)}</tbody></table></div><aside class="callout"><strong>Closing inventory</strong><span>${escapeHtml(metricValue(view.snapshot, "closing_inventory").text)}</span><p>Open claims at the accepted closing boundary. This is a frozen snapshot value.</p></aside></div>${view.scorecards ? `<p class="method-note">New claims registered counts every claim registered in the period. New Allocated Claims (Claims Performance) counts only those still open at close, attributed to the handler on the closing extract. Terminal closures are claims that reached a terminal status, including Repudiated. Claims that simply disappear from an extract are reported separately as left the extract and are never counted as closed.</p>` : ""}</section>`;
}

function renderSla(view) {
  const compliance = metricValue(
    view.snapshot,
    "sla_compliance",
    formatPercent,
  );
  const summary = view.slaSummary;
  const totalOpen = metricValue(view.snapshot, "closing_inventory");
  return `<section class="report-section keep-together"><div class="section-kicker">Service performance</div><h2>${view.scorecards ? "SLA: Claim Age vs Status Threshold" : "SLA Performance"}</h2><div class="two-column"><div class="sla-panel"><div class="sla-score">${escapeHtml(compliance.text)}</div><div class="sla-caption">${view.scorecards ? "Within status threshold" : "SLA compliance"}</div><div class="bar-track large"><span class="bar-fill positive-fill" style="width:${compliance.available ? Math.min(100, Math.max(0, Number(compliance.item.value) * 100)) : 0}%"></span></div></div><table class="simple-table">${tableHeader(["SLA population", "Claims"])}<tbody><tr><th scope="row">Compliant</th><td class="numeric">${escapeHtml(formatInteger(summary.compliant))}</td></tr><tr><th scope="row">Breached</th><td class="numeric">${escapeHtml(formatInteger(summary.breached))}</td></tr><tr><th scope="row">Unmapped status</th><td class="numeric">${escapeHtml(formatInteger(summary.unmapped))}</td></tr><tr><th scope="row">Age/SLA unavailable</th><td class="numeric">${escapeHtml(formatInteger(summary.unknown))}</td></tr><tr><th scope="row">Total open claims</th><td class="numeric">${escapeHtml(totalOpen.text)}</td></tr><tr><th scope="row">SLA denominator</th><td class="numeric">${escapeHtml(formatInteger(summary.denominator))}</td></tr></tbody></table></div><p class="method-note">Compliance uses the deterministic SLA denominator from the closing snapshot. Unmapped statuses and unavailable ages are shown separately and are not silently treated as compliant.${view.scorecards ? " SLA status compares each claim's total age since registration with its status threshold, so it is a supporting indicator and not a measure of handler performance." : ""}</p></section>`;
}

function renderOperational(view) {
  const rows = view.operationalRows
    .map(
      ([key, value]) =>
        `<tr><th scope="row">${escapeHtml(OPERATIONAL_LABELS[key] || key)}</th><td class="numeric">${escapeHtml(formatInteger(value))}</td></tr>`,
    )
    .join("");
  const health = asObject(metric(view.snapshot, "operational_health")?.details);
  const highValueNote =
    view.scorecards && health.high_value_basis
      ? `High value is based on Outstanding of ${formatCurrency(health.high_value_threshold)} or more; the Mandate column is not used.${
          health.high_value_excluded_multi_row_claim_count > 0
            ? ` ${plural(health.high_value_excluded_multi_row_claim_count, "multi-row claim", "multi-row claims")} whose sections straddle the threshold ${health.high_value_excluded_multi_row_claim_count === 1 ? "is" : "are"} excluded.`
            : ""
        }`
      : "";
  const repudiationUnavailable =
    view.scorecards &&
    view.operationalRows.some(
      ([key, value]) => key === "repudiation_expired" && value === null,
    );
  return `<section class="report-section operational-section"><div class="section-kicker">Operational health</div><h2>Operational Health</h2><table class="simple-table operational-table">${tableHeader(["Category", "Open claims"])}<tbody>${rows || emptyRow(2)}</tbody></table>${highValueNote ? `<p class="method-note">${escapeHtml(highValueNote)}</p>` : ""}${repudiationUnavailable ? `<p class="method-note">Repudiation expired is unavailable: it needs the date a claim was repudiated, which the Cardinal export does not currently supply. Repudiated claims are reported as terminal.</p>` : ""}</section>`;
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
  return `<section class="report-section keep-together"><div class="section-kicker">Activity and changes</div><h2>Activity &amp; Changes</h2><div class="kpi-grid compact-grid">${metricCard(view, "assignment_activity")}${metricCard(view, "no_movement_over_14")}${metricCard(view, "no_movement_over_30")}${metricCard(view, "ready_to_close")}${view.scorecards ? metricCard(view, "zero_estimate_payment_request", formatInteger, "", "Payment status with zero estimate") : metricCard(view, "zero_estimate_payment_request")}</div><p class="method-note">Assignment activity is observed from accepted change history. Reassignments in: ${escapeHtml(formatInteger(details.reassignments_in))}; out: ${escapeHtml(formatInteger(details.reassignments_out))}.${view.scorecards ? " Payment status with zero estimate counts open claims whose status is payment-related and whose estimate is exactly zero; a missing estimate is not zero." : ""}</p></section>`;
}

function financialExclusionNote(view) {
  const parts = [
    ["financial_open_outstanding", "Open outstanding"],
    ["financial_estimate_total", "Estimate"],
    ["financial_paid_total", "Paid"],
  ]
    .map(([id, label]) => {
      const details = asObject(metric(view.snapshot, id)?.details);
      const count = Number(details.excluded_multi_row_claim_count);
      return Number.isFinite(count) && count > 0
        ? `${label}: ${plural(count, "multi-row claim", "multi-row claims")}`
        : null;
    })
    .filter(Boolean);
  if (!parts.length) return "";
  return ` Excluded from these totals because their section amounts are not summed until Cardinal's section semantics are confirmed: ${parts.join("; ")}.`;
}

function renderFinancial(view) {
  return `<section class="report-section keep-together"><div class="section-kicker">Financial position</div><h2>Financial Position</h2><div class="kpi-grid">${metricCard(view, "financial_open_outstanding", formatCurrency, "financial")}${metricCard(view, "financial_estimate_total", formatCurrency, "financial")}${metricCard(view, "financial_paid_total", formatCurrency, "financial")}</div><p class="method-note">Financial totals are deterministic sums of known values in the frozen open-claim population. Missing source values remain covered by data-quality warnings.${escapeHtml(financialExclusionNote(view))}</p></section>`;
}

function renderScorecardDefinitions(view) {
  if (!view.scorecards) return "";
  const definitions = asObject(view.scorecards.definitions);
  const roster = asObject(view.scorecards.roster);
  return `<h3>Handler scorecard definitions</h3><p><strong>Total Gross Registered.</strong> ${escapeHtml(definitions.gross_registered || "")}</p><p><strong>New Allocated Claims.</strong> ${escapeHtml(definitions.new_allocated || "")}</p><p><strong>Over 60 Days.</strong> ${escapeHtml(definitions.over_60 || "")}</p><p>${escapeHtml(asObject(view.scorecards.cardinal_age_check).summary || "")}</p><p>${roster.configured ? `Handler roles come from the reporting roster (${escapeHtml(formatInteger(roster.member_count))} members).` : "No reporting roster is configured, so handler roles were derived from SCOUT user roles."}</p>`;
}

function renderSupportingIntro() {
  return `<section class="report-section supporting-intro page-break"><div class="section-kicker">Supporting intelligence</div><h2>Supporting Intelligence</h2><p class="section-intro">The context behind the headline figures: ageing, service levels, operational exceptions, activity, financial position and data quality. SLA status is a supporting indicator, not a handler-performance measure.</p></section>`;
}

function renderCoverage(view) {
  const warningRows = view.warnings
    .map((warning) => `<li>${escapeHtml(warningText(warning))}</li>`)
    .join("");
  const snapshot = view.snapshot;
  return `<section class="report-section methodology"><div class="section-kicker">Evidence and controls</div><h2>Coverage &amp; Methodology</h2><div class="two-column"><div><dl class="metadata-list"><dt>Coverage</dt><dd>${escapeHtml(view.coverageLabel)}</dd><dt>Report status</dt><dd>${escapeHtml(String(view.status).replace(/^./, (letter) => letter.toUpperCase()))}</dd><dt>Report timezone</dt><dd>${escapeHtml(snapshot.timezone || TIME_ZONE)}</dd><dt>Metric definition version</dt><dd>${escapeHtml(snapshot.metric_definition_version || "Not available")}</dd><dt>Report schema version</dt><dd>${escapeHtml(snapshot.report_schema_version || "Not available")}</dd><dt>Finalised</dt><dd>${escapeHtml(dateLabel(view.finalisedAt))}${view.finalisedBy ? " by authorized management user" : ""}</dd></dl>${renderScorecardDefinitions(view)}</div><div><p>This management report is rendered from the immutable metrics and management workflow snapshot captured at finalisation. Weekly and monthly reports are independent period snapshots; the monthly view is not composed from weekly reports.</p><p>Due dates and statuses are shown from the finalised snapshot. Overdue state is not recalculated at download time.</p>${warningRows ? `<h3>Coverage warnings</h3><ul class="warning-list">${warningRows}</ul>` : `<p class="success-note">No coverage warnings were recorded.</p>`}</div></div></section>`;
}

function renderHeader(view) {
  const type = view.reportType === "monthly" ? "Monthly" : "Weekly";
  return `<header class="report-header"><div class="brand-mark">SCOUT</div><div><div class="eyebrow">Smartsure Claims Management</div><h1>${escapeHtml(type)} Claims Report</h1><p class="period">${escapeHtml(view.periodLabel)}</p></div><div class="header-meta"><span class="status-pill positive">${escapeHtml(view.status === "archived" ? "Archived" : "Finalised")}</span><span>Coverage: ${escapeHtml(view.coverageLabel)}</span><span>Generated ${escapeHtml(dateLabel(view.generatedAt))}</span></div></header>`;
}

export function renderClaimsReportHtml(run = {}, workflow = {}) {
  const view = buildClaimsReportPdfViewModel(run, workflow);
  const type = view.reportType === "monthly" ? "Monthly" : "Weekly";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scout ${escapeHtml(type)} Claims Report - ${escapeHtml(view.periodLabel)}</title><style>${PDF_CSS}</style></head><body><main${view.scorecards ? ' class="scorecard-layout"' : ""}>${renderHeader(view)}${view.scorecards ? "" : `<section class="report-section executive"><div class="section-kicker">Executive summary</div><h2>Executive Summary</h2><p class="lead">A deterministic ${escapeHtml(type.toLowerCase())} management view of the accepted historical claim population for <strong>${escapeHtml(view.periodLabel)}</strong>. This report is frozen at finalisation and is suitable for management circulation.</p><div class="kpi-grid">${metricCard(view, "closing_inventory")}${metricCard(view, "new_claims_registered")}${metricCard(view, "claims_closed")}${metricCard(view, "sla_compliance", formatPercent)}</div></section>`}${view.scorecards ? `${renderScorecards(view)}${renderAttention(view)}${renderActions(view)}${renderSupportingIntro()}${renderAgeing(view)}${renderFinancial(view)}${renderActivity(view)}${renderOperational(view)}${renderSla(view)}` : `${renderAgeing(view)}${renderSla(view)}${renderOperational(view)}${renderHandlers(view)}${renderActivity(view)}${renderFinancial(view)}${renderAttention(view)}${renderActions(view)}`}${renderCoverage(view)}</main></body></html>`;
}

export function renderClaimsReportPdfHeaderTemplate(run = {}, workflow = {}) {
  const { periodLabel } = buildClaimsReportPdfViewModel(run, workflow);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:8px;line-height:10px;letter-spacing:.08em;text-transform:uppercase;color:#617286;width:100%;height:8mm;padding:2mm 12mm 0;box-sizing:border-box"><table style="width:100%;border-collapse:collapse"><tr><td style="padding:0;text-align:left;color:#617286">SCOUT / CLAIMS MANAGEMENT</td><td style="padding:0;text-align:right;color:#617286">${escapeHtml(periodLabel)}</td></tr></table></div>`;
}

export function renderClaimsReportPdfFooterTemplate() {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:#617286;width:100%;padding:0 12mm;box-sizing:border-box"><table style="width:100%;border-collapse:collapse;border-top:1px solid #dce5ec"><tr><td style="padding:2mm 0 0;text-align:left;color:#617286">Scout management reporting - ${escapeHtml(PDF_TEMPLATE_VERSION)}</td><td style="padding:2mm 0 0;text-align:right;color:#617286">Finalised snapshot | Page <span class="pageNumber"></span> of <span class="totalPages"></span></td></tr></table></div>`;
}

const PDF_CSS = `
@page { size: A4 landscape; margin: 14mm 12mm 15mm; }
:root { color-scheme: light; --ink: #17324d; --muted: #617286; --line: #dce5ec; --wash: #f4f7fa; --blue: #23658b; --teal: #168b85; --amber: #b8781c; --red: #a63d3d; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: var(--ink); font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 1.4; }
body { padding: 0; }
.report-header { display: grid; grid-template-columns: 28mm 1fr 58mm; gap: 7mm; align-items: center; border-bottom: 3px solid var(--teal); padding-bottom: 6mm; margin-bottom: 7mm; }
.brand-mark { color: #fff; background: var(--ink); border-radius: 4px; font-weight: 700; letter-spacing: .14em; padding: 8mm 3mm; text-align: center; font-size: 14px; }
.eyebrow, .section-kicker { color: var(--teal); font-size: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 1mm; font-size: 24px; line-height: 1.1; letter-spacing: -.02em; }
h2 { margin-bottom: 3mm; font-size: 16px; line-height: 1.15; break-after: avoid; page-break-after: avoid; }
h3 { margin: 5mm 0 2mm; font-size: 11px; }
.period { color: var(--muted); font-size: 13px; margin: 0; }
.header-meta { display: grid; gap: 2mm; justify-items: end; text-align: right; color: var(--muted); font-size: 9px; }
.report-section { break-inside: auto; margin: 0 0 5mm; }
.executive { break-inside: auto; }
.report-section > .section-kicker { break-after: avoid; page-break-after: avoid; }
.section-intro, .lead, .method-note { color: var(--muted); }
.lead { font-size: 12px; max-width: 210mm; margin-bottom: 5mm; }
.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
.compact-grid { grid-template-columns: repeat(4, 1fr); }
.kpi-card { min-height: 22mm; background: var(--wash); border: 1px solid var(--line); border-top: 3px solid var(--blue); border-radius: 3px; padding: 3mm; break-inside: avoid; }
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
thead tr { break-inside: avoid; page-break-inside: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border-bottom: 1px solid var(--line); padding: 2.5mm 2mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--ink); font-weight: 700; }
thead th { background: var(--ink); color: #fff; font-size: 8px; text-transform: uppercase; letter-spacing: .06em; }
tbody th { font-weight: 600; }
td.numeric { text-align: right; white-space: nowrap; }
small { display: block; color: var(--muted); font-size: 8px; font-weight: 400; margin-top: 1mm; }
.simple-table th:first-child { width: 45%; }
.simple-table td { text-align: right; }
.operational-section { break-inside: avoid; page-break-inside: avoid; }
.operational-table { break-inside: auto; page-break-inside: auto; }
.operational-table thead { display: table-header-group; break-inside: avoid; page-break-inside: avoid; }
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
.methodology .warning-list { columns: 2; column-gap: 6mm; }
.methodology .warning-list li { break-inside: avoid; }
.success-note { color: var(--teal); font-weight: 700; }
.scorecards-section { break-inside: auto; }
.scorecards-section .method-note { font-size: 7.5px; margin: 0; break-inside: avoid; }
.holders-block { break-inside: avoid; page-break-inside: avoid; }
.holders-heading { margin: 2.5mm 0 1.5mm; break-after: avoid; page-break-after: avoid; }
.holders-table { font-size: 8.5px; margin-bottom: 2mm; }
.holders-table th, .holders-table td { padding: 1.4mm 2mm; }
.holders-table th:nth-child(1) { width: 20%; } .holders-table th:nth-child(2) { width: 18%; } .holders-table th:nth-child(n+3):nth-child(-n+5) { width: 12%; } .holders-table th:nth-child(6) { width: 26%; }
.holders-table td.numeric, .holders-table th:nth-child(n+3):nth-child(-n+5) { text-align: right; }
.status-pill.critical { color: #7a1f1f; background: #f8dcdc; }
.handler-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-bottom: 4mm; }
.handler-card { background: #fff; border: 1px solid var(--line); border-top: 3px solid var(--blue); border-radius: 3px; padding: 3mm; break-inside: avoid; page-break-inside: avoid; }
.handler-card.is-warning { border-top-color: var(--amber); }
.handler-card.is-critical { border-top-color: var(--red); background: #fdf5f5; }
.handler-card header { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; border-bottom: 1px solid var(--line); padding-bottom: 2mm; margin-bottom: 1mm; }
.handler-card h3 { margin: 0; font-size: 12px; }
.role-tag { color: var(--muted); font-size: 7px; letter-spacing: .06em; text-transform: uppercase; text-align: right; }
.hc-metric { display: grid; grid-template-columns: 1fr auto; column-gap: 2mm; align-items: baseline; border-bottom: 1px solid var(--line); padding: 1.2mm 0; }
.hc-label { color: var(--muted); font-size: 8px; }
.hc-value { color: var(--ink); font-size: 16px; font-weight: 700; line-height: 1.1; text-align: right; }
.hc-delta { grid-column: 1 / -1; font-size: 7px; color: var(--muted); }
.hc-delta.bad { color: var(--red); } .hc-delta.good { color: var(--teal); }
.handler-card footer { color: var(--muted); font-size: 7.5px; padding-top: 1.6mm; }
.qa-note { display: block; margin-top: 1mm; color: #83520e; }
.alert-box { border-radius: 3px; padding: 1.8mm 3mm; margin: 0 0 2mm; font-size: 8.5px; break-inside: avoid; }
.alert-box strong { display: block; margin-bottom: .6mm; }
.alert-box ul { margin: 0; padding-left: 4.5mm; }
.alert-box.critical { background: #fbeaea; border: 1px solid var(--red); color: #6d1f1f; }
.alert-box.warning { background: #fff6e5; border: 1px solid var(--amber); color: #6b4410; }
.team-total { break-inside: avoid; display: flex; flex-wrap: wrap; gap: 2mm 8mm; align-items: baseline; background: var(--wash); border: 1px solid var(--line); border-radius: 3px; padding: 2.5mm 3mm; margin-bottom: 3mm; font-size: 9px; color: var(--muted); }
.team-total strong { color: var(--ink); text-transform: uppercase; letter-spacing: .08em; font-size: 8px; }
.team-total b { color: var(--ink); font-size: 12px; margin-left: 1mm; }
.team-total .hc-delta { grid-column: auto; margin-left: 1.5mm; }
.keep-together { break-inside: avoid; page-break-inside: avoid; }
.report-section:last-child { margin-bottom: 0; }
.report-section:last-child .two-column > div > :last-child { margin-bottom: 0; }
.scorecard-layout .simple-table th, .scorecard-layout .simple-table td { padding: 1.6mm 2mm; }
.scorecard-layout .compact-grid { grid-template-columns: repeat(5, 1fr); }
.team-total small { font-size: 7.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.scorecard-layout .kpi-card { min-height: 0; padding: 2.2mm 3mm; }
.scorecard-layout .kpi-label { min-height: 6mm; }
.scorecard-layout .metadata-list dt, .scorecard-layout .metadata-list dd { padding: 1.4mm 0; }
.scorecard-layout .methodology h3 { margin: 3mm 0 1.5mm; }
.scorecard-layout .methodology p { font-size: 8.5px; margin-bottom: 1.5mm; }
.page-break { break-before: page; page-break-before: always; }
.supporting-intro { margin-bottom: 3mm; }
.handler-group { margin: 0 0 4mm; }
.handler-group h3 { margin: 0 0 1.5mm; font-size: 11px; break-after: avoid; page-break-after: avoid; }
.handler-group h3 small { display: inline; margin-left: 2mm; color: var(--muted); font-size: 8px; font-weight: 400; }
.group-empty { margin: 0 0 2mm; padding: 2mm 3mm; background: var(--wash); border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font-size: 9px; }
.ownership-issues { margin-bottom: 4mm; }
.ownership-issues h3 { margin: 0 0 1.5mm; font-size: 11px; break-after: avoid; page-break-after: avoid; }
.ownership-table th:nth-child(1) { width: 14%; } .ownership-table th:nth-child(2) { width: 64%; } .ownership-table th:nth-child(3) { width: 22%; }
.methodology { break-before: auto; }
@media print {
  .two-column, .kpi-grid { break-inside: auto; }
  .callout, .sla-panel, .kpi-card { break-inside: avoid; }
  .report-section > h2, .report-section > .section-intro { break-after: avoid; page-break-after: avoid; }
  .handler-table, .attention-table, .action-table { break-inside: auto; }
}
`;
