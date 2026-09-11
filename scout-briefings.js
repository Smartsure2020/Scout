/**
 * Scout Briefings — isolated manual email pilot.
 *
 * This Worker deliberately owns only production email briefing generation,
 * email delivery, and delivery history. It has no scheduled entrypoint.
 */

import { buildBriefingModel } from "./scout-smartsure/claims/briefing-model.mjs";

export const PRODUCTION_ORIGIN =
  "https://scout-smartsure.marketing-854.workers.dev";
export const TABLE_DEFAULTS = Object.freeze({
  extracts: "claim_extracts",
  claims: "claims",
  runs: "briefing_runs",
  deliveries: "briefing_deliveries",
  digestLog: "digest_log",
  settings: "scout_settings",
});

const TERMINAL_STATUSES = new Set([
  "closed paid",
  "closed - finalised",
  "closed - no cover",
  "closed - claim documents outstanding",
  "closed - over 30days",
  "closed - minor damages",
  "closed - third party damages only",
  "closed - settled by sasria",
  "closed - client abandoned claim",
  "closed - claim rejected by insurer",
  "closed - broker proceeding with claim",
  "closed - handled by insurer.",
  "closed - settled by insurer",
  "closed - 180 days",
  "closed - cancelled",
  "closed - no payments made",
  "settled",
  "cancelled",
  "duplicated",
  "claim prescribed",
  "claim withdrawn",
  "rejected",
  "auto rejected",
  "advise only",
  "claim within excess",
  "not taken up",
]);

const PAYMENT_STATUSES = new Set([
  "payment requested",
  "payment - approved",
  "payment released",
  "payment - payments made",
  "payment - pending approval",
  "requested payment",
]);

const ASSESSOR_MARKERS = [
  "assessor",
  "adjuster",
  "assessment",
  "engineer",
  "surveyor",
];
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

class StorageError extends Error {
  constructor(status, body) {
    super("Storage request failed");
    this.status = status;
    this.body = body;
  }
}

