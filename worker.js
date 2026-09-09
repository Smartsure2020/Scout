/**
 * SCOUT Worker
 *
 * Dashboard API + automated daily email briefings.
 *
 * Required secrets:
 * - SUPABASE_SERVICE_ROLE_KEY
 * - AZURE_CLIENT_SECRET when EMAIL_PROVIDER=graph
 *
 * Required vars:
 * - SUPABASE_URL
 * - AZURE_TENANT_ID, AZURE_CLIENT_ID, MAIL_FROM when EMAIL_PROVIDER=graph
 * - MANAGER_EMAIL
 * - HANDLER_EMAILS_JSON, for example {"Sarah Dzumba":"sarah@example.com"}
 *
 * Optional vars:
 * - ZERO_ESTIMATE_EMAIL
 * - EMAIL_PROVIDER=graph|webhook
 * - EMAIL_WEBHOOK_URL
 * - SUPABASE_EXTRACTS_TABLE=claim_extracts
 * - SUPABASE_CLAIMS_TABLE=claims
 * - SUPABASE_BRIEFING_RUNS_TABLE=briefing_runs
 * - SUPABASE_BRIEFING_DELIVERIES_TABLE=briefing_deliveries
 * - SUPABASE_DIGEST_LOG_TABLE=digest_log
 * - SUPABASE_SETTINGS_TABLE=scout_settings
 * - DIGEST_HISTORY_RETENTION_DAYS=90
 * - SCOUT_CLAIMS_URL=https://your-scout-host/claims/ (optional, for briefing deep links)
 */

import { buildBriefingModel } from "./scout-smartsure/claims/briefing-model.mjs";

const DEFAULT_SEND_TIME = "07:30";
const DEFAULT_MANAGER_EMAIL = "bev@smartsure2020.co.za";
const DEFAULT_TIMEZONE = "Africa/Johannesburg";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const TERMINAL_STATUSES = new Set([
  "closed paid", "closed - finalised", "closed - no cover", "closed - claim documents outstanding",
  "closed - over 30days", "closed - minor damages", "closed - third party damages only",
  "closed - settled by sasria", "closed - client abandoned claim", "closed - claim rejected by insurer",
  "closed - broker proceeding with claim", "closed - handled by insurer.", "closed - settled by insurer",
  "closed - 180 days", "closed - cancelled", "closed - no payments made", "settled", "cancelled",
  "duplicated", "claim prescribed", "claim withdrawn", "rejected", "auto rejected", "advise only",
  "claim within excess", "not taken up",
]);

const PAYMENT_STATUSES = new Set([
  "payment requested", "payment - approved", "payment released", "payment - payments made",
  "payment - pending approval", "requested payment",
]);

const ASSESSOR_MARKERS = ["assessor", "adjuster", "assessment", "engineer", "surveyor"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normaliseStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function parseNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[Rr,\s]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtCurrency(value) {
  const amount = parseNumber(value);
  if (!amount) return "R0";
  return "R" + amount.toLocaleString("en-ZA");
}

function claimNo(claim) {
  return claim.claimNo || claim.claim_no || claim.claim_number || "";
}

function claimStatus(claim) {
  return claim.status || claim.claim_status || "";
}

function claimHandler(claim) {
  return claim.handler || claim.handler_name || claim.claim_handler || "Unassigned";
}

function claimInsured(claim) {
  return claim.insured || claim.insured_name || "Unknown insured";
}

function claimAge(claim) {
  return Number(claim.workingAge ?? claim.working_age ?? claim.age_days ?? claim.age ?? 0);
}

function claimOutstanding(claim) {
  return parseNumber(claim.outstanding ?? claim.outstanding_amount ?? claim.nett_claim ?? 0);
}

function claimEstimate(claim) {
  return parseNumber(claim.estimate ?? claim.cardinal_estimate ?? claim.original_estimate ?? claim.own_damage_original_estimate ?? 0);
}

function claimPaid(claim) {
  return parseNumber(claim.paid ?? claim.paid_amount ?? 0);
}

function claimDol(claim) {
  return claim.dol || claim.date_of_loss || claim.loss_date || "";
}

function isTerminalClaim(claim) {
  return TERMINAL_STATUSES.has(normaliseStatus(claimStatus(claim)));
}

function isLegalClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return status.includes("legal") || status.includes("attorney") || status.includes("ombudsman") ||
    status.includes("fraud") || status.includes("recovery") || status.includes("third party");
}

function isAssessorClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return ASSESSOR_MARKERS.some(marker => status.includes(marker));
}

function isZeroEstimateAnomaly(claim) {
  if (isTerminalClaim(claim)) return false;
  const status = normaliseStatus(claimStatus(claim));
  const estimate = claimEstimate(claim);
  const outstanding = claimOutstanding(claim);
  if (estimate !== 0) return false;
  if (outstanding > 0) return true;
  const actionableStatus = PAYMENT_STATUSES.has(status) ||
    status.includes("authorised") ||
    status.includes("in progress") ||
    isAssessorClaim(claim);
  return actionableStatus || (outstanding === 0 && claimPaid(claim) === 0);
}

