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
 */

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
  <div style="max-width:760px;margin:0 auto;padding:28px 16px;">
    <div style="background:#1e6363;color:#fff;border-radius:10px 10px 0 0;padding:20px 24px;">
      <div style="font-size:20px;font-weight:700;">${escapeHtml(title)}</div>
      <div style="font-size:13px;color:rgba(255,255,255,.75);margin-top:4px;">${escapeHtml(subtitle)}</div>
    </div>
    <div style="background:#fff;border:1px solid #e2ecea;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
      ${bodyHtml}
    </div>
  </div>
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

function buildHandlerBriefing(handler, claims, runDate, options = {}) {
  const active = options.includeTerminalClaims ? claims : claims.filter(claim => !isTerminalClaim(claim));
  const critical = active.filter(isCriticalClaim);
  const stale = active.filter(isStaleClaim);
  const onTrack = Math.max(0, active.length - critical.length - stale.length);
  const urgent = active
    .filter(claim => isCriticalClaim(claim) || claimPriorityScore(claim) >= 45)
    .sort(sortByPriorityThenAge)
    .slice(0, 10);
  const zero = active.filter(isZeroEstimateAnomaly).sort(sortByPriorityThenAge).slice(0, 10);
  const awaiting = active.filter(isAwaitingBrokerFollowUp).sort(sortByPriorityThenAge).slice(0, 10);
  const assessor = active.filter(isAssessorReportOverdue).sort(sortByPriorityThenAge).slice(0, 10);
  const payment = active.filter(isPaymentReady).sort(sortByPriorityThenAge).slice(0, 10);
  const fresh = active.filter(isNewToday).sort(sortByPriorityThenAge).slice(0, 10);

  const body = `
    <div style="font-size:18px;font-weight:800;margin-bottom:6px;">Scout Daily Briefing - ${escapeHtml(handler.split(" ")[0] || handler)} - ${escapeHtml(runDate)}</div>
    <div style="font-size:14px;font-weight:700;margin:10px 0 18px;color:#1a2e2e;">STATUS HEADER: 🔴 ${critical.length} critical / 🟡 ${stale.length} stale / 🟢 ${onTrack} on track</div>
    <div style="border-top:1px solid #ccdbd8;margin:18px 0 2px;"></div>
    ${handlerSection("URGENT - ACTION REQUIRED TODAY", urgent.map(claim =>
      handlerLine(claim, `${claimAge(claim)} days - ${escapeHtml(claimAction(claim))}`)
    ))}
    ${handlerSection("ZERO ESTIMATE ANOMALIES", zero.map(claim =>
      `${escapeHtml(claimNo(claim))} - ${escapeHtml(claimInsured(claim))} - ${escapeHtml(claimStatus(claim))} - Estimate = R0 - Review payment/closure mismatch`
    ))}
    ${handlerSection("AWAITING YOUR FOLLOW-UP", awaiting.map(claim =>
      handlerLine(claim, `${claimAge(claim)} days`)
    ))}
    ${handlerSection("ASSESSOR REPORTS OVERDUE", assessor.map(claim =>
      handlerLine(claim, `${claimAge(claim)} days`)
    ))}
    ${handlerSection("PAYMENT READY", payment.map(claim =>
      `${escapeHtml(claimNo(claim))} - ${escapeHtml(claimInsured(claim))} - ${escapeHtml(claimStatus(claim))} - ${fmtCurrency(claimOutstanding(claim) || claimPaid(claim))}`
    ))}
    ${handlerSection("NEW TODAY", fresh.map(claim =>
      `${escapeHtml(claimNo(claim))} - ${escapeHtml(claimInsured(claim))} - ${escapeHtml(claimStatus(claim))} - ${escapeHtml(claimPeril(claim))}`
    ))}
  `;
  return {
    subject: `Scout Daily Briefing - ${handler.split(" ")[0] || handler} - ${runDate}`,
    html: emailLayout("Scout Daily Briefing", `${handler} - ${runDate}`, body),
    text: `Scout Daily Briefing - ${handler} - ${runDate}. Critical: ${critical.length}. Stale: ${stale.length}. On track: ${onTrack}.`,
  };
}

