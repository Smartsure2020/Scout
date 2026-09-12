/**
 * Scout Briefings — isolated manual Teams manager pilot.
 *
 * This Worker deliberately owns only production manager briefing generation,
 * Teams delivery, and delivery history. It has no scheduled entrypoint.
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
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
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
    "Cache-Control": "no-store",
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
  const isPaymentStatus =
    PAYMENT_STATUSES.has(status) || status.includes("payment requested");
  const isActiveOrAssessor =
    status.includes("active") ||
    status.includes("registered") ||
    status.includes("authorised") ||
    status.includes("in progress") ||
    isAssessorClaim(claim);
  const flags = [];

  if (isPaymentStatus && estimate === 0) {
    flags.push(
      status === "payment requested"
        ? "Zero estimate — cannot pay without estimate"
        : "Payment requested — zero estimate: review for closure or data error",
    );
  } else if (isActiveOrAssessor && estimate === 0 && age > 14) {
    flags.push("No estimate captured — assessor update needed");
  }
  if (outstanding > 0 && estimate === 0)
    flags.push("Estimate missing — outstanding value set, estimate not");
  else if (
    estimate === 0 &&
    outstanding === 0 &&
    !isPaymentStatus &&
    !isTerminalClaim(claim)
  ) {
    flags.push("Zero value claim — possible data error or NTU candidate");
  }
  if (status === "fraud") flags.push("Fraud matter — urgent insurer liaison");
  if (status.includes("ombudsman") || status.includes("nfo"))
    flags.push("NFO complaint active — urgent management attention");
  if (status.includes("mandate") || outstanding >= 100000) {
    flags.push(
      outstanding >= 100000 && age > 30
        ? "High value — mandate authority required"
        : "Mandate check",
    );
  }
  if (!isTerminalClaim(claim) && !isLegalClaim(claim)) {
    const movementDays = Number(
      claim?.daysSinceMovement ?? claim?.days_since_movement,
    );
    if (Number.isFinite(movementDays) && movementDays > 30)
      flags.push("No movement in 30 days - review or close");
    else if (Number.isFinite(movementDays) && movementDays > 14)
      flags.push("No movement in 14+ days — review");
  }
  if (status === "repudiated" && age > 270)
    flags.push("9-month window closed — close or escalate");
  if (status === "awaiting assessor report" && age > 14)
    flags.push("Assessor report overdue (target: 7–14 days)");
  if (status === "awaiting investigators report" && age > 14)
    flags.push("Investigator report overdue (target: 7–12 days)");
  if (status === "awaiting broker feedback" && age > 7)
    flags.push("Broker unresponsive > 7 days — escalate");
  if (status === "registered" && age > 5)
    flags.push("New claim unactioned — assign handler immediately");
  if (claim?.possibleDuplicate || claim?.possible_duplicate)
    flags.push("Possible duplicate — verify before processing");
  if (isLegalClaim(claim) && age > 60)
    flags.push("Recovery overdue — monthly attorney update needed");
  if (outstanding > 0 && estimate > 0 && outstanding > estimate * 1.5)
    flags.push("Outstanding exceeds estimate by 50%+ — review");
  const closureCandidate = getReadyToCloseCandidate(claim);
  if (closureCandidate) flags.push(closureCandidate.flag);
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
    flags.some(
      (flag) =>
        flag.includes("cannot pay") ||
        flag.includes("Fraud") ||
        flag.includes("NFO") ||
        flag.includes("High value") ||
        flag.includes("mandate") ||
        flag.includes("9-month") ||
        flag.includes("New claim unactioned"),
    ) ||
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
  return !!getReadyToCloseCandidate(claim);
}

function isNoMovementClaim(claim) {
  const movementDays = Number(
    claim?.daysSinceMovement ?? claim?.days_since_movement,
  );
  return (
    !isTerminalClaim(claim) &&
    !isLegalClaim(claim) &&
    Number.isFinite(movementDays) &&
    movementDays > 30
  );
}

function isAwaitingExternalClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    status.includes("awaiting broker") ||
    status.includes("broker feedback") ||
    status.includes("awaiting client") ||
    status.includes("reply from broker") ||
    status.includes("broker/client") ||
    status.includes("instructions from broker")
  );
}

function isAssessorReportOverdueClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    isAssessorClaim(claim) &&
    (status.includes("report") ||
      status.includes("feedback") ||
      status.includes("assessor")) &&
    claimAge(claim) >= 7
  );
}

function isPaymentClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    PAYMENT_STATUSES.has(status) ||
    status.includes("payment requested") ||
    status.includes("payment - approved")
  );
}

function hasRecoveryPending(claim) {
  const text =
    `${claimStatus(claim)} ${claim?.description || ""} ${claim?.comments || ""}`.toLowerCase();
  return (
    text.includes("recovery pending") ||
    text.includes("awaiting recovery") ||
    text.includes("recoveries pending")
  );
}

function getReadyToCloseCandidate(claim) {
  const status = normaliseStatus(claimStatus(claim));
  if (isTerminalClaim(claim) && !status.startsWith("settled")) return null;
  const age = claimAge(claim);
  const estimate = claimEstimate(claim);
  const recoveryPending = hasRecoveryPending(claim);

  if (status === "repudiated - awaiting closure" && age > 7) {
    return {
      ruleNo: 1,
      priority: "P1",
      flag: "Consider closing — repudiated awaiting closure",
      action: "Close immediately",
    };
  }
  if (status === "payment - payments made" && age > 21) {
    return {
      ruleNo: 2,
      priority: "P2",
      flag: "Consider closing — payments confirmed",
      action: recoveryPending
        ? "Check recovery before closure"
        : "Close unless recovery",
    };
  }
  if (status === "payment released" && age > 14) {
    return {
      ruleNo: 3,
      priority: "P2",
      flag: "Consider closing — payment released",
      action: "Close unless excess outstanding",
    };
  }
  if (
    status.startsWith("settled") &&
    status !== "settled - awaiting recovery" &&
    age > 14
  ) {
    return {
      ruleNo: 4,
      priority: "P2",
      flag: "Settlement complete — close claim",
      action: "Close claim",
    };
  }
  if (status === "payment requested" && estimate === 0 && age > 30) {
    return {
      ruleNo: 5,
      priority: "P2",
      flag: "Zero estimate payment request — data error or NTU",
      action: "Review data error or NTU",
    };
  }
  if (status === "registered" && age > 60) {
    return {
      ruleNo: 6,
      priority: "P2",
      flag: "Registered 60+ days — likely abandoned/NTU",
      action: "Likely abandoned / NTU",
    };
  }
  return null;
}

function isRiskWatchClaim(claim) {
  const status = normaliseStatus(claimStatus(claim));
  return (
    isLegalClaim(claim) ||
    status.includes("repudiat") ||
    status.includes("mandate") ||
    claimOutstanding(claim) >= 100000
  );
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
  if (isAwaitingExternalClaim(claim)) return "Follow up with broker or client";
  if (isPaymentClaim(claim))
    return "Confirm payment status and close if complete";
  const closure = getReadyToCloseCandidate(claim);
  if (closure) return closure.action;
  return "Review and progress claim";
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatCurrency(value) {
  return `R${Math.round(number(value)).toLocaleString("en-ZA")}`;
}

function formatDate(value) {
  const text = normaliseText(value);
  return text ? text.slice(0, 10) : "Unavailable";
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
      isRisk: isRiskWatchClaim,
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
      includeSettled: true,
    },
  );
}

export function buildPilotBriefingModel({
  claims = [],
  previousClaims = [],
  extract = null,
  settings = {},
  env = {},
} = {}) {
  const resolvedSettings =
    settings &&
    Object.prototype.hasOwnProperty.call(settings, "includeTerminalClaims")
      ? settings
      : normaliseSettings(settings);
  return modelFor(
    Array.isArray(claims) ? claims : [],
    Array.isArray(previousClaims) ? previousClaims : [],
    extract,
    resolvedSettings,
    env,
  );
}

export function buildManagerBriefing(model, extract, now = new Date()) {
  const extractDate = formatDate(
    model.extractDate || extract?.effective_date || extract?.extract_date,
  );
  const runDate = formatDate(now.toISOString());
  const subject = `Scout manager briefing — ${runDate}`;
  const itemByClaimNo = new Map(
    model.handler.items.map((item) => [item.claimNo, item]),
  );
  const attentionItems = model.attention
    .flatMap((section) =>
      section.claims.map((claim) => {
        const item = itemByClaimNo.get(String(claimNo(claim)));
        return {
          claimNo: claimNo(claim),
          outstanding: claimOutstanding(claim),
          primaryReason: section.label,
          nextAction: nextAction(claim),
          url: item?.url || "",
        };
      }),
    )
    .slice(0, 12);
  const riskItems = model.topRisks.items.slice(0, 5);
  const closureItems = attentionItems.filter((item) =>
    item.primaryReason.toLowerCase().includes("closure"),
  );
  const lines = [
    `Scout Manager Briefing — ${runDate}`,
    `Data as at: ${extractDate}`,
    `Comparison: ${model.comparisonLabel}`,
    "",
    "Portfolio",
    `- Active claims: ${model.metrics.active}`,
    `- Critical SLA: ${model.metrics.critical}`,
    `- Stale / at-risk: ${model.metrics.stale}`,
    `- Outstanding exposure: ${formatCurrency(model.metrics.exposure)}`,
    "",
    "Management attention",
  ];
  if (attentionItems.length) {
    lines.push(...attentionItems.map(managerItemLine));
  } else {
    lines.push("- No priority concerns in this extract.");
  }
  lines.push("", "Top risk watch");
  if (riskItems.length) {
    lines.push(...riskItems.map(managerItemLine));
  } else {
    lines.push("- No risk-watch claims in this extract.");
  }
  if (closureItems.length) {
    lines.push(
      "",
      "Closure candidates",
      ...closureItems.slice(0, 5).map(managerItemLine),
    );
  }
  return {
    subject,
    title: `Scout Manager Briefing — ${runDate}`,
    text: lines.join("\n"),
    claimsCount: model.metrics.active,
    criticalCount: model.metrics.critical,
  };
}

function managerItemLine(item) {
  const link = item.url ? ` — ${item.url}` : "";
  return `- ${item.claimNo} — ${item.primaryReason}; ${item.nextAction}; outstanding ${formatCurrency(item.outstanding)}${link}`;
}

export function buildTeamsManagerWebhookPayload(message) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: message.title,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
            },
            { type: "TextBlock", text: message.text, wrap: true },
          ],
        },
      },
    ],
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
    normaliseText(env.SUPABASE_URL) && normaliseText(env.SUPABASE_SECRET_KEY),
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
    handlerEmails,
    includeTerminalClaims: raw.include_terminal_claims === true,
    available: Object.keys(raw).length > 0,
  };
}

function supabaseHeaders(env, preferRepresentation = false) {
  return {
    apikey: env.SUPABASE_SECRET_KEY,
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
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return {
    settings: normaliseSettings(row?.value || {}),
    rowAvailable: Boolean(row),
  };
}

async function loadPlanData(env, httpFetch) {
  const [data, settingsResult] = hasStorageConfig(env)
    ? await Promise.all([
        loadExtractClaims(env, httpFetch),
        loadSettings(env, httpFetch),
      ])
    : [
        {
          extract: null,
          previousExtract: null,
          claims: [],
          previousClaims: [],
        },
        { settings: normaliseSettings({}), rowAvailable: false },
      ];
  const settings = settingsResult.settings;
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
    settingsRowAvailable: settingsResult.rowAvailable,
    model,
    handlerNames,
    missingHandlers,
    mappedHandlerCount,
  };
}

function isAllowlistConfigured(raw) {
  return parseIdentityAllowlist(raw).length > 0;
}

function teamsManagerWebhookUrl(env) {
  const value = normaliseText(env.TEAMS_MANAGER_WEBHOOK);
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? value : "";
  } catch {
    return "";
  }
}

function hasTeamsManagerWebhook(env) {
  return Boolean(teamsManagerWebhookUrl(env));
}

function managerPilotReadiness(data, env) {
  const blockingReasons = [];
  const warnings = [];
  const callerListConfigured = isAllowlistConfigured(
    env.DELIVERY_ALLOWED_CALLERS_JSON,
  );

  if (!data.extract) blockingReasons.push("current_extract_unavailable");
  if (!data.settingsRowAvailable)
    blockingReasons.push("scout_settings_digest_row_unavailable");
  if (!data.settings.available)
    blockingReasons.push("manager_briefing_configuration_unavailable");
  if (!hasStorageConfig(env))
    blockingReasons.push("supabase_configuration_incomplete");
  if (!hasTeamsManagerWebhook(env))
    blockingReasons.push("teams_manager_webhook_unavailable");
  if (!callerListConfigured)
    blockingReasons.push("caller_allowlist_unavailable");

  if (data.missingHandlers.length)
    warnings.push("handler_email_mappings_incomplete");

  return {
    managerPilotReady: blockingReasons.length === 0,
    blockingReasons,
    warnings,
  };
}

function planResult(data, env) {
  const readiness = managerPilotReadiness(data, env);
  return {
    mode: "pilot",
    extractDate:
      data.extract?.extract_date || data.extract?.effective_date || null,
    effectiveDate:
      data.extract?.effective_date || data.extract?.extract_date || null,
    claimCount: data.claims.length,
    activeClaimCount: data.model.metrics.active,
    managerBriefingConfigured: Boolean(data.settings.available),
    handlerCount: data.handlerNames.length,
    mappedHandlerCount: data.mappedHandlerCount,
    missingHandlers: data.missingHandlers,
    comparisonAvailable: data.model.comparisonAvailable,
    readiness,
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

async function reserveDelivery(env, deliveryId, subject, httpFetch) {
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
          recipient_name: "Claims Manager Teams",
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

async function createDigestLog(env, message, httpFetch) {
  const table = tableFor(env, "SUPABASE_DIGEST_LOG_TABLE", "digestLog");
  const rows = await storageRequest(
    env,
    table,
    {
      method: "POST",
      body: JSON.stringify({
        type: "manager",
        subject: message.subject,
        claims_count: message.claimsCount,
        critical_count: message.criticalCount,
        html_body: message.text,
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

async function sendTeamsManagerBriefing(env, message, httpFetch) {
  const webhook = teamsManagerWebhookUrl(env);
  if (!webhook)
    throw new RequestError(503, "teams_manager_webhook_unavailable");
  let response;
  try {
    response = await httpFetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTeamsManagerWebhookPayload(message)),
    });
  } catch {
    throw new RequestError(502, "teams_delivery_ambiguous", {
      transportAccepted: null,
      deliveryConfirmed: false,
    });
  }
  if (!response.ok) throw new RequestError(502, "teams_delivery_failed");
  return {
    transportAccepted: true,
    deliveryConfirmed: false,
  };
}

const DESTINATION_FIELDS = new Set([
  "pilotRecipient",
  "pilot_recipient",
  "pilotRecipientEmail",
  "pilot_recipient_email",
  "recipient",
  "recipientEmail",
  "recipient_email",
  "to",
  "toEmail",
  "to_email",
  "toName",
  "to_name",
  "webhook",
  "webhookUrl",
  "webhook_url",
  "webhookURL",
  "teamsWebhook",
  "teams_webhook",
  "channel",
  "channelId",
  "channel_id",
  "destination",
  "destinationUrl",
  "destination_url",
  "teamsDestination",
  "teams_destination",
  "managerEmail",
  "manager_email",
]);

const SEND_REQUEST_FIELDS = new Set(["briefingType", "idempotencyKey"]);

function hasDestinationField(body) {
  return (
    body &&
    typeof body === "object" &&
    Object.keys(body).some((key) => DESTINATION_FIELDS.has(key))
  );
}

async function sendPilot(request, env, caller, httpFetch, now) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RequestError(400, "invalid_json");
  if (hasDestinationField(body))
    throw new RequestError(400, "destination_not_allowed");
  if (Object.keys(body).some((key) => !SEND_REQUEST_FIELDS.has(key)))
    throw new RequestError(400, "unsupported_request_field");
  const type = normaliseText(body.briefingType).toLowerCase();
  if (type !== "manager")
    throw new RequestError(400, "only_manager_pilot_supported");
  const idempotencyKey = normaliseText(body.idempotencyKey);
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new RequestError(400, "idempotency_key_required");
  const data = await loadPlanData(env, httpFetch);
  const readiness = managerPilotReadiness(data, env);
  if (!readiness.managerPilotReady)
    throw new RequestError(503, "manager_pilot_not_ready", readiness);
  const message = buildManagerBriefing(data.model, data.extract, now);
  const deliveryId = await deterministicUuid(idempotencyKey);
  const reservation = await reserveDelivery(
    env,
    deliveryId,
    message.subject,
    httpFetch,
  );
  if (!reservation.created) {
    const status = String(reservation.row?.status || "").toLowerCase();
    if (status === "accepted")
      return {
        ok: true,
        status: "already-accepted",
        duplicate: true,
        transportAccepted: true,
        deliveryConfirmed: false,
        mode: "pilot",
        briefingType: "manager",
      };
    if (status === "reserved" || status === "sending")
      throw new RequestError(409, "delivery_in_progress");
    throw new RequestError(409, "idempotency_key_used");
  }

  let run = null;
  let digest = null;
  let transportAccepted = false;
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
    digest = await createDigestLog(env, message, httpFetch);
    transportAccepted = (
      await sendTeamsManagerBriefing(env, message, httpFetch)
    ).transportAccepted;
    await patchDelivery(
      env,
      deliveryId,
      { status: "accepted", error: null },
      httpFetch,
    );
    await patchDigestLog(env, digest.id, { sent_ok: true }, httpFetch);
    await patchRun(
      env,
      run.id,
      { status: "completed", completed_at: now.toISOString() },
      httpFetch,
    );
    return {
      ok: true,
      status: "accepted",
      transportAccepted: true,
      deliveryConfirmed: false,
      mode: "pilot",
      briefingType: "manager",
    };
  } catch (error) {
    const failure =
      error instanceof RequestError
        ? error
        : new RequestError(502, "pilot_delivery_failed");
    if (transportAccepted) {
      try {
        await patchDelivery(
          env,
          deliveryId,
          {
            status: "accepted_audit_incomplete",
            error: "accepted_audit_incomplete",
          },
          httpFetch,
        );
      } catch {
        /* preserve the transport-accepted outcome */
      }
      if (digest?.id) {
        try {
          await patchDigestLog(env, digest.id, { sent_ok: true }, httpFetch);
        } catch {
          /* preserve the transport-accepted outcome */
        }
      }
      if (run?.id) {
        try {
          await patchRun(
            env,
            run.id,
            {
              status: "accepted_audit_incomplete",
              completed_at: now.toISOString(),
            },
            httpFetch,
          );
        } catch {
          /* preserve the transport-accepted outcome */
        }
      }
      throw new RequestError(502, "accepted_audit_incomplete", {
        transportAccepted: true,
        deliveryConfirmed: false,
      });
    }
    if (failure.code === "teams_delivery_ambiguous") {
      try {
        await patchDelivery(
          env,
          deliveryId,
          { status: "delivery_unknown", error: failure.code },
          httpFetch,
        );
      } catch {
        /* preserve the ambiguous provider outcome */
      }
      if (digest?.id) {
        try {
          await patchDigestLog(env, digest.id, { sent_ok: false }, httpFetch);
        } catch {
          /* preserve the ambiguous provider outcome */
        }
      }
      if (run?.id) {
        try {
          await patchRun(
            env,
            run.id,
            { status: "delivery_unknown", completed_at: now.toISOString() },
            httpFetch,
          );
        } catch {
          /* preserve the ambiguous provider outcome */
        }
      }
      throw failure;
    }
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
    return json(
      { ok: false, error: error.code, ...error.details },
      error.status,
      origin,
    );
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
              delivery: "teams-manager",
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
