/*
 * Shared briefing presentation model.
 *
 * This module deliberately does not calculate claim rules.  Callers provide
 * the existing deterministic predicates and presentation mappings, while this
 * layer owns briefing caps, primary-reason assignment, comparison validity,
 * team summaries and link metadata for all briefing transports.
 */

const DEFAULT_CAPS = Object.freeze({
  attention: 5,
  risks: 5,
  urgent: 5,
  secondary: 4,
  totalHandlerItems: 15,
});

function fn(helpers, name, fallback) {
  return typeof helpers[name] === "function" ? helpers[name] : fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function claimKey(claim, getClaimNo) {
  const value = getClaimNo(claim);
  return value ? String(value) : "claim:" + String(claim?.id || claim?.claim_id || "");
}

function uniqueClaims(claims, getClaimNo) {
  const seen = new Set();
  return claims.filter((claim) => {
    const key = claimKey(claim, getClaimNo);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function capItems(items, limit, total = items.length) {
  return { items: items.slice(0, limit), total, hasMore: total > limit };
}

export function buildBriefingModel(inputClaims = [], helpers = {}, options = {}) {
  const getClaimNo = fn(helpers, "getClaimNo", (claim) => claim?.claimNo || claim?.claim_no || "");
  const getHandler = fn(helpers, "getHandler", (claim) => claim?.handler || claim?.handler_name || "Unassigned");
  const getInsured = fn(helpers, "getInsured", (claim) => claim?.insured || claim?.insured_name || "Unknown insured");
  const getAge = fn(helpers, "getAge", (claim) => claim?.workingAge || claim?.working_age || claim?.age_days || 0);
  const getScore = fn(helpers, "getScore", (claim) => claim?.priority?.score || claim?.priority_score || 0);
  const isTerminal = fn(helpers, "isTerminal", () => false);
  const isSettled = fn(helpers, "isSettled", (claim) => String(claim?.status || "").toLowerCase().startsWith("settled"));
  const isCritical = fn(helpers, "isCritical", () => false);
  const isStale = fn(helpers, "isStale", () => false);
  const isZeroEstimate = fn(helpers, "isZeroEstimate", () => false);
  const isRisk = fn(helpers, "isRisk", () => false);
  const isMandate = fn(helpers, "isMandate", () => false);
  const isClosure = fn(helpers, "isClosure", () => false);
  const isNoMovement = fn(helpers, "isNoMovement", () => false);
  const isAwaitingExternal = fn(helpers, "isAwaitingExternal", () => false);
  const isAssessorOverdue = fn(helpers, "isAssessorOverdue", () => false);
  const isPayment = fn(helpers, "isPayment", () => false);
  const isNew = fn(helpers, "isNew", () => false);
  const getOutstanding = fn(helpers, "getOutstanding", () => 0);
  const getPrimaryReason = fn(helpers, "getPrimaryReason", () => "Review claim progress");
  const getNextAction = fn(helpers, "getNextAction", () => "Review and progress claim");
  const claimUrl = fn(helpers, "claimUrl", () => "");
  const handlerUrl = fn(helpers, "handlerUrl", () => "");
  const exceptionUrl = fn(helpers, "exceptionUrl", () => "");
  const caps = { ...DEFAULT_CAPS, ...(options.caps || {}) };
  const source = Array.isArray(inputClaims) ? inputClaims : [];
  const active = options.includeTerminalClaims
    ? source.slice()
    : source.filter((claim) => !isTerminal(claim) || (options.includeSettled && isSettled(claim)));
  const sorted = active.slice().sort((a, b) => number(getScore(b)) - number(getScore(a)) || number(getAge(b)) - number(getAge(a)));
  const comparisonAvailable = options.comparisonAvailable === true ||
    (options.comparisonAvailable == null && Array.isArray(options.previousClaims));
  const previousClaims = comparisonAvailable && Array.isArray(options.previousClaims)
    ? options.previousClaims
    : [];
  const previousCritical = new Set(previousClaims.filter(isCritical).map((claim) => claimKey(claim, getClaimNo)));
  const criticalClaims = active.filter(isCritical);
  const staleClaims = active.filter((claim) => isStale(claim) && !isCritical(claim));
  const zeroClaims = active.filter(isZeroEstimate);
  const riskClaims = active.filter(isRisk).sort((a, b) => number(getScore(b)) - number(getScore(a)) || number(getAge(b)) - number(getAge(a)));
  const mandateClaims = active.filter(isMandate);
  const closureClaims = active.filter(isClosure);
  const noMovementClaims = active.filter(isNoMovement);
  const totalExposure = active.reduce((sum, claim) => sum + number(getOutstanding(claim)), 0);

  function linkForClaim(claim) {
    return claimUrl(claim) || "";
  }

  function claimItem(claim, fallbackReason = "Review claim progress") {
    const primaryReason = String(getPrimaryReason(claim) || fallbackReason);
    return {
      claim,
      claimNo: String(getClaimNo(claim) || "Unknown claim"),
      insured: String(getInsured(claim) || "Unknown insured"),
      handler: String(getHandler(claim) || "Unassigned"),
      age: number(getAge(claim)),
      primaryReason,
      nextAction: String(getNextAction(claim) || "Review and progress claim"),
      outstanding: number(getOutstanding(claim)),
      score: number(getScore(claim)),
      url: linkForClaim(claim),
    };
  }

  const attentionDefinitions = [
    { key: "critical", label: "Critical SLA breach", claims: criticalClaims, action: "Open the critical SLA queue", exception: "critical" },
    { key: "sla-risk", label: "SLA at risk", claims: staleClaims, action: "Review claims approaching or past SLA", exception: "sla-risk" },
    { key: "zero-estimate", label: "Zero estimate anomaly", claims: zeroClaims, action: "Validate estimate and payment or closure state", exception: "zero-estimate" },
    { key: "mandate", label: "Mandate authority required", claims: mandateClaims, action: "Review authority and management decision", exception: "mandate" },
    { key: "closure", label: "Closure candidates", claims: closureClaims, action: "Complete final checks before closure", exception: "closure" },
  ];
  const attention = attentionDefinitions
    .filter((definition) => definition.claims.length)
    .slice(0, caps.attention)
    .map((definition) => ({
      ...definition,
      count: definition.claims.length,
      url: exceptionUrl(definition.exception),
      overlapNote: "Counts may overlap; one claim can appear in more than one queue.",
    }));

  const handlers = [...new Set(active.map(getHandler))].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  const team = handlers.map((handler) => {
    const claims = active.filter((claim) => getHandler(claim) === handler);
    const critical = claims.filter(isCritical).length;
    const stale = claims.filter((claim) => isStale(claim) && !isCritical(claim)).length;
    const blocker = sorted.find((claim) => getHandler(claim) === handler && number(getScore(claim)) > 0);
    return {
      handler: String(handler),
      active: claims.length,
      critical,
      stale,
      primaryBlocker: blocker ? String(getPrimaryReason(blocker) || "Review claim progress") : "No current blocker",
      url: handlerUrl(handler),
      criticalUrl: exceptionUrl("critical", handler),
    };
  });

  const topRisks = capItems(riskClaims.map((claim) => claimItem(claim, "Risk review")).slice(0, caps.risks), caps.risks, riskClaims.length);

  function briefingGroup(claim) {
    const critical = isCritical(claim) || number(getScore(claim)) >= 45;
    if (critical) return "urgent";
    if (isMandate(claim)) return "decision";
    if (isAssessorOverdue(claim) || isAwaitingExternal(claim) || isNoMovement(claim)) return "followup";
    if (isPayment(claim) || isZeroEstimate(claim)) return "payment";
    if (isClosure(claim)) return "closure";
    if (comparisonAvailable && isNew(claim)) return "new";
    return number(getScore(claim)) > 0 ? "followup" : "informational";
  }

  const assigned = new Map();
  sorted.forEach((claim) => {
    if (number(getScore(claim)) <= 0 && !isNew(claim) && !isClosure(claim) && !isZeroEstimate(claim)) return;
    const key = claimKey(claim, getClaimNo);
    if (!assigned.has(key)) assigned.set(key, briefingGroup(claim));
  });
  const grouped = { urgent: [], decision: [], followup: [], payment: [], closure: [], new: [] };
  assigned.forEach((group, key) => {
    const claim = sorted.find((candidate) => claimKey(candidate, getClaimNo) === key);
    if (claim && grouped[group]) grouped[group].push(claimItem(claim));
  });
  const handlerItems = [];
  ["urgent", "decision", "followup", "payment", "closure", "new"].forEach((group) => {
    grouped[group].forEach((item) => handlerItems.push({ ...item, group }));
  });
  const section = (group, limit) => {
    const all = grouped[group] || [];
    return capItems(all, limit, all.length);
  };
  const cappedHandlerItems = handlerItems.slice(0, caps.totalHandlerItems);
  const displayedByGroup = cappedHandlerItems.reduce((groups, item) => {
    (groups[item.group] ||= []).push(item);
    return groups;
  }, {});
  const handlerSections = {
    urgent: capItems(displayedByGroup.urgent || [], caps.urgent, grouped.urgent.length),
    decision: capItems(displayedByGroup.decision || [], caps.secondary, grouped.decision.length),
    followup: capItems(displayedByGroup.followup || [], caps.secondary, grouped.followup.length),
    payment: capItems(displayedByGroup.payment || [], caps.secondary, grouped.payment.length),
    closure: capItems(displayedByGroup.closure || [], caps.secondary, grouped.closure.length),
    new: capItems(displayedByGroup.new || [], caps.secondary, grouped.new.length),
  };

  return {
    generatedDate: options.generatedDate || null,
    extractDate: options.extractDate || null,
    freshness: options.freshness || null,
    comparisonAvailable,
    comparisonLabel: comparisonAvailable ? "Compared with previous extract" : "Comparison unavailable",
    active,
    metrics: {
      active: active.length,
      critical: criticalClaims.length,
      stale: staleClaims.length,
      exposure: totalExposure,
      zeroEstimate: zeroClaims.length,
      mandate: mandateClaims.length,
      closure: closureClaims.length,
      noMovement: noMovementClaims.length,
      newClaims: comparisonAvailable ? active.filter(isNew).length : null,
      newCritical: comparisonAvailable ? criticalClaims.filter((claim) => !previousCritical.has(claimKey(claim, getClaimNo))).length : null,
    },
    attention,
    team,
    topRisks,
    handlers,
    handler: {
      active,
      critical: criticalClaims,
      stale: staleClaims,
      onTrack: Math.max(0, active.length - criticalClaims.length - staleClaims.length),
      comparisonAvailable,
      sections: handlerSections,
      items: cappedHandlerItems,
      itemTotal: handlerItems.length,
      hasMore: handlerItems.length > cappedHandlerItems.length,
    },
  };
}

if (typeof window !== "undefined") {
  window.ScoutBriefings = { buildBriefingModel };
}