function claimFlags(claim) {
  const age = claimAge(claim);
  const status = normaliseStatus(claimStatus(claim));
  const estimate = claimEstimate(claim);
  const outstanding = claimOutstanding(claim);
  const isPaymentStatus = PAYMENT_STATUSES.has(status) || status.includes("payment requested");
  const isActiveOrAssessor = status.includes("active") || status.includes("registered") ||
    status.includes("authorised") || status.includes("in progress") || isAssessorClaim(claim);
  const flags = [];

  if (isPaymentStatus && estimate === 0) {
    flags.push(status === "payment requested"
      ? "Zero estimate — cannot pay without estimate"
      : "Payment requested — zero estimate: review for closure or data error");
  } else if (isActiveOrAssessor && estimate === 0 && age > 14) {
    flags.push("No estimate captured — assessor update needed");
  }
  if (outstanding > 0 && estimate === 0) flags.push("Estimate missing — outstanding value set, estimate not");
  else if (estimate === 0 && outstanding === 0 && !isPaymentStatus && !isTerminalClaim(claim)) {
    flags.push("Zero value claim — possible data error or NTU candidate");
  }
  if (status === "fraud") flags.push("Fraud matter — urgent insurer liaison");
  if (status.includes("ombudsman") || status.includes("nfo")) flags.push("NFO complaint active — urgent management attention");
  if (status.includes("mandate") || outstanding >= 100000) {
    flags.push(outstanding >= 100000 && age > 30 ? "High value — mandate authority required" : "Mandate check");
  }
  if (!isTerminalClaim(claim) && !isLegalClaim(claim)) {
    const movementDays = Number(claim.daysSinceMovement ?? claim.days_since_movement);
    if (Number.isFinite(movementDays) && movementDays > 30) flags.push("No movement in 30 days - review or close");
    else if (Number.isFinite(movementDays) && movementDays > 14) flags.push("No movement in 14+ days — review");
  }
  if (status === "repudiated" && age > 270) flags.push("9-month window closed — close or escalate");
  if (status === "awaiting assessor report" && age > 14) flags.push("Assessor report overdue (target: 7–14 days)");
  if (status === "awaiting investigators report" && age > 14) flags.push("Investigator report overdue (target: 7–12 days)");
  if (status === "awaiting broker feedback" && age > 7) flags.push("Broker unresponsive > 7 days — escalate");
  if (status === "registered" && age > 5) flags.push("New claim unactioned — assign handler immediately");
  if (claim.possibleDuplicate || claim.possible_duplicate) flags.push("Possible duplicate — verify before processing");
  if (isLegalClaim(claim) && age > 60) flags.push("Recovery overdue — monthly attorney update needed");
  if (outstanding > 0 && estimate > 0 && outstanding > estimate * 1.5) flags.push("Outstanding exceeds estimate by 50%+ — review");
  const closureCandidate = getReadyToCloseCandidate(claim);
  if (closureCandidate) flags.push(closureCandidate.flag);
  if (!flags.length && !isTerminalClaim(claim) && age >= 30) flags.push("Aged open claim");
  return flags;
}

function claimPriorityScore(claim) {
  const flags = claimFlags(claim);
  let score = flags.length * 20;
  if (claimAge(claim) >= 30) score += 20;
  if (claimOutstanding(claim) >= 100000) score += 25;
  if (isZeroEstimateAnomaly(claim)) score += 35;
  return score;
}

function isCriticalClaim(claim) {
  const flags = claimFlags(claim);
  return flags.some(flag =>
    flag.includes("cannot pay") ||
    flag.includes("Fraud") ||
    flag.includes("NFO") ||
    flag.includes("High value") ||
    flag.includes("mandate") ||
    flag.includes("9-month") ||
    flag.includes("New claim unactioned")
  ) ||
    claimAge(claim) >= 30 ||
    claimPriorityScore(claim) >= 60;
}

function isStaleClaim(claim) {
  return !isCriticalClaim(claim) && (claimAge(claim) >= 14 || claimFlags(claim).some(flag => flag.includes("14 days")));
}

function isAwaitingBrokerFollowUp(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return status.includes("awaiting broker") ||
    status.includes("broker feedback") ||
    status.includes("reply from broker") ||
    status.includes("broker/client") ||
    status.includes("instructions from broker");
}

function isAssessorReportOverdue(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return isAssessorClaim(claim) &&
    (status.includes("report") || status.includes("feedback") || status.includes("assessor")) &&
    claimAge(claim) >= 7;
}

function isPaymentReady(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return PAYMENT_STATUSES.has(status) || status.includes("payment requested") || status.includes("payment - approved");
}

function hasRecoveryPending(claim) {
  const text = `${claimStatus(claim)} ${claim.description || ""} ${claim.comments || ""}`.toLowerCase();
  return text.includes("recovery pending") || text.includes("awaiting recovery") || text.includes("recoveries pending");
}

function getReadyToCloseCandidate(claim) {
  const status = normaliseStatus(claimStatus(claim));
  if (isTerminalClaim(claim) && !status.startsWith("settled")) return null;
  const age = claimAge(claim);
  const estimate = claimEstimate(claim);
  const recoveryPending = hasRecoveryPending(claim);

  if (status === "repudiated - awaiting closure" && age > 7) {
    return { ruleNo: 1, priority: "P1", flag: "Consider closing — repudiated awaiting closure", action: "Close immediately" };
  }
  if (status === "payment - payments made" && age > 21) {
    return {
      ruleNo: 2,
      priority: "P2",
      flag: "Consider closing — payments confirmed",
      action: recoveryPending ? "Check recovery before closure" : "Close unless recovery",
    };
  }
  if (status === "payment released" && age > 14) {
    return { ruleNo: 3, priority: "P2", flag: "Consider closing — payment released", action: "Close unless excess outstanding" };
  }
  if (status.startsWith("settled") && status !== "settled - awaiting recovery" && age > 14) {
    return { ruleNo: 4, priority: "P2", flag: "Settlement complete — close claim", action: "Close claim" };
  }
  if (status === "payment requested" && estimate === 0 && age > 30) {
    return { ruleNo: 5, priority: "P2", flag: "Zero estimate payment request — data error or NTU", action: "Review data error or NTU" };
  }
  if (status === "registered" && age > 60) {
    return { ruleNo: 6, priority: "P2", flag: "Registered 60+ days — likely abandoned/NTU", action: "Likely abandoned / NTU" };
  }
  return null;
}

function isRiskWatchClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return isLegalClaim(claim) ||
    status.includes("repudiat") ||
    status.includes("mandate") ||
    claimOutstanding(claim) >= 100000;
}

function isReadyToCloseClaim(claim) {
  return !!getReadyToCloseCandidate(claim);
}

function isNoMovement30(claim) {
  const movementDays = Number(claim.daysSinceMovement ?? claim.days_since_movement);
  return !isTerminalClaim(claim) && !isLegalClaim(claim) && Number.isFinite(movementDays) && movementDays > 30;
}

function isNewToday(claim) {
  const status = normaliseStatus(claimStatus(claim));
  const source = String(claim.lastUpdatedSource || claim.last_updated_source || "").toLowerCase();
  return source === "new-claim" || (status === "registered" && claimAge(claim) <= 1);
}

function claimPeril(claim) {
  return claim.peril || claim.peril_type || claim.description || "";
}

function claimAction(claim) {
  const flags = claimFlags(claim);
  if (flags.length) return flags[0];
  if (isPaymentReady(claim)) return "Confirm payment status and close if complete";
  if (isAwaitingBrokerFollowUp(claim)) return "Follow up with broker / client";
  if (isAssessorReportOverdue(claim)) return "Chase assessor report";
  return "Review and progress claim";
}