function json(data, status, origin) {
  const headers = {
    "Content-Type": "application/json",
    Vary: "Origin",
  };
  if (origin === PRODUCTION_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = PRODUCTION_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function empty(status, origin) {
  const headers = { Vary: "Origin" };
  if (origin === PRODUCTION_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = PRODUCTION_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
  }
  return new Response(null, { status, headers });
}

function normaliseText(value) {
  return String(value == null ? "" : value).trim();
}

function normaliseStatus(value) {
  return normaliseText(value).toLowerCase();
}

function normaliseEmail(value) {
  const email = normaliseText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normaliseIdentity(value) {
  const identity = normaliseText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(identity) ? identity : "";
}

function parseNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value).replace(/[Rr,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function claimNo(claim) {
  return claim?.claimNo || claim?.claim_no || claim?.claim_number || "";
}

function claimStatus(claim) {
  return claim?.status || claim?.claim_status || "";
}

function claimHandler(claim) {
  return (
    claim?.handler ||
    claim?.handler_name ||
    claim?.claim_handler ||
    "Unassigned"
  );
}

function claimInsured(claim) {
  return claim?.insured || claim?.insured_name || "Unknown insured";
}

function claimAge(claim) {
  return (
    Number(
      claim?.workingAge ??
        claim?.working_age ??
        claim?.age_days ??
        claim?.age ??
        0,
    ) || 0
  );
}

function claimOutstanding(claim) {
  return parseNumber(
    claim?.outstanding ?? claim?.outstanding_amount ?? claim?.nett_claim ?? 0,
  );
}

function claimEstimate(claim) {
  return parseNumber(
    claim?.estimate ??
      claim?.cardinal_estimate ??
      claim?.original_estimate ??
      claim?.own_damage_original_estimate ??
      0,
  );
}

function claimPaid(claim) {
  return parseNumber(claim?.paid ?? claim?.paid_amount ?? 0);
}

function isTerminalClaim(claim) {
  return TERMINAL_STATUSES.has(normaliseStatus(claimStatus(claim)));
}

function isLegalClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    status.includes("legal") ||
    status.includes("attorney") ||
    status.includes("ombudsman") ||
    status.includes("fraud") ||
    status.includes("recovery") ||
    status.includes("third party")
  );
}

function isAssessorClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return ASSESSOR_MARKERS.some((marker) => status.includes(marker));
}

function isZeroEstimateClaim(claim) {
  if (isTerminalClaim(claim) || claimEstimate(claim) !== 0) return false;
  const status = normaliseStatus(claimStatus(claim));
  const outstanding = claimOutstanding(claim);
  const actionable =
    PAYMENT_STATUSES.has(status) ||
    status.includes("authorised") ||
    status.includes("in progress") ||
    isAssessorClaim(claim);
  return (
    outstanding > 0 ||
    actionable ||
    (outstanding === 0 && claimPaid(claim) === 0)
  );
}

function claimFlags(claim) {
  const age = claimAge(claim);
  const status = normaliseStatus(claimStatus(claim));
  const estimate = claimEstimate(claim);
  const outstanding = claimOutstanding(claim);
  const flags = [];

  if (PAYMENT_STATUSES.has(status) && estimate === 0) {
    flags.push("Zero estimate — payment or closure review");
  } else if (!isTerminalClaim(claim) && estimate === 0 && age > 14) {
    flags.push("No estimate captured — update required");
  }
  if (outstanding > 0 && estimate === 0)
    flags.push("Estimate missing — outstanding value set");
  if (status === "fraud") flags.push("Fraud matter — urgent review");
  if (status.includes("ombudsman") || status.includes("nfo"))
    flags.push("Complaint active — urgent review");
  if (status.includes("mandate") || outstanding >= 100000)
    flags.push("Mandate authority required");
  if (!isTerminalClaim(claim) && !isLegalClaim(claim)) {
    const movementDays = Number(
      claim?.daysSinceMovement ?? claim?.days_since_movement,
    );
    if (Number.isFinite(movementDays) && movementDays > 30)
      flags.push("No movement in 30 days — review");
    else if (Number.isFinite(movementDays) && movementDays > 14)
      flags.push("No movement in 14+ days — review");
  }
  if (status === "repudiated" && age > 270)
    flags.push("9-month window closed — escalate");
  if (status === "awaiting assessor report" && age > 14)
    flags.push("Assessor report overdue");
  if (status === "awaiting investigators report" && age > 14)
    flags.push("Investigator report overdue");
  if (status === "awaiting broker feedback" && age > 7)
    flags.push("Broker unresponsive > 7 days");
  if (status === "registered" && age > 5)
    flags.push("New claim unactioned — assign handler");
  if (claim?.possibleDuplicate || claim?.possible_duplicate)
    flags.push("Possible duplicate — verify");
  if (isLegalClaim(claim) && age > 60)
    flags.push("Recovery overdue — request update");
  if (outstanding > 0 && estimate > 0 && outstanding > estimate * 1.5)
    flags.push("Outstanding exceeds estimate by 50%+");
  if (!flags.length && !isTerminalClaim(claim) && age >= 30)
    flags.push("Aged open claim");
  return flags;
}

function claimPriorityScore(claim) {
  let score = claimFlags(claim).length * 20;
  if (claimAge(claim) >= 30) score += 20;
  if (claimOutstanding(claim) >= 100000) score += 25;
  if (isZeroEstimateClaim(claim)) score += 35;
  return score;
}

function isCriticalClaim(claim) {
  const flags = claimFlags(claim);
  return (
    flags.some((flag) => /urgent|mandate|9-month|unactioned/i.test(flag)) ||
    claimAge(claim) >= 30 ||
    claimPriorityScore(claim) >= 60
  );
}

function isStaleClaim(claim) {
  return (
    !isCriticalClaim(claim) &&
    (claimAge(claim) >= 14 ||
      claimFlags(claim).some((flag) => flag.includes("14+ days")))
  );
}

function isMandateClaim(claim) {
  return (
    normaliseStatus(claimStatus(claim)).includes("mandate") ||
    claimOutstanding(claim) >= 100000
  );
}

function isClosureClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    (status.includes("settled") ||
      status === "payment released" ||
      status === "payment - payments made") &&
    claimAge(claim) > 14
  );
}

function isNoMovementClaim(claim) {
  const movementDays = Number(
    claim?.daysSinceMovement ?? claim?.days_since_movement,
  );
  return (
    !isTerminalClaim(claim) &&
    !isLegalClaim(claim) &&
    Number.isFinite(movementDays) &&
    movementDays > 14
  );
}

function isAwaitingExternalClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    status.includes("awaiting broker") ||
    status.includes("broker feedback") ||
    status.includes("awaiting client") ||
    status.includes("assessor report")
  );
}

function isAssessorReportOverdueClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    isAssessorClaim(claim) && status.includes("report") && claimAge(claim) >= 7
  );
}

function isPaymentClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return PAYMENT_STATUSES.has(status) || status.includes("payment requested");
}

function isNewClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  const source = normaliseStatus(
    claim?.lastUpdatedSource || claim?.last_updated_source,
  );
  return (
    source === "new-claim" || (status === "registered" && claimAge(claim) <= 1)
  );
}