function buildManagerBriefing(claims, runDate, previousClaims = [], options = {}) {
  const active = options.includeTerminalClaims
    ? claims
    : claims.filter(claim => !isTerminalClaim(claim) || normaliseStatus(claimStatus(claim)).startsWith("settled"));
  const zero = active.filter(isZeroEstimateAnomaly);
  const critical = active.filter(isCriticalClaim);
  const previousCriticalNos = new Set((previousClaims || []).filter(isCriticalClaim).map(claimNo));
  const newCritical = critical.filter(claim => !previousCriticalNos.has(claimNo(claim)));
  const risks = active.filter(isRiskWatchClaim).sort(sortByPriorityThenAge);
  const overMandate = active.filter(claim => claimOutstanding(claim) >= 100000);
  const readyToClose = active.filter(isReadyToCloseClaim);
  const stuck30 = active.filter(isNoMovement30);
  const totalExposure = active.reduce((sum, claim) => sum + claimOutstanding(claim), 0);
  const handlers = [...new Set(active.map(claimHandler))].filter(Boolean).sort();
  const teamRows = handlers.map(handler => {
    const handlerClaims = active.filter(claim => claimHandler(claim) === handler);
    const handlerCritical = handlerClaims.filter(isCriticalClaim);
    const handlerZero = handlerClaims.filter(isZeroEstimateAnomaly);
    const handlerStale = handlerClaims.filter(isStaleClaim);
    const icon = handlerCritical.length ? "🔴" : handlerStale.length ? "🟡" : "🟢";
    const detail = handlerCritical.length
      ? `${handlerClaims.length} claims, ${handlerCritical.length} critical, ${handlerZero.length} zero-estimate`
      : handlerStale.length
        ? `${handlerClaims.length} claims, ${handlerStale.length} stale`
        : `${handlerClaims.length} claims, all on track`;
    return `<div style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.65;">${icon} ${escapeHtml(handler)} - ${escapeHtml(detail)}</div>`;
  }).join("");
  const topRiskRows = risks.slice(0, 5).map(claim =>
    `<div style="font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.65;">${managerRiskLine(claim)}</div>`
  ).join("") || `<div style="color:#6b8582;font-size:13px;">No top risks flagged.</div>`;
  const body = `
    <div style="font-size:18px;font-weight:800;margin-bottom:14px;">Scout Manager Summary - ${escapeHtml(runDate)}</div>
    <div style="font-family:Consolas,'Courier New',monospace;font-size:14px;font-weight:700;margin-bottom:18px;">PORTFOLIO: ${active.length} active · R${(totalExposure / 1000000).toFixed(2)}m exposure · ${critical.length} critical SLA</div>
    <div style="margin-bottom:20px;">
      ${managerMetricLine("ZERO ESTIMATE ANOMALIES:", `${zero.length} claims require review`)}
      ${managerMetricLine("CRITICAL SLA BREACHES:", `${critical.length} claims`, `(+ ${newCritical.length} new since yesterday)`)}
      ${managerMetricLine("RISK WATCHLIST:", `${risks.length} claims`, "(legal/repudiation/mandate)")}
      ${managerMetricLine("MANDATE AUTHORITY NEEDED:", `${overMandate.length} claims over R100k`)}
      ${managerMetricLine("READY TO CLOSE:", `${readyToClose.length} claims`, "(action recommended)")}
      ${managerMetricLine("NO MOVEMENT 30+ DAYS:", `${stuck30.length} claims`, "(stuck)")}
    </div>
    <div style="margin-top:22px;">
      <div style="font-size:13px;font-weight:800;color:#1e6363;letter-spacing:.5px;border-bottom:1px solid #e2ecea;padding-bottom:7px;margin-bottom:8px;">TEAM SLA STATUS</div>
      ${teamRows || `<div style="color:#6b8582;font-size:13px;">No handler data.</div>`}
    </div>
    <div style="margin-top:22px;">
      <div style="font-size:13px;font-weight:800;color:#1e6363;letter-spacing:.5px;border-bottom:1px solid #e2ecea;padding-bottom:7px;margin-bottom:8px;">TOP 5 RISKS</div>
      ${topRiskRows}
    </div>
  `;
  return {
    subject: `Scout Manager Summary - ${runDate}`,
    html: emailLayout("Scout Manager Summary", runDate, body),
    text: `Scout Manager Summary - ${runDate}. Portfolio: ${active.length} active, R${(totalExposure / 1000000).toFixed(2)}m exposure, ${critical.length} critical SLA. Zero estimates: ${zero.length}. Ready to close: ${readyToClose.length}.`,
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
  const { extract, claims: rawClaims, previousClaims: rawPreviousClaims } = await getLatestExtractClaims(env);
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

  const briefingOptions = { includeTerminalClaims: settings.include_terminal_claims };
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