function sortByPriorityThenAge(a, b) {
  const scoreDiff = claimPriorityScore(b) - claimPriorityScore(a);
  if (scoreDiff) return scoreDiff;
  return claimAge(b) - claimAge(a);
}

function topClaims(claims, limit = 8) {
  return [...claims]
    .filter(claim => !isTerminalClaim(claim))
    .sort(sortByPriorityThenAge)
    .slice(0, limit);
}

function annotateDuplicateClaims(claims) {
  const byKey = new Map();
  claims.forEach(claim => {
    const keyParts = [claimInsured(claim), claimDol(claim), claimPeril(claim), claim.insurer || claim.insurer_name || ""];
    if (keyParts.some(part => !part)) return;
    const key = keyParts.map(part => String(part).trim().toLowerCase()).join("|");
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(claimNo(claim));
  });
  return claims.map(claim => {
    const keyParts = [claimInsured(claim), claimDol(claim), claimPeril(claim), claim.insurer || claim.insurer_name || ""];
    if (keyParts.some(part => !part)) return claim;
    const key = keyParts.map(part => String(part).trim().toLowerCase()).join("|");
    const duplicateClaimNos = [...(byKey.get(key) || [])].filter(no => no && no !== claimNo(claim));
    return duplicateClaimNos.length ? { ...claim, possibleDuplicate: true, duplicateClaimNos } : claim;
  });
}

function makeClaimRows(claims) {
  return claims.map(claim => {
    const flags = claimFlags(claim).join(", ") || "Review";
    return `<tr>
      <td>${escapeHtml(claimNo(claim))}</td>
      <td>${escapeHtml(claimInsured(claim))}</td>
      <td>${escapeHtml(claimStatus(claim))}</td>
      <td style="text-align:right;">${claimAge(claim)}wd</td>
      <td>${escapeHtml(flags)}</td>
    </tr>`;
  }).join("");
}