function primaryReason(claim) {
  return claimFlags(claim)[0] || "Review claim progress";
}

function nextAction(claim) {
  if (isCriticalClaim(claim))
    return "Review the critical queue and progress the next step";
  if (isMandateClaim(claim)) return "Review authority and management decision";
  if (isZeroEstimateClaim(claim))
    return "Validate estimate and payment or closure state";
  if (isAssessorReportOverdueClaim(claim)) return "Chase assessor report";
  if (isAwaitingExternalClaim(claim))
    return "Follow up with the external party";
  if (isPaymentClaim(claim))
    return "Confirm payment status and close if complete";
  if (isClosureClaim(claim)) return "Close unless recovery or excess remains";
  return "Review and progress claim";
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatCurrency(value) {
  return `R${Math.round(number(value)).toLocaleString("en-ZA")}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  const text = normaliseText(value);
  return text ? text.slice(0, 10) : "Unavailable";
}

function emailLayout(title, subtitle, bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;background:#f4f8f8;font-family:Segoe UI,Arial,sans-serif;color:#1a2e2e;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#f4f8f8;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="width:100%;max-width:680px;background:#fff;border:1px solid #e2ecea;border-collapse:separate;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#1e6363;color:#fff;padding:20px 24px;">
          <div style="font-size:20px;font-weight:700;line-height:1.25;">${escapeHtml(title)}</div>
          <div style="font-size:13px;color:#e7f4f1;margin-top:5px;line-height:1.45;">${escapeHtml(subtitle)}</div>
        </td></tr>
        <tr><td style="padding:24px;">${bodyHtml}</td></tr>
        <tr><td style="background:#f4f8f8;border-top:1px solid #e2ecea;padding:14px 24px;text-align:center;color:#6b8582;font-size:12px;line-height:1.5;">Scout · Smartsure Twenty20 · Manual pilot briefing</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function claimLine(item) {
  return `<tr>
    <td style="padding:9px;border-bottom:1px solid #e2ecea;"><strong>${escapeHtml(item.claimNo)}</strong><br><span style="color:#6b8582;">${escapeHtml(item.insured)}</span></td>
    <td style="padding:9px;border-bottom:1px solid #e2ecea;">${escapeHtml(item.handler)}<br><span style="color:#6b8582;">${escapeHtml(item.primaryReason)}</span></td>
    <td style="padding:9px;border-bottom:1px solid #e2ecea;text-align:right;white-space:nowrap;">${escapeHtml(item.age)}wd<br>${formatCurrency(item.outstanding)}</td>
  </tr>`;
}

function claimTable(items, emptyText) {
  if (!items.length)
    return `<p style="color:#6b8582;">${escapeHtml(emptyText)}</p>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:#f4f8f8;">
      <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Claim</th>
      <th style="text-align:left;padding:9px;border-bottom:1px solid #e2ecea;">Owner / focus</th>
      <th style="text-align:right;padding:9px;border-bottom:1px solid #e2ecea;">Age / outstanding</th>
    </tr></thead><tbody>${items.map(claimLine).join("")}</tbody>
  </table>`;
}

function modelFor(claims, previousClaims, extract, settings, env) {
  return buildBriefingModel(
    claims,
    {
      getClaimNo: claimNo,
      getHandler: claimHandler,
      getInsured: claimInsured,
      getAge: claimAge,
      getScore: claimPriorityScore,
      isTerminal: isTerminalClaim,
      isCritical: isCriticalClaim,
      isStale: isStaleClaim,
      isZeroEstimate: isZeroEstimateClaim,
      isRisk: (claim) =>
        isLegalClaim(claim) ||
        isMandateClaim(claim) ||
        claimOutstanding(claim) >= 100000,
      isMandate: isMandateClaim,
      isClosure: isClosureClaim,
      isNoMovement: isNoMovementClaim,
      isAwaitingExternal: isAwaitingExternalClaim,
      isAssessorOverdue: isAssessorReportOverdueClaim,
      isPayment: isPaymentClaim,
      isNew: isNewClaim,
      getOutstanding: claimOutstanding,
      getPrimaryReason: primaryReason,
      getNextAction: nextAction,
      claimUrl: (claim) =>
        env.SCOUT_CLAIMS_URL
          ? `${String(env.SCOUT_CLAIMS_URL).replace(/\/$/, "")}/${encodeURIComponent(claimNo(claim))}`
          : "",
    },
    {
      extractDate: extract?.extract_date || extract?.effective_date || null,
      previousClaims,
      comparisonAvailable: previousClaims.length > 0,
      includeTerminalClaims: settings.includeTerminalClaims,
    },
  );
}

export function buildManagerBriefing(model, extract, now = new Date()) {
  const extractDate = formatDate(
    model.extractDate || extract?.effective_date || extract?.extract_date,
  );
  const runDate = formatDate(now.toISOString());
  const attentionItems = model.attention
    .flatMap((section) =>
      section.claims.map((claim) => ({
        claimNo: claimNo(claim),
        insured: claimInsured(claim),
        handler: claimHandler(claim),
        age: claimAge(claim),
        outstanding: claimOutstanding(claim),
        primaryReason: section.label,
      })),
    )
    .slice(0, 12);
  const riskItems = model.topRisks.items;
  const body = `
    <p style="margin:0 0 16px;color:#6b8582;font-size:13px;">Run date: <strong style="color:#1a2e2e;">${escapeHtml(runDate)}</strong> · Data as at: <strong style="color:#1a2e2e;">${escapeHtml(extractDate)}</strong></p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:10px;background:#f4f8f8;border-right:4px solid #fff;"><strong>${model.metrics.active}</strong><br><span style="font-size:12px;color:#6b8582;">Active claims</span></td>
      <td style="padding:10px;background:#fff4ef;border-right:4px solid #fff;"><strong>${model.metrics.critical}</strong><br><span style="font-size:12px;color:#6b8582;">Critical</span></td>
      <td style="padding:10px;background:#fff8e6;border-right:4px solid #fff;"><strong>${model.metrics.stale}</strong><br><span style="font-size:12px;color:#6b8582;">Stale / at risk</span></td>
      <td style="padding:10px;background:#eef7f5;"><strong>${formatCurrency(model.metrics.exposure)}</strong><br><span style="font-size:12px;color:#6b8582;">Outstanding</span></td></tr>
    </table>
    <h3 style="margin:20px 0 8px;color:#1e6363;font-size:14px;">Management attention</h3>
    ${claimTable(attentionItems, "No priority concerns in this extract.")}
    <h3 style="margin:22px 0 8px;color:#1e6363;font-size:14px;">Top risk watch</h3>
    ${claimTable(riskItems, "No risk-watch claims in this extract.")}
    <p style="margin:20px 0 0;color:#6b8582;font-size:12px;">${escapeHtml(model.comparisonLabel)}. This pilot message is addressed only to the approved pilot recipient.</p>`;
  const subject = `Scout manager briefing — ${runDate}`;
  return {
    subject,
    html: emailLayout(
      "Scout manager briefing",
      `Data as at ${extractDate}`,
      body,
    ),
    text: `Scout manager briefing. Active claims: ${model.metrics.active}. Critical: ${model.metrics.critical}. Data as at: ${extractDate}.`,
    claimsCount: model.metrics.active,
    criticalCount: model.metrics.critical,
  };
}

function tableFor(env, envKey, defaultKey) {
  const value = env[envKey] || TABLE_DEFAULTS[defaultKey];
  if (!SAFE_TABLE_NAME.test(String(value)))
    throw new RequestError(503, "storage_unavailable");
  return String(value);
}

function hasStorageConfig(env) {
  return Boolean(
    normaliseText(env.SUPABASE_URL) &&
    normaliseText(env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

function hasGraphConfig(env) {
  return Boolean(
    normaliseText(env.AZURE_TENANT_ID) &&
    normaliseText(env.AZURE_CLIENT_ID) &&
    normaliseText(env.AZURE_CLIENT_SECRET) &&
    normaliseEmail(env.MAIL_FROM),
  );
}

function parseIdentityAllowlist(raw) {
  if (!normaliseText(raw)) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .map((entry) => {
            if (typeof entry === "string") return normaliseIdentity(entry);
            if (entry && typeof entry === "object")
              return normaliseIdentity(
                entry.email || entry.upn || entry.identity,
              );
            return "";
          })
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function parseRecipientAllowlist(raw) {
  return parseIdentityAllowlist(raw).filter((entry) =>
    Boolean(normaliseEmail(entry)),
  );
}

function normaliseSettings(value) {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const handlerEmails =
    raw.handler_emails &&
    typeof raw.handler_emails === "object" &&
    !Array.isArray(raw.handler_emails)
      ? Object.fromEntries(
          Object.entries(raw.handler_emails)
            .map(([name, email]) => [String(name), normaliseEmail(email)])
            .filter(([, email]) => email),
        )
      : {};
  return {
    managerEmail: normaliseEmail(raw.manager_email),
    zeroEstimateEmail: normaliseEmail(raw.zero_estimate_email),
    handlerEmails,
    includeTerminalClaims: raw.include_terminal_claims === true,
    available: Object.keys(raw).length > 0,
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

async function storageRequest(env, path, init, httpFetch) {
  if (!hasStorageConfig(env))
    throw new RequestError(503, "storage_unavailable");
  let response;
  try {
    response = await httpFetch(
      `${String(env.SUPABASE_URL).replace(/\/+$/, "")}/rest/v1/${path}`,
      {
        ...init,
        headers: {
          ...supabaseHeaders(env, init?.method === "POST"),
          ...(init?.headers || {}),
        },
      },
    );
  } catch {
    throw new RequestError(503, "storage_unavailable");
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new StorageError(response.status, body);
  return body;
}

async function loadExtractClaims(env, httpFetch) {
  const extractsTable = tableFor(env, "SUPABASE_EXTRACTS_TABLE", "extracts");
  const claimsTable = tableFor(env, "SUPABASE_CLAIMS_TABLE", "claims");
  let extractRows;
  try {
    extractRows = await storageRequest(
      env,
      `${extractsTable}?select=*&order=extract_date.desc,uploaded_at.desc&limit=2`,
      {},
      httpFetch,
    );
  } catch (error) {
    if (error instanceof RequestError) throw error;
    extractRows = await storageRequest(
      env,
      `${extractsTable}?select=*&order=created_at.desc&limit=2`,
      {},
      httpFetch,
    );
  }
  const extracts = Array.isArray(extractRows) ? extractRows : [];
  const extract = extracts[0] || null;
  const previousExtract = extracts[1] || null;
  if (!extract)
    return {
      extract: null,
      previousExtract: null,
      claims: [],
      previousClaims: [],
    };

  async function claimsFor(candidate) {
    const snapshot = Array.isArray(candidate?.claim_snapshot)
      ? candidate.claim_snapshot
      : null;
    const extractId = candidate?.id || candidate?.extract_id;
    try {
      const query = extractId
        ? `${claimsTable}?select=*&extract_id=eq.${encodeURIComponent(extractId)}&limit=5000`
        : `${claimsTable}?select=*&order=created_at.desc&limit=5000`;
      const rows = await storageRequest(env, query, {}, httpFetch);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (snapshot) return snapshot;
      throw new RequestError(503, "production_data_unavailable");
    }
  }

  return {
    extract,
    previousExtract,
    claims: await claimsFor(extract),
    previousClaims: previousExtract ? await claimsFor(previousExtract) : [],
  };
}

async function loadSettings(env, httpFetch) {
  const settingsTable = tableFor(env, "SUPABASE_SETTINGS_TABLE", "settings");
  const rows = await storageRequest(
    env,
    `${settingsTable}?select=value&id=eq.digest&limit=1`,
    {},
    httpFetch,
  );
  return normaliseSettings(Array.isArray(rows) && rows[0] ? rows[0].value : {});
}

async function loadPlanData(env, httpFetch) {
  const [data, settings] = await Promise.all([
    loadExtractClaims(env, httpFetch),
    loadSettings(env, httpFetch),
  ]);
  const model = modelFor(
    data.claims,
    data.previousClaims,
    data.extract,
    settings,
    env,
  );
  const handlerNames = model.handlers.map((handler) => String(handler));
  const mappedKeys = new Set(
    Object.keys(settings.handlerEmails).map((name) =>
      name.trim().toLowerCase(),
    ),
  );
  const missingHandlers = handlerNames.filter(
    (name) => !mappedKeys.has(name.trim().toLowerCase()),
  );
  const mappedHandlerCount = handlerNames.length - missingHandlers.length;
  return {
    ...data,
    settings,
    model,
    handlerNames,
    missingHandlers,
    mappedHandlerCount,
  };
}

function isAllowlistConfigured(raw, recipient = false) {
  return (
    (recipient ? parseRecipientAllowlist(raw) : parseIdentityAllowlist(raw))
      .length > 0
  );
}

function planResult(data, env) {
  const callerListConfigured = isAllowlistConfigured(
    env.DELIVERY_ALLOWED_CALLERS_JSON,
  );
  const pilotListConfigured = isAllowlistConfigured(
    env.DELIVERY_PILOT_RECIPIENTS_JSON,
    true,
  );
  const managerConfigured = Boolean(data.settings.managerEmail);
  const zeroEstimateConfigured = Boolean(data.settings.zeroEstimateEmail);
  const dataConfigured = Boolean(data.extract);
  const pilotReady =
    dataConfigured &&
    data.settings.available &&
    managerConfigured &&
    zeroEstimateConfigured &&
    data.missingHandlers.length === 0 &&
    hasStorageConfig(env) &&
    hasGraphConfig(env) &&
    callerListConfigured &&
    pilotListConfigured;
  return {
    mode: "pilot",
    extractDate:
      data.extract?.extract_date || data.extract?.effective_date || null,
    effectiveDate:
      data.extract?.effective_date || data.extract?.extract_date || null,
    claimCount: data.claims.length,
    activeClaimCount: data.model.metrics.active,
    managerConfigured,
    handlerCount: data.handlerNames.length,
    mappedHandlerCount: data.mappedHandlerCount,
    missingHandlers: data.missingHandlers,
    anomalyDigestRequired: data.model.metrics.zeroEstimate > 0,
    comparisonAvailable: data.model.comparisonAvailable,
    pilotReady,
  };
}

function safeHistoryRun(row) {
  return {
    id: row?.id || null,
    trigger: String(row?.trigger || "").startsWith("manual-pilot")
      ? "manual-pilot"
      : row?.trigger || null,
    extractDate: row?.extract_date || null,
    status: row?.status || null,
    startedAt: row?.started_at || null,
    completedAt: row?.completed_at || null,
    claimCount: Number(row?.claim_count || 0),
    deliveryCount: Number(row?.delivery_count || 0),
  };
}

function safeHistoryDigest(row) {
  return {
    id: row?.id || null,
    generatedAt: row?.generated_at || null,
    type: row?.type || null,
    subject: row?.subject || null,
    claimsCount: Number(row?.claims_count || 0),
    criticalCount: Number(row?.critical_count || 0),
    sentOk: row?.sent_ok === true,
  };
}

async function getGraphIdentity(token, httpFetch) {
  let response;
  try {
    response = await httpFetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new RequestError(401, "invalid_auth");
  }
  if (!response.ok) throw new RequestError(401, "invalid_auth");
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const identity =
    normaliseIdentity(data?.mail) || normaliseIdentity(data?.userPrincipalName);
  if (!identity) throw new RequestError(401, "invalid_auth");
  return identity;
}

function readBearer(request) {
  const value = request.headers.get("Authorization") || "";
  const match = value.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new RequestError(401, "authentication_required");
  return match[1];
}

async function authenticate(request, env, httpFetch) {
  const token = readBearer(request);
  const identity = await getGraphIdentity(token, httpFetch);
  const allowed = parseIdentityAllowlist(env.DELIVERY_ALLOWED_CALLERS_JSON);
  if (!allowed.length)
    throw new RequestError(503, "caller_allowlist_unavailable");
  if (!allowed.includes(identity))
    throw new RequestError(403, "caller_not_allowed");
  return { identity };
}

async function sha256Bytes(value) {
  const data = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function deterministicUuid(value) {
  const bytes = (
    await sha256Bytes(`scout-briefings:idempotency:${value}`)
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDuplicateStorageError(error) {
  return (
    error instanceof StorageError &&
    (error.status === 409 ||
      error.body?.code === "23505" ||
      String(error.body?.message || "")
        .toLowerCase()
        .includes("duplicate key"))
  );
}

async function existingDelivery(env, deliveryId, httpFetch) {
  const table = tableFor(
    env,
    "SUPABASE_BRIEFING_DELIVERIES_TABLE",
    "deliveries",
  );
  const rows = await storageRequest(
    env,
    `${table}?id=eq.${encodeURIComponent(deliveryId)}&select=id,status,type,subject&limit=1`,
    {},
    httpFetch,
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function reserveDelivery(env, deliveryId, recipient, subject, httpFetch) {
  const table = tableFor(
    env,
    "SUPABASE_BRIEFING_DELIVERIES_TABLE",
    "deliveries",
  );
  try {
    const rows = await storageRequest(
      env,
      table,
      {
        method: "POST",
        body: JSON.stringify({
          id: deliveryId,
          run_id: null,
          type: "manager",
          recipient_name: "pilot",
          recipient_email: recipient,
          subject,
          status: "reserved",
          error: null,
        }),
      },
      httpFetch,
    );
    return {
      created: true,
      row: Array.isArray(rows)
        ? rows[0] || { id: deliveryId, status: "reserved" }
        : { id: deliveryId, status: "reserved" },
    };
  } catch (error) {
    if (!isDuplicateStorageError(error))
      throw new RequestError(503, "BLOCKED — schema support required");
    const existing = await existingDelivery(env, deliveryId, httpFetch);
    if (!existing) throw new RequestError(503, "idempotency_unavailable");
    return { created: false, row: existing };
  }
}

async function patchDelivery(env, deliveryId, details, httpFetch) {
  const table = tableFor(
    env,
    "SUPABASE_BRIEFING_DELIVERIES_TABLE",
    "deliveries",
  );
  await storageRequest(
    env,
    `${table}?id=eq.${encodeURIComponent(deliveryId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(details),
    },
    httpFetch,
  );
}

async function createRun(env, details, httpFetch) {
  const table = tableFor(env, "SUPABASE_BRIEFING_RUNS_TABLE", "runs");
  const rows = await storageRequest(
    env,
    table,
    {
      method: "POST",
      body: JSON.stringify(details),
    },
    httpFetch,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw new RequestError(503, "history_unavailable");
  return row;
}

async function patchRun(env, runId, details, httpFetch) {
  const table = tableFor(env, "SUPABASE_BRIEFING_RUNS_TABLE", "runs");
  await storageRequest(
    env,
    `${table}?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(details),
    },
    httpFetch,
  );
}

async function createDigestLog(env, message, recipient, httpFetch) {
  const table = tableFor(env, "SUPABASE_DIGEST_LOG_TABLE", "digestLog");
  const rows = await storageRequest(
    env,
    table,
    {
      method: "POST",
      body: JSON.stringify({
        type: "manager",
        recipient,
        subject: message.subject,
        claims_count: message.claimsCount,
        critical_count: message.criticalCount,
        html_body: message.html,
        sent_ok: false,
      }),
    },
    httpFetch,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw new RequestError(503, "history_unavailable");
  return row;
}

async function patchDigestLog(env, digestId, details, httpFetch) {
  const table = tableFor(env, "SUPABASE_DIGEST_LOG_TABLE", "digestLog");
  await storageRequest(
    env,
    `${table}?id=eq.${encodeURIComponent(digestId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(details),
    },
    httpFetch,
  );
}

async function graphToken(env, httpFetch) {
  if (!hasGraphConfig(env))
    throw new RequestError(503, "graph_configuration_incomplete");
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`;
  let response;
  try {
    response = await httpFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    });
  } catch {
    throw new RequestError(502, "graph_authentication_failed");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data?.access_token)
    throw new RequestError(502, "graph_authentication_failed");
  return data.access_token;
}

async function sendGraphEmail(env, recipient, message, httpFetch) {
  const token = await graphToken(env, httpFetch);
  let response;
  try {
    response = await httpFetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.html },
            toRecipients: [{ emailAddress: { address: recipient } }],
          },
          saveToSentItems: false,
        }),
      },
    );
  } catch {
    throw new RequestError(502, "graph_delivery_failed");
  }
  if (!response.ok) throw new RequestError(502, "graph_delivery_failed");
  return { ok: true };
}

async function sendPilot(request, env, caller, httpFetch, now) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  const type = normaliseText(body?.briefingType || body?.type).toLowerCase();
  if (type !== "manager")
    throw new RequestError(400, "only_manager_pilot_supported");
  const recipient = normaliseEmail(body?.pilotRecipient || body?.recipient);
  if (!recipient) throw new RequestError(400, "pilot_recipient_required");
  const pilotRecipients = parseRecipientAllowlist(
    env.DELIVERY_PILOT_RECIPIENTS_JSON,
  );
  if (!pilotRecipients.length)
    throw new RequestError(503, "pilot_recipient_allowlist_unavailable");
  if (!pilotRecipients.includes(recipient))
    throw new RequestError(403, "pilot_recipient_not_allowed");
  const idempotencyKey = normaliseText(
    body?.idempotencyKey || body?.idempotency_key,
  );
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new RequestError(400, "idempotency_key_required");
  if (!hasGraphConfig(env))
    throw new RequestError(503, "graph_configuration_incomplete");

  const data = await loadPlanData(env, httpFetch);
  if (!data.extract || !data.settings.managerEmail)
    throw new RequestError(503, "manager_briefing_not_ready");
  const message = buildManagerBriefing(data.model, data.extract, now);
  const deliveryId = await deterministicUuid(idempotencyKey);
  const reservation = await reserveDelivery(
    env,
    deliveryId,
    recipient,
    message.subject,
    httpFetch,
  );
  if (!reservation.created) {
    const status = String(reservation.row?.status || "").toLowerCase();
    if (status === "sent")
      return {
        ok: true,
        status: "already-sent",
        duplicate: true,
        mode: "pilot",
        briefingType: "manager",
      };
    if (status === "reserved" || status === "sending")
      throw new RequestError(409, "delivery_in_progress");
    throw new RequestError(409, "idempotency_key_used");
  }

  let run = null;
  let digest = null;
  try {
    run = await createRun(
      env,
      {
        trigger: `manual-pilot:${caller.identity}`,
        extract_id: data.extract.id || data.extract.extract_id || null,
        extract_date:
          data.extract.extract_date || data.extract.effective_date || null,
        status: "started",
        claim_count: data.model.metrics.active,
        delivery_count: 1,
      },
      httpFetch,
    );
    await patchDelivery(
      env,
      deliveryId,
      { run_id: run.id, status: "sending" },
      httpFetch,
    );
    digest = await createDigestLog(env, message, recipient, httpFetch);
    await sendGraphEmail(env, recipient, message, httpFetch);
    await patchDelivery(
      env,
      deliveryId,
      { status: "sent", error: null },
      httpFetch,
    );
    await patchDigestLog(env, digest.id, { sent_ok: true }, httpFetch);
    await patchRun(
      env,
      run.id,
      { status: "completed", completed_at: now.toISOString() },
      httpFetch,
    );
    return { ok: true, status: "sent", mode: "pilot", briefingType: "manager" };
  } catch (error) {
    const failure =
      error instanceof RequestError
        ? error
        : new RequestError(502, "pilot_delivery_failed");
    try {
      await patchDelivery(
        env,
        deliveryId,
        { status: "failed", error: failure.code },
        httpFetch,
      );
    } catch {
      /* preserve the primary failure */
    }
    if (digest?.id) {
      try {
        await patchDigestLog(env, digest.id, { sent_ok: false }, httpFetch);
      } catch {
        /* preserve the primary failure */
      }
    }
    if (run?.id) {
      try {
        await patchRun(
          env,
          run.id,
          { status: "failed", completed_at: now.toISOString() },
          httpFetch,
        );
      } catch {
        /* preserve the primary failure */
      }
    }
    throw failure;
  }
}

function errorResponse(error, origin) {
  if (error instanceof RequestError)
    return json({ ok: false, error: error.code }, error.status, origin);
  if (error instanceof StorageError)
    return json({ ok: false, error: "storage_unavailable" }, 503, origin);
  return json({ ok: false, error: "internal_error" }, 500, origin);
}

export function createBriefingsWorker({
  fetchImpl = globalThis.fetch.bind(globalThis),
  now = () => new Date(),
} = {}) {
  return {
    async fetch(request, env = {}) {
      const origin = request.headers.get("Origin");
      try {
        if (origin && origin !== PRODUCTION_ORIGIN)
          throw new RequestError(403, "origin_not_allowed");
        const url = new URL(request.url);
        if (request.method === "OPTIONS") return empty(204, origin);
        if (url.pathname === "/health" && request.method === "GET") {
          return json(
            {
              ok: true,
              service: "scout-briefings",
              mode: "pilot",
              scheduledDelivery: false,
            },
            200,
            origin,
          );
        }

        const caller = await authenticate(request, env, fetchImpl);
        if (url.pathname === "/briefings/plan" && request.method === "POST") {
          const data = await loadPlanData(env, fetchImpl);
          return json(planResult(data, env), 200, origin);
        }
        if (
          url.pathname === "/briefings/send-pilot" &&
          request.method === "POST"
        ) {
          return json(
            await sendPilot(request, env, caller, fetchImpl, now()),
            200,
            origin,
          );
        }
        if (url.pathname === "/briefing-runs" && request.method === "GET") {
          const table = tableFor(env, "SUPABASE_BRIEFING_RUNS_TABLE", "runs");
          const rows = await storageRequest(
            env,
            `${table}?select=id,trigger,extract_date,status,started_at,completed_at,claim_count,delivery_count&order=started_at.desc&limit=20`,
            {},
            fetchImpl,
          );
          return json(
            { runs: Array.isArray(rows) ? rows.map(safeHistoryRun) : [] },
            200,
            origin,
          );
        }
        if (url.pathname === "/digest-log" && request.method === "GET") {
          const table = tableFor(env, "SUPABASE_DIGEST_LOG_TABLE", "digestLog");
          const rows = await storageRequest(
            env,
            `${table}?select=id,generated_at,type,subject,claims_count,critical_count,sent_ok&order=generated_at.desc&limit=100`,
            {},
            fetchImpl,
          );
          return json(
            { digests: Array.isArray(rows) ? rows.map(safeHistoryDigest) : [] },
            200,
            origin,
          );
        }
        throw new RequestError(404, "not_found");
      } catch (error) {
        return errorResponse(error, origin);
      }
    },
  };
}

export default createBriefingsWorker();