function emailLayout(title, subtitle, bodyHtml) {
  return `<!doctype html>
<html>
<body style="margin:0;background:#f4f8f8;font-family:Segoe UI,Arial,sans-serif;color:#1a2e2e;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#f4f8f8;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="width:100%;max-width:680px;background:#fff;border:1px solid #e2ecea;border-collapse:separate;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#1e6363;color:#fff;padding:20px 24px;">
          <div style="font-size:20px;font-weight:700;line-height:1.25;">${escapeHtml(title)}</div>
          <div style="font-size:13px;color:#e7f4f1;margin-top:5px;line-height:1.45;">${escapeHtml(subtitle)}</div>
        </td></tr>
        <tr><td style="padding:24px;">${bodyHtml}</td></tr>
        <tr><td style="background:#f4f8f8;border-top:1px solid #e2ecea;padding:14px 24px;text-align:center;color:#6b8582;font-size:12px;line-height:1.5;">Scout · Smartsure Twenty20 · Automated briefing</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function tableHtml(rows) {
  if (!rows.length) return `<p style="color:#6b8582;">No claims require attention for this briefing.</p>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#f4f8f8;">
        <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Claim</th>
        <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Insured</th>
        <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Status</th>
        <th style="text-align:right;padding:9px;border-bottom:1px solid #e2ecea;">Age</th>
        <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Focus</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function handlerSection(title, rows, emptyText = "No claims in this section.") {
  const sectionRows = rows.length
    ? rows.map(row => `<div style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.55;padding:3px 0;color:#1a2e2e;">${row}</div>`).join("")
    : `<div style="color:#7a9b98;font-size:13px;padding:3px 0;">${escapeHtml(emptyText)}</div>`;
  return `
    <div style="margin-top:22px;">
      <div style="font-size:13px;font-weight:800;color:#1e6363;letter-spacing:.5px;border-bottom:1px solid #e2ecea;padding-bottom:7px;margin-bottom:8px;">${escapeHtml(title)}</div>
      ${sectionRows}
    </div>`;
}

function handlerLine(claim, extra) {
  return `${escapeHtml(claimNo(claim))} - ${escapeHtml(claimInsured(claim))} - ${escapeHtml(claimStatus(claim))} - ${extra}`;
}

function managerMetricLine(label, value, detail = "") {
  return `<div style="font-family:Consolas,'Courier New',monospace;font-size:13.5px;line-height:1.7;">
    <strong>${escapeHtml(label.padEnd(28, " "))}</strong> ${value}${detail ? ` <span style="color:#6b8582;">${escapeHtml(detail)}</span>` : ""}
  </div>`;
}

function managerRiskLine(claim) {
  return `${escapeHtml(claimNo(claim))} - ${escapeHtml(claimInsured(claim))} - ${escapeHtml(claimStatus(claim))} - ${escapeHtml(claimFlags(claim).join(", ") || "Risk review")}`;
}

function canonicalBriefingLabel(label) {
  const text = String(label || "").trim();
  if (!text) return "Review claim progress";
  if (/^sla breached$/i.test(text)) return "Critical SLA breach";
  if (/^near sla$/i.test(text)) return "SLA at risk";
  if (/zero[- ]estimate anomaly|zero estimate/i.test(text)) return "Zero estimate anomaly";
  if (/mandate|over mandate/i.test(text)) return "Mandate authority required";
  if (/no movement/i.test(text)) return "No movement";
  if (/assessor report overdue/i.test(text)) return "Assessor report overdue";
  if (/investigator report overdue/i.test(text)) return "Investigator report overdue";
  if (/broker unresponsive|awaiting .*broker|awaiting .*client|broker\/client/i.test(text)) return "Awaiting external response";
  if (/payment[s]? pending|awaiting payment/i.test(text)) return "Payment pending";
  if (/ready to close|possible closure|closure review|consider closing|settlement complete/i.test(text)) return "Closure candidate";
  return text.replace(/\s+-\s+/g, " — ").replace(/\s{2,}/g, " ");
}

function briefingPrimaryReason(claim) {
  return canonicalBriefingLabel(claimFlags(claim)[0] || "Review claim progress");
}

function briefingNextAction(claim) {
  if (isCriticalClaim(claim)) return "Review the critical SLA and progress the next step";
  if (claimOutstanding(claim) >= 100000 || normaliseStatus(claimStatus(claim)).includes("mandate")) return "Review authority and management decision";
  if (isZeroEstimateAnomaly(claim)) return "Validate estimate and payment or closure state";
  if (isAssessorReportOverdue(claim)) return "Chase assessor report";
  if (isAwaitingBrokerFollowUp(claim)) return "Follow up with broker or client";
  if (isPaymentReady(claim)) return "Confirm payment status and close if complete";
  const closure = getReadyToCloseCandidate(claim);
  if (closure) return closure.action;
  return "Review and progress claim";
}

function workerScoutBaseUrl(options = {}) {
  const raw = options.scoutClaimsUrl || options.scoutBaseUrl || "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/\/claims\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/+$/, "") + "/claims/";
    } else if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function workerScoutUrl(options, params) {
  const url = workerScoutBaseUrl(options);
  if (!url) return "";
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function workerBriefingModel(claims, previousClaims, options = {}) {
  return buildBriefingModel(claims, {
    getClaimNo: claimNo,
    getHandler: claimHandler,
    getInsured: claimInsured,
    getAge: claimAge,
    getScore: claimPriorityScore,
    getOutstanding: claimOutstanding,
    isTerminal: isTerminalClaim,
    isSettled: claim => normaliseStatus(claimStatus(claim)).startsWith("settled"),
    isCritical: isCriticalClaim,
    isStale: isStaleClaim,
    isZeroEstimate: isZeroEstimateAnomaly,
    isRisk: isRiskWatchClaim,
    isMandate: claim => claimOutstanding(claim) >= 100000 || normaliseStatus(claimStatus(claim)).includes("mandate"),
    isClosure: isReadyToCloseClaim,
    isNoMovement: isNoMovement30,
    isAwaitingExternal: isAwaitingBrokerFollowUp,
    isAssessorOverdue: isAssessorReportOverdue,
    isPayment: isPaymentReady,
    isNew: isNewToday,
    getPrimaryReason: briefingPrimaryReason,
    getNextAction: briefingNextAction,
    claimUrl: claim => workerScoutUrl(options, { view: "claim", claim: claimNo(claim) }),
    handlerUrl: handler => workerScoutUrl(options, { view: "claims", handler }),
    exceptionUrl: (exception, handler) => workerScoutUrl(options, { view: "exceptions", exception, handler }),
  }, {
    includeTerminalClaims: options.includeTerminalClaims,
    includeSettled: options.includeSettled === true,
    comparisonAvailable: options.comparisonAvailable,
    previousClaims,
    extractDate: options.extract?.extract_date || options.extract?.effective_date || null,
    freshness: { label: extractFreshnessLine(options.extract) },
    generatedDate: options.runDate || null,
  });
}

function workerEmailLink(url, label) {
  return url
    ? `<a href="${escapeHtml(url)}" style="color:#1e6363;text-decoration:underline;font-weight:700;">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

function workerEmailSectionTitle(title) {
  return `<div style="font-size:14px;font-weight:700;color:#1e6363;padding-bottom:7px;border-bottom:1px solid #e2ecea;margin:24px 0 10px;">${escapeHtml(title)}</div>`;
}

function workerClaimTable(items, emptyText = "No claims require attention.") {
  if (!items.length) return `<p style="margin:0;color:#6b8582;font-size:13px;">${escapeHtml(emptyText)}</p>`;
  return `<table role="table" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:#f4f8f8;">
      <th align="left" style="padding:8px;border-bottom:1px solid #e2ecea;">Claim</th>
      <th align="left" style="padding:8px;border-bottom:1px solid #e2ecea;">Insured</th>
      <th align="left" style="padding:8px;border-bottom:1px solid #e2ecea;">Primary reason</th>
      <th align="left" style="padding:8px;border-bottom:1px solid #e2ecea;">Next action</th>
    </tr></thead><tbody>${items.map(item => `<tr>
      <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${workerEmailLink(item.url, item.claimNo)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${escapeHtml(item.insured)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${escapeHtml(item.primaryReason)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${escapeHtml(item.nextAction)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function workerMetricTable(metrics, links = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr>${metrics.map(metric => `<td width="25%" style="width:25%;padding:10px 8px 10px 0;vertical-align:top;">
      <div style="font-size:22px;font-weight:700;color:#1a2e2e;line-height:1.15;">${links[metric.key] ? workerEmailLink(links[metric.key], metric.value) : escapeHtml(metric.value)}</div>
      <div style="font-size:11px;color:#6b8582;margin-top:4px;line-height:1.35;">${escapeHtml(metric.label)}</div>
    </td>`).join("")}</tr>
  </table>`;
}

function buildHandlerBriefing(handler, claims, runDate, options = {}) {
  const model = workerBriefingModel(claims, options.previousClaims, { ...options, includeSettled: false, runDate });
  const sections = model.handler.sections;
  const firstName = handler.split(" ")[0] || handler;
  const extractDate = model.extractDate ? formatExtractDateForBriefing(model.extractDate) : "Extract date unavailable";
  const section = (title, data, emptyText) => `${workerEmailSectionTitle(title)}${workerClaimTable(data.items, emptyText)}${data.hasMore ? `<p style="margin:7px 0 0;font-size:12px;color:#6b8582;">View all ${data.total} in Scout.</p>` : ""}`;
  const body = `
    <div style="font-size:13px;color:#6b8582;margin-bottom:4px;">${escapeHtml(runDate)} · Data as at: <strong style="color:#1a2e2e;">${escapeHtml(extractDate)}</strong></div>
    <div style="font-size:13px;color:#6b8582;margin-bottom:18px;">${escapeHtml(extractFreshnessLine(options.extract))}${model.comparisonAvailable ? "" : " · Comparison unavailable"}</div>
    ${workerEmailSectionTitle("YOUR WORKLOAD")}
    ${workerMetricTable([
      { key: "active", label: "Active claims", value: String(model.handler.active.length) },
      { key: "critical", label: "Critical SLA", value: String(model.handler.critical.length) },
      { key: "stale", label: "SLA at risk", value: String(model.handler.stale.length) },
      { key: "new", label: "New claims", value: model.metrics.newClaims == null ? "—" : String(model.metrics.newClaims) },
    ], { critical: workerScoutUrl(options, { view: "exceptions", exception: "critical", handler }), stale: workerScoutUrl(options, { view: "exceptions", exception: "sla-risk", handler }) })}
    ${section("URGENT TODAY", sections.urgent, "No urgent claims require action today.")}
    ${section("DECISIONS / AUTHORITY", sections.decision, "No authority decisions require attention.")}
    ${section("OVERDUE FOLLOW-UPS", sections.followup, "No overdue follow-ups in the briefing.")}
    ${section("PAYMENT / ESTIMATE WORK", sections.payment, "No payment or estimate exceptions in the briefing.")}
    ${section("CLOSURE CANDIDATES", sections.closure, "No closure candidates in the briefing.")}
    ${model.comparisonAvailable ? section("NEW CLAIMS", sections.new, "No new claims in the briefing.") : ""}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2ecea;">${workerEmailLink(workerScoutUrl(options, { view: "claims", handler }), "Open My Claims →")} &nbsp; ${workerEmailLink(workerScoutUrl(options, { view: "today" }), "Open Today's Priorities")}</div>
  `;
  return {
    subject: `Scout Daily Briefing - ${firstName} - ${runDate}`,
    html: emailLayout("Scout Daily Briefing", `${handler} · My work for today`, body),
    text: `Scout Daily Briefing - ${handler} - ${runDate}. Active: ${model.handler.active.length}. Critical SLA: ${model.handler.critical.length}. SLA at risk: ${model.handler.stale.length}. ${model.comparisonAvailable ? `New: ${model.metrics.newClaims}.` : "New: Comparison unavailable."} Open My Claims: ${workerScoutUrl(options, { view: "claims", handler }) || "Scout"}`,
  };
}

function formatExtractDateForBriefing(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "Extract date unavailable";
  return new Intl.DateTimeFormat("en-ZA", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`));
}

function extractFreshnessLine(extract) {
  const extractDate = extract?.extract_date || extract?.effective_date || "";
  const match = String(extractDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "Unavailable · Extract date unavailable";
  const dateLabel = new Intl.DateTimeFormat("en-ZA", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`));
  const today = localDateParts(new Date(), DEFAULT_TIMEZONE).dateKey;
  const quality = extract?.quality_summary || {};
  const warningCount = Number(quality.issueCount ?? quality.issue_count ?? 0) ||
    (Array.isArray(quality.warnings) ? quality.warnings.length : 0);
  const state = extractDate < today ? "Stale" : warningCount > 0 ? "Loaded with warnings" : "Current";
  const received = extract?.received_at || extract?.uploaded_at || extract?.created_at;
  const receivedDate = received ? new Date(received) : null;
  const receivedLabel = receivedDate && !Number.isNaN(receivedDate.getTime())
    ? new Intl.DateTimeFormat("en-ZA", { timeZone: DEFAULT_TIMEZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(receivedDate)
    : "";
  return `${state} · Extract ${dateLabel}${receivedLabel ? ` · Received ${receivedLabel}` : ""}${warningCount ? ` · ${warningCount} data quality warning${warningCount === 1 ? "" : "s"}` : ""}`;
}

function buildManagerBriefing(claims, runDate, previousClaims = null, options = {}) {
  const model = workerBriefingModel(claims, previousClaims, { ...options, includeSettled: true, runDate });
  const metricLinks = {
    critical: workerScoutUrl(options, { view: "exceptions", exception: "critical" }),
    stale: workerScoutUrl(options, { view: "exceptions", exception: "sla-risk" }),
  };
  const attentionRows = model.attention.map(item => `<tr>
    <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;"><strong>${escapeHtml(item.label)}</strong></td>
    <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${escapeHtml(String(item.count))}</td>
    <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${escapeHtml(item.action)}</td>
    <td style="padding:9px 8px;border-bottom:1px solid #edf3f2;vertical-align:top;">${workerEmailLink(item.url, "Open queue →")}</td>
  </tr>`).join("");
  const teamRows = model.team.map(row => `<tr>
    <td style="padding:8px;border-bottom:1px solid #edf3f2;">${workerEmailLink(row.url, row.handler)}</td>
    <td style="padding:8px;border-bottom:1px solid #edf3f2;text-align:right;">${row.active}</td>
    <td style="padding:8px;border-bottom:1px solid #edf3f2;text-align:right;">${row.critical ? workerEmailLink(row.criticalUrl, String(row.critical)) : "0"}</td>
    <td style="padding:8px;border-bottom:1px solid #edf3f2;text-align:right;">${row.stale}</td>
    <td style="padding:8px;border-bottom:1px solid #edf3f2;">${escapeHtml(row.primaryBlocker)}</td>
  </tr>`).join("");
  const attentionTable = attentionRows
    ? `<table role="table" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f4f8f8;"><th align="left" style="padding:8px;">Issue</th><th align="left" style="padding:8px;">Count</th><th align="left" style="padding:8px;">Recommended next action</th><th align="left" style="padding:8px;">Scout</th></tr></thead><tbody>${attentionRows}</tbody></table>`
    : `<p style="margin:0;color:#6b8582;font-size:13px;">No priority concerns in this extract.</p>`;
  const teamTable = teamRows
    ? `<table role="table" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f4f8f8;"><th align="left" style="padding:8px;">Handler</th><th align="right" style="padding:8px;">Active</th><th align="right" style="padding:8px;">Critical</th><th align="right" style="padding:8px;">SLA at risk</th><th align="left" style="padding:8px;">Primary blocker</th></tr></thead><tbody>${teamRows}</tbody></table>`
    : `<p style="margin:0;color:#6b8582;font-size:13px;">No handler data.</p>`;
  const body = `
    <div style="font-size:13px;color:#6b8582;margin-bottom:4px;">${escapeHtml(runDate)} · Data as at: <strong style="color:#1a2e2e;">${escapeHtml(model.extractDate ? formatExtractDateForBriefing(model.extractDate) : "Extract date unavailable")}</strong></div>
    <div style="font-size:13px;color:#6b8582;margin-bottom:18px;">${escapeHtml(extractFreshnessLine(options.extract))} · ${escapeHtml(model.comparisonLabel)}</div>
    ${workerEmailSectionTitle("PORTFOLIO HEALTH")}
    ${workerMetricTable([
      { key: "active", label: "Active claims", value: String(model.metrics.active) },
      { key: "critical", label: "Critical SLA", value: String(model.metrics.critical) },
      { key: "stale", label: "SLA at risk", value: String(model.metrics.stale) },
      { key: "exposure", label: "Outstanding exposure", value: `R${(model.metrics.exposure / 1000000).toFixed(2)}m` },
    ], metricLinks)}
    ${workerEmailSectionTitle("REQUIRES ATTENTION")}
    ${attentionTable}
    <p style="margin:8px 0 0;color:#6b8582;font-size:12px;">Counts may overlap; one claim can appear in more than one action queue.</p>
    ${workerEmailSectionTitle("TEAM SUMMARY")}
    ${teamTable}
    ${workerEmailSectionTitle("TOP RISKS")}
    ${workerClaimTable(model.topRisks.items, "No top risks flagged.")}${model.topRisks.hasMore ? `<p style="margin:7px 0 0;font-size:12px;color:#6b8582;">View all ${model.topRisks.total} in Scout.</p>` : ""}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2ecea;">${workerEmailLink(workerScoutUrl(options, { view: "today" }), "Open Morning Action Board →")} &nbsp; ${workerEmailLink(workerScoutUrl(options, { view: "manager" }), "Open Manager Summary")}</div>
  `;
  return {
    subject: `Scout Manager Briefing - ${runDate}`,
    html: emailLayout("Scout Manager Briefing", runDate, body),
    text: `Scout Manager Briefing - ${runDate}. Active: ${model.metrics.active}. Critical SLA: ${model.metrics.critical}. SLA at risk: ${model.metrics.stale}. Exposure: R${(model.metrics.exposure / 1000000).toFixed(2)}m. ${model.comparisonLabel}. Open Morning Action Board: ${workerScoutUrl(options, { view: "today" }) || "Scout"}`,
  };
}

function buildZeroEstimateDigest(claims, runDate) {
  const zero = claims.filter(isZeroEstimateAnomaly);
  const body = `
    <p style="margin-top:0;">Zero-estimate anomaly digest for compliance / operations.</p>
    ${tableHtml(makeClaimRows(zero))}
  `;
  return {
    subject: `Scout - Zero Estimate Anomaly digest - ${runDate}`,
    html: emailLayout("Zero Estimate Anomaly digest", runDate, body),
    text: `Scout zero-estimate anomaly digest. Count: ${zero.length}.`,
  };
}

function userEmail(user) {
  return String(user?.mail || user?.userPrincipalName || user?.email || "").toLowerCase();
}

function parseJsonEnv(env, key, fallback) {
  try {
    return JSON.parse(env[key] || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function canViewDigestHistory(env, user) {
  const email = userEmail(user);
  if (!email) return false;
  const managerEmail = String(env.MANAGER_EMAIL || DEFAULT_MANAGER_EMAIL).toLowerCase();
  const adminEmails = parseJsonEnv(env, "ADMIN_EMAILS_JSON", []);
  const managerEmails = parseJsonEnv(env, "MANAGER_EMAILS_JSON", []);
  return email === managerEmail ||
    adminEmails.map(v => String(v).toLowerCase()).includes(email) ||
    managerEmails.map(v => String(v).toLowerCase()).includes(email);
}

function isAdminUser(env, user) {
  const email = userEmail(user);
  if (!email) return false;
  const adminEmails = parseJsonEnv(env, "ADMIN_EMAILS_JSON", []);
  return adminEmails.map(v => String(v).toLowerCase()).includes(email);
}

function parseHandlerEmails(env) {
  try {
    return JSON.parse(env.HANDLER_EMAILS_JSON || "{}");
  } catch {
    return {};
  }
}

function normaliseSettings(env, raw = {}) {
  const handlerEmails = raw.handler_emails && typeof raw.handler_emails === "object"
    ? raw.handler_emails
    : parseHandlerEmails(env);
  const managerEmail = String(raw.manager_email || env.MANAGER_EMAIL || DEFAULT_MANAGER_EMAIL).trim();
  return {
    send_time: String(raw.send_time || env.DIGEST_SEND_TIME || DEFAULT_SEND_TIME).slice(0, 5),
    handler_emails: handlerEmails,
    manager_email: managerEmail,
    zero_estimate_email: String(raw.zero_estimate_email || env.ZERO_ESTIMATE_EMAIL || managerEmail).trim(),
    include_terminal_claims: Boolean(raw.include_terminal_claims),
    last_digest_sent_date: raw.last_digest_sent_date || null,
  };
}

function supabaseHeaders(env, preferRepresentation = false) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(preferRepresentation ? { Prefer: "return=representation" } : {}),
  };
}

function supabaseUrl(env, path) {
  return `${String(env.SUPABASE_URL || "").replace(/\/+$/, "")}/rest/v1/${path}`;
}

async function supabaseFetch(env, path, init = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase is not configured");
  }
  const res = await fetch(supabaseUrl(env, path), {
    ...init,
    headers: { ...supabaseHeaders(env, init.method === "POST"), ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return data;
}

async function getDigestSettings(env) {
  const table = env.SUPABASE_SETTINGS_TABLE || "scout_settings";
  try {
    const rows = await supabaseFetch(env, `${table}?select=value&id=eq.digest&limit=1`);
    const value = Array.isArray(rows) && rows[0] ? rows[0].value : {};
    return normaliseSettings(env, value || {});
  } catch (err) {
    console.warn("Digest settings fallback used:", err.message);
    return normaliseSettings(env, {});
  }
}

async function saveDigestSettings(env, patch) {
  const current = await getDigestSettings(env);
  const next = normaliseSettings(env, { ...current, ...patch });
  if (!/^\d{2}:\d{2}$/.test(next.send_time)) throw new Error("Send time must be HH:mm");

  const table = env.SUPABASE_SETTINGS_TABLE || "scout_settings";
  const rows = await supabaseFetch(env, `${table}?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      id: "digest",
      value: next,
      updated_at: new Date().toISOString(),
    }),
  });
  return normaliseSettings(env, Array.isArray(rows) && rows[0] ? rows[0].value : next);
}

async function setLastDigestSentDate(env, dateKey) {
  const current = await getDigestSettings(env);
  await saveDigestSettings(env, { ...current, last_digest_sent_date: dateKey });
}

function localDateParts(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

function sendTimeMinutes(sendTime) {
  const [hour, minute] = String(sendTime || DEFAULT_SEND_TIME).split(":").map(Number);
  return (Number.isFinite(hour) ? hour : 7) * 60 + (Number.isFinite(minute) ? minute : 30);
}

async function maybeRunScheduledBriefing(env) {
  const settings = await getDigestSettings(env);
  const now = localDateParts(new Date(), env.DIGEST_TIMEZONE || DEFAULT_TIMEZONE);
  const target = sendTimeMinutes(settings.send_time);
  const isDue = now.minutes >= target && now.minutes < target + 15;
  if (!isDue || settings.last_digest_sent_date === now.dateKey) {
    return { skipped: true, reason: "not due", sendTime: settings.send_time };
  }

  const result = await runDailyBriefings(env, "cron", settings);
  await setLastDigestSentDate(env, now.dateKey);
  return result;
}

async function pruneDigestHistory(env) {
  const days = Number(env.DIGEST_HISTORY_RETENTION_DAYS || 90);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const table = env.SUPABASE_DIGEST_LOG_TABLE || "digest_log";
  try {
    await supabaseFetch(env, `${table}?generated_at=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE" });
  } catch (err) {
    console.warn("Digest retention prune skipped:", err.message);
  }
}

async function getLatestExtractClaims(env) {
  const extractsTable = env.SUPABASE_EXTRACTS_TABLE || "claim_extracts";
  const claimsTable = env.SUPABASE_CLAIMS_TABLE || "claims";
  let extractRows;
  try {
    extractRows = await supabaseFetch(env, `${extractsTable}?select=*&order=extract_date.desc,uploaded_at.desc&limit=2`);
  } catch {
    extractRows = await supabaseFetch(env, `${extractsTable}?select=*&order=created_at.desc&limit=2`);
  }
  const extract = Array.isArray(extractRows) ? extractRows[0] : null;
  const previousExtract = Array.isArray(extractRows) ? extractRows[1] : null;
  if (!extract) return { extract: null, previousExtract: null, claims: [], previousClaims: [] };

  const extractId = extract.id || extract.extract_id;
  const claims = extractId
    ? await supabaseFetch(env, `${claimsTable}?select=*&extract_id=eq.${encodeURIComponent(extractId)}&limit=5000`)
    : await supabaseFetch(env, `${claimsTable}?select=*&order=created_at.desc&limit=5000`);
  const previousExtractId = previousExtract?.id || previousExtract?.extract_id;
  const previousClaims = previousExtractId
    ? await supabaseFetch(env, `${claimsTable}?select=*&extract_id=eq.${encodeURIComponent(previousExtractId)}&limit=5000`)
    : [];

  return {
    extract,
    previousExtract,
    claims: Array.isArray(claims) ? claims : [],
    previousClaims: Array.isArray(previousClaims) ? previousClaims : [],
  };
}

async function getGraphToken(env) {
  const tokenUrl = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    client_secret: env.AZURE_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || "Graph token failed");
  return data.access_token;
}

async function sendGraphEmail(env, to, message) {
  if (!to) return { skipped: true, reason: "missing recipient" };
  const token = await getGraphToken(env);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: "HTML", content: message.html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail failed ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function sendWebhookEmail(env, to, message) {
  if (!env.EMAIL_WEBHOOK_URL) throw new Error("EMAIL_WEBHOOK_URL is not configured");
  if (!to) return { skipped: true, reason: "missing recipient" };
  const res = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, ...message }),
  });
  if (!res.ok) throw new Error(`Email webhook failed ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function sendEmail(env, to, message) {
  const provider = env.EMAIL_PROVIDER || "graph";
  if (provider === "webhook") return sendWebhookEmail(env, to, message);
  return sendGraphEmail(env, to, message);
}

async function createBriefingRun(env, details) {
  const table = env.SUPABASE_BRIEFING_RUNS_TABLE || "briefing_runs";
  try {
    const rows = await supabaseFetch(env, table, {
      method: "POST",
      body: JSON.stringify(details),
    });
    return Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.warn("Briefing run log skipped:", err.message);
    return null;
  }
}

async function updateBriefingRun(env, runId, details) {
  if (!runId) return null;
  const table = env.SUPABASE_BRIEFING_RUNS_TABLE || "briefing_runs";
  try {
    const rows = await supabaseFetch(env, `${table}?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(details),
    });
    return Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.warn("Briefing run update skipped:", err.message);
    return null;
  }
}

async function logBriefingDelivery(env, delivery) {
  const table = env.SUPABASE_BRIEFING_DELIVERIES_TABLE || "briefing_deliveries";
  try {
    await supabaseFetch(env, table, {
      method: "POST",
      body: JSON.stringify(delivery),
    });
  } catch (err) {
    console.warn("Briefing delivery log skipped:", err.message);
  }
}

async function logDigest(env, digest) {
  const table = env.SUPABASE_DIGEST_LOG_TABLE || "digest_log";
  try {
    await supabaseFetch(env, table, {
      method: "POST",
      body: JSON.stringify(digest),
    });
  } catch (err) {
    console.warn("Digest log skipped:", err.message);
  }
}

async function runDailyBriefings(env, trigger = "manual", providedSettings = null) {
  const settings = providedSettings || await getDigestSettings(env);
  await pruneDigestHistory(env);
  const runDate = new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
  const { extract, previousExtract, claims: rawClaims, previousClaims: rawPreviousClaims } = await getLatestExtractClaims(env);
  const claims = annotateDuplicateClaims(rawClaims);
  const previousClaims = annotateDuplicateClaims(rawPreviousClaims);
  const digestClaims = settings.include_terminal_claims
    ? claims
    : claims.filter(claim => !isTerminalClaim(claim) || normaliseStatus(claimStatus(claim)).startsWith("settled"));
  const digestPreviousClaims = settings.include_terminal_claims
    ? previousClaims
    : previousClaims.filter(claim => !isTerminalClaim(claim) || normaliseStatus(claimStatus(claim)).startsWith("settled"));
  const run = await createBriefingRun(env, {
    trigger,
    extract_id: extract?.id || extract?.extract_id || null,
    extract_date: extract?.extract_date || null,
    status: "started",
    started_at: new Date().toISOString(),
    claim_count: digestClaims.length,
  });
  const runId = run?.id || null;
  const handlerEmails = settings.handler_emails || {};
  const deliveries = [];

  const byHandler = new Map();
  digestClaims.forEach(claim => {
    const handler = claimHandler(claim);
    if (!byHandler.has(handler)) byHandler.set(handler, []);
    byHandler.get(handler).push(claim);
  });

  const briefingOptions = {
    includeTerminalClaims: settings.include_terminal_claims,
    comparisonAvailable: Boolean(previousExtract),
    extract,
    previousClaims: digestPreviousClaims,
    runDate,
    scoutClaimsUrl: env.SCOUT_CLAIMS_URL || env.SCOUT_BASE_URL || "",
  };
  const managerMessage = buildManagerBriefing(digestClaims, runDate, digestPreviousClaims, briefingOptions);
  deliveries.push({
    type: "manager",
    name: "Manager",
    to: settings.manager_email,
    message: managerMessage,
    claimsCount: digestClaims.length,
    criticalCount: digestClaims.filter(isCriticalClaim).length,
  });

  for (const [handler, handlerClaims] of byHandler) {
    deliveries.push({
      type: "handler",
      name: handler,
      to: handlerEmails[handler] || "",
      message: buildHandlerBriefing(handler, handlerClaims, runDate, briefingOptions),
      claimsCount: handlerClaims.length,
      criticalCount: handlerClaims.filter(isCriticalClaim).length,
    });
  }

  if (settings.zero_estimate_email) {
    const zeroClaims = digestClaims.filter(isZeroEstimateAnomaly);
    if (zeroClaims.length) {
      deliveries.push({
        type: "anomaly",
        name: "Zero Estimate Digest",
        to: settings.zero_estimate_email,
        message: buildZeroEstimateDigest(digestClaims, runDate),
        claimsCount: zeroClaims.length,
        criticalCount: zeroClaims.filter(isCriticalClaim).length,
      });
    }
  }

  const results = [];
  for (const delivery of deliveries) {
    const baseLog = {
      run_id: runId,
      type: delivery.type,
      recipient_name: delivery.name,
      recipient_email: delivery.to || null,
      subject: delivery.message.subject,
      created_at: new Date().toISOString(),
    };
    try {
      const result = await sendEmail(env, delivery.to, delivery.message);
      const status = result.skipped ? "skipped" : "sent";
      await logBriefingDelivery(env, { ...baseLog, status, error: result.reason || null });
      await logDigest(env, {
        generated_at: baseLog.created_at,
        type: delivery.type,
        recipient: delivery.to || delivery.name || null,
        subject: delivery.message.subject,
        claims_count: delivery.claimsCount || 0,
        critical_count: delivery.criticalCount || 0,
        html_body: delivery.message.html,
        sent_ok: status === "sent",
      });
      results.push({ type: delivery.type, name: delivery.name, to: delivery.to || null, status });
    } catch (err) {
      await logBriefingDelivery(env, { ...baseLog, status: "failed", error: err.message });
      await logDigest(env, {
        generated_at: baseLog.created_at,
        type: delivery.type,
        recipient: delivery.to || delivery.name || null,
        subject: delivery.message.subject,
        claims_count: delivery.claimsCount || 0,
        critical_count: delivery.criticalCount || 0,
        html_body: delivery.message.html,
        sent_ok: false,
      });
      results.push({ type: delivery.type, name: delivery.name, to: delivery.to || null, status: "failed", error: err.message });
    }
  }

  await updateBriefingRun(env, runId, {
    status: results.some(r => r.status === "failed") ? "completed_with_errors" : "completed",
    completed_at: new Date().toISOString(),
    delivery_count: results.length,
  });

  return { extract, claimCount: digestClaims.length, deliveries: results };
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function handleNotes(request, env, claimNo) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await verifyToken(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!env.SCOUT_NOTES) return json({ error: "SCOUT_NOTES KV binding is not configured" }, 503);

  const key = "note:" + claimNo;
  if (request.method === "GET") {
    const stored = await env.SCOUT_NOTES.get(key);
    if (!stored) return json({ note: "", savedBy: null, savedAt: null });
    return json(JSON.parse(stored));
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const record = {
      note: String(body.note || "").trim(),
      savedBy: user.displayName || user.mail || "Unknown",
      savedAt: new Date().toISOString(),
    };
    await env.SCOUT_NOTES.put(key, JSON.stringify(record));
    return json({ ok: true, ...record });
  }

  return json({ error: "Method not allowed" }, 405);
}

async function handleBriefingRuns(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await verifyToken(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const table = env.SUPABASE_BRIEFING_RUNS_TABLE || "briefing_runs";
  const rows = await supabaseFetch(env, `${table}?select=*&order=started_at.desc&limit=20`);
  return json({ runs: rows || [] });
}

async function handleDigestHistory(request, env, id = null) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await verifyToken(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!canViewDigestHistory(env, user)) return json({ error: "Forbidden" }, 403);

  const table = env.SUPABASE_DIGEST_LOG_TABLE || "digest_log";
  if (id) {
    const rows = await supabaseFetch(env, `${table}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    const digest = Array.isArray(rows) ? rows[0] : null;
    if (!digest) return json({ error: "Digest not found" }, 404);
    return json({ digest });
  }

  const fields = "id,generated_at,type,recipient,subject,claims_count,critical_count,sent_ok";
  const rows = await supabaseFetch(env, `${table}?select=${fields}&order=generated_at.desc&limit=100`);
  return json({ digests: rows || [] });
}

async function handleSettings(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await verifyToken(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (request.method === "GET" && !canViewDigestHistory(env, user)) return json({ error: "Forbidden" }, 403);
  if (request.method !== "GET" && !isAdminUser(env, user)) return json({ error: "Forbidden" }, 403);

  if (request.method === "GET") {
    const settings = await getDigestSettings(env);
    return json({
      settings: {
        send_time: settings.send_time,
        handler_emails: settings.handler_emails,
        manager_email: settings.manager_email,
        zero_estimate_email: settings.zero_estimate_email,
        include_terminal_claims: settings.include_terminal_claims,
      },
      retention_days: Number(env.DIGEST_HISTORY_RETENTION_DAYS || 90),
    });
  }

  if (request.method === "PATCH") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    try {
      const settings = await saveDigestSettings(env, {
        send_time: body.send_time,
        handler_emails: body.handler_emails,
        manager_email: body.manager_email,
        zero_estimate_email: body.zero_estimate_email,
        include_terminal_claims: body.include_terminal_claims,
      });
      return json({ ok: true, settings });
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maybeRunScheduledBriefing(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const { pathname } = new URL(request.url);

    const notesMatch = pathname.match(/^\/notes\/(.+)$/);
    if (notesMatch) {
      return handleNotes(request, env, decodeURIComponent(notesMatch[1]));
    }

    if (pathname === "/briefing-runs" && request.method === "GET") {
      return handleBriefingRuns(request, env);
    }

    if (pathname === "/settings" && (request.method === "GET" || request.method === "PATCH")) {
      return handleSettings(request, env);
    }

    if (pathname === "/digest-log" && request.method === "GET") {
      return handleDigestHistory(request, env);
    }

    const digestMatch = pathname.match(/^\/digest-log\/([0-9a-f-]+)$/i);
    if (digestMatch && request.method === "GET") {
      return handleDigestHistory(request, env, digestMatch[1]);
    }

    if (pathname === "/briefings/send" && request.method === "POST") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const user = await verifyToken(token);
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json(await runDailyBriefings(env, "manual"));
    }

    return json({ error: "Not found" }, 404);
  },
};
