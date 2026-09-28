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
  managerAttention: 12,
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
  return value
    ? String(value)
    : "claim:" + String(claim?.id || claim?.claim_id || "");
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

export function buildBriefingModel(
  inputClaims = [],
  helpers = {},
  options = {},
) {
  const getClaimNo = fn(
    helpers,
    "getClaimNo",
    (claim) => claim?.claimNo || claim?.claim_no || "",
  );
  const getHandler = fn(
    helpers,
    "getHandler",
    (claim) => claim?.handler || claim?.handler_name || "Unassigned",
  );
  const getInsured = fn(
    helpers,
    "getInsured",
    (claim) => claim?.insured || claim?.insured_name || "Unknown insured",
  );
  const getAge = fn(
    helpers,
    "getAge",
    (claim) => claim?.workingAge || claim?.working_age || claim?.age_days || 0,
  );
  const getScore = fn(
    helpers,
    "getScore",
    (claim) => claim?.priority?.score || claim?.priority_score || 0,
  );
  const isTerminal = fn(helpers, "isTerminal", () => false);
  const isSettled = fn(helpers, "isSettled", (claim) =>
    String(claim?.status || "")
      .toLowerCase()
      .startsWith("settled"),
  );
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
  const getStatus = fn(helpers, "getStatus", (claim) =>
    String(claim?.status || claim?.claim_status || ""),
  );
  const getEstimate = fn(helpers, "getEstimate", (claim) =>
    number(claim?.estimate),
  );
  const getPrimaryReason = fn(
    helpers,
    "getPrimaryReason",
    () => "Review claim progress",
  );
  const getNextAction = fn(
    helpers,
    "getNextAction",
    () => "Review and progress claim",
  );
  const claimUrl = fn(helpers, "claimUrl", () => "");
  const handlerUrl = fn(helpers, "handlerUrl", () => "");
  const exceptionUrl = fn(helpers, "exceptionUrl", () => "");
  const caps = { ...DEFAULT_CAPS, ...(options.caps || {}) };
  const source = Array.isArray(inputClaims) ? inputClaims : [];
  const active = options.includeTerminalClaims
    ? source.slice()
    : source.filter(
        (claim) =>
          !isTerminal(claim) || (options.includeSettled && isSettled(claim)),
      );
  const sorted = active
    .slice()
    .sort(
      (a, b) =>
        number(getScore(b)) - number(getScore(a)) ||
        number(getAge(b)) - number(getAge(a)),
    );
  const comparisonAvailable =
    options.comparisonAvailable === true ||
    (options.comparisonAvailable == null &&
      Array.isArray(options.previousClaims));
  const previousClaims =
    comparisonAvailable && Array.isArray(options.previousClaims)
      ? options.previousClaims
      : [];
  const previousCritical = new Set(
    previousClaims
      .filter(isCritical)
      .map((claim) => claimKey(claim, getClaimNo)),
  );

  // --- Claim-identity resolution -------------------------------------------
  // Collapse only field-equivalent duplicates. Conflicting rows that share a
  // claim number are treated as unresolved claim-number collisions: kept in
  // counts/exposure (their financial impact stays visible), excluded from
  // claim-level ranking, and surfaced explicitly as data-quality exceptions.
  function compareByMateriality(a, b) {
    return (
      number(getScore(b)) - number(getScore(a)) ||
      number(getOutstanding(b)) - number(getOutstanding(a)) ||
      number(getAge(b)) - number(getAge(a)) ||
      String(getClaimNo(a)).localeCompare(String(getClaimNo(b)))
    );
  }
  function moneyCents(value) {
    // Compare money in cents; sub-cent float noise and -0 collapse to 0 (keeps
    // the TOT0046-style floating residue equivalent) without rounding to rand.
    const cents = Math.round(number(value) * 100);
    return cents === 0 ? 0 : cents;
  }
  function textKey(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }
  function rowSignature(claim) {
    // Conservative field-equivalence fingerprint: two rows sharing a claim number
    // are only treated as a true duplicate when every briefing-relevant input
    // matches. A difference in handler, paid, mandate, age, movement, insured,
    // lifecycle state, or the free-text description/comments (which drive the
    // recovery-pending closure action) makes them an unresolved collision.
    return [
      textKey(getStatus(claim)),
      textKey(getHandler(claim)),
      textKey(getInsured(claim)),
      moneyCents(getOutstanding(claim)),
      moneyCents(getEstimate(claim)),
      moneyCents(claim?.paid),
      moneyCents(claim?.mandate), // mandate is a numeric field in history, not a boolean
      number(getAge(claim)),
      String(claim?.daysSinceMovement ?? claim?.days_since_movement ?? ""),
      String(claim?.movement_date ?? ""),
      claim?.terminal === true ? 1 : 0,
      claim?.open === true ? 1 : 0,
      textKey(claim?.description),
      textKey(claim?.comments),
    ].join("|");
  }
  function resolveIdentities(claims) {
    const groups = new Map();
    claims.forEach((claim, idx) => {
      const key = claimKey(claim, getClaimNo);
      const group = groups.get(key) || [];
      group.push({ claim, idx });
      groups.set(key, group);
    });
    const counted = [];
    const rankable = [];
    const fieldEquivalentClaimNumbers = [];
    let fieldEquivalentRowsSuppressed = 0;
    const collisions = [];
    for (const rows of groups.values()) {
      if (rows.length === 1) {
        counted.push(rows[0].claim);
        rankable.push(rows[0].claim);
        continue;
      }
      const equivalent =
        new Set(rows.map((row) => rowSignature(row.claim))).size === 1;
      if (equivalent) {
        rows.sort(
          (a, b) => compareByMateriality(a.claim, b.claim) || a.idx - b.idx,
        );
        counted.push(rows[0].claim);
        rankable.push(rows[0].claim);
        fieldEquivalentClaimNumbers.push(String(getClaimNo(rows[0].claim)));
        fieldEquivalentRowsSuppressed += rows.length - 1;
      } else {
        for (const row of rows) counted.push(row.claim);
        collisions.push({
          claimNumber: String(getClaimNo(rows[0].claim)),
          rowCount: rows.length,
          combinedOutstanding: rows.reduce(
            (sum, row) => sum + number(getOutstanding(row.claim)),
            0,
          ),
          combinedPaid: rows.reduce(
            (sum, row) => sum + number(row.claim?.paid),
            0,
          ),
          // Full row detail (all fingerprint inputs) so reconciliation can see
          // exactly which field(s) conflict — kept in metadata, not the body.
          rows: rows.map((row) => ({
            status: String(getStatus(row.claim)),
            handler: String(getHandler(row.claim) || "Unassigned"),
            insured: String(getInsured(row.claim) || ""),
            outstanding: number(getOutstanding(row.claim)),
            estimate: number(getEstimate(row.claim)),
            paid: number(row.claim?.paid),
            mandate: number(row.claim?.mandate),
            age: number(getAge(row.claim)),
            daysSinceMovement:
              row.claim?.daysSinceMovement ??
              row.claim?.days_since_movement ??
              null,
            terminal: row.claim?.terminal === true,
            open: row.claim?.open === true,
            description: String(row.claim?.description ?? ""),
            comments: String(row.claim?.comments ?? ""),
          })),
        });
      }
    }
    return {
      counted,
      rankable,
      fieldEquivalentClaimNumbers,
      fieldEquivalentRowsSuppressed,
      collisions,
    };
  }

  const activeIdentity = resolveIdentities(active);
  const countedActive = activeIdentity.counted;
  const rankableActive = activeIdentity.rankable;

  const criticalClaims = active.filter(isCritical);
  const staleClaims = active.filter(
    (claim) => isStale(claim) && !isCritical(claim),
  );
  const zeroClaims = active.filter(isZeroEstimate);
  // Top-risk ranking uses the collision-free rankable set so a claim-number
  // collision cannot occupy a risk slot; it appears under exceptions instead.
  const riskClaims = rankableActive
    .filter(isRisk)
    .sort(
      (a, b) =>
        number(getScore(b)) - number(getScore(a)) ||
        number(getAge(b)) - number(getAge(a)),
    );
  const mandateClaims = active.filter(isMandate);
  const closureClaims = active.filter(isClosure);
  const noMovementClaims = active.filter(isNoMovement);

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
    {
      key: "critical",
      label: "Critical SLA breach",
      claims: criticalClaims,
      action: "Open the critical SLA queue",
      exception: "critical",
    },
    {
      key: "sla-risk",
      label: "SLA at risk",
      claims: staleClaims,
      action: "Review claims approaching or past SLA",
      exception: "sla-risk",
    },
    {
      key: "zero-estimate",
      label: "Zero estimate anomaly",
      claims: zeroClaims,
      action: "Validate estimate and payment or closure state",
      exception: "zero-estimate",
    },
    {
      key: "mandate",
      label: "Mandate authority required",
      claims: mandateClaims,
      action: "Review authority and management decision",
      exception: "mandate",
    },
    {
      key: "closure",
      label: "Closure candidates",
      claims: closureClaims,
      action: "Complete final checks before closure",
      exception: "closure",
    },
  ];
  const attention = attentionDefinitions
    .filter((definition) => definition.claims.length)
    .slice(0, caps.attention)
    .map((definition) => ({
      ...definition,
      count: definition.claims.length,
      url: exceptionUrl(definition.exception),
      overlapNote:
        "Counts may overlap; one claim can appear in more than one queue.",
    }));

  const handlers = [...new Set(active.map(getHandler))]
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const team = handlers.map((handler) => {
    const claims = active.filter((claim) => getHandler(claim) === handler);
    const critical = claims.filter(isCritical).length;
    const stale = claims.filter(
      (claim) => isStale(claim) && !isCritical(claim),
    ).length;
    const blocker = sorted.find(
      (claim) => getHandler(claim) === handler && number(getScore(claim)) > 0,
    );
    return {
      handler: String(handler),
      active: claims.length,
      critical,
      stale,
      primaryBlocker: blocker
        ? String(getPrimaryReason(blocker) || "Review claim progress")
        : "No current blocker",
      url: handlerUrl(handler),
      criticalUrl: exceptionUrl("critical", handler),
    };
  });

  const topRisks = capItems(
    riskClaims
      .map((claim) => claimItem(claim, "Risk review"))
      .slice(0, caps.risks),
    caps.risks,
    riskClaims.length,
  );

  function briefingGroup(claim) {
    const critical = isCritical(claim) || number(getScore(claim)) >= 45;
    if (critical) return "urgent";
    if (isMandate(claim)) return "decision";
    if (
      isAssessorOverdue(claim) ||
      isAwaitingExternal(claim) ||
      isNoMovement(claim)
    )
      return "followup";
    if (isPayment(claim) || isZeroEstimate(claim)) return "payment";
    if (isClosure(claim)) return "closure";
    if (comparisonAvailable && isNew(claim)) return "new";
    return number(getScore(claim)) > 0 ? "followup" : "informational";
  }

  const assigned = new Map();
  sorted.forEach((claim) => {
    if (
      number(getScore(claim)) <= 0 &&
      !isNew(claim) &&
      !isClosure(claim) &&
      !isZeroEstimate(claim)
    )
      return;
    const key = claimKey(claim, getClaimNo);
    if (!assigned.has(key)) assigned.set(key, briefingGroup(claim));
  });
  const grouped = {
    urgent: [],
    decision: [],
    followup: [],
    payment: [],
    closure: [],
    new: [],
  };
  assigned.forEach((group, key) => {
    const claim = sorted.find(
      (candidate) => claimKey(candidate, getClaimNo) === key,
    );
    if (claim && grouped[group]) grouped[group].push(claimItem(claim));
  });
  const handlerItems = [];
  ["urgent", "decision", "followup", "payment", "closure", "new"].forEach(
    (group) => {
      grouped[group].forEach((item) => handlerItems.push({ ...item, group }));
    },
  );
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
    urgent: capItems(
      displayedByGroup.urgent || [],
      caps.urgent,
      grouped.urgent.length,
    ),
    decision: capItems(
      displayedByGroup.decision || [],
      caps.secondary,
      grouped.decision.length,
    ),
    followup: capItems(
      displayedByGroup.followup || [],
      caps.secondary,
      grouped.followup.length,
    ),
    payment: capItems(
      displayedByGroup.payment || [],
      caps.secondary,
      grouped.payment.length,
    ),
    closure: capItems(
      displayedByGroup.closure || [],
      caps.secondary,
      grouped.closure.length,
    ),
    new: capItems(
      displayedByGroup.new || [],
      caps.secondary,
      grouped.new.length,
    ),
  };

  // --- Manager-facing metrics, ranked attention and comparison (remediation) ---
  const previousActiveSource = comparisonAvailable
    ? options.includeTerminalClaims
      ? previousClaims.slice()
      : previousClaims.filter(
          (claim) =>
            !isTerminal(claim) || (options.includeSettled && isSettled(claim)),
        )
    : [];
  const previousIdentity = resolveIdentities(previousActiveSource);
  const countedPrevious = previousIdentity.counted;
  // Claim numbers that were themselves collision-ambiguous in the previous
  // period: their prior state cannot be trusted, so a matching current claim
  // must not be reported as newly high-priority (or newly present) against them.
  const previousCollisionKeys = new Set(
    previousIdentity.collisions.map((c) =>
      String(c.claimNumber).trim().toUpperCase(),
    ),
  );

  const countedCritical = countedActive.filter(isCritical);
  const countedStale = countedActive.filter(
    (claim) => isStale(claim) && !isCritical(claim),
  );
  const countedExposure = countedActive.reduce(
    (sum, claim) => sum + number(getOutstanding(claim)),
    0,
  );
  // Cross-period comparison uses only *comparable* claim identities: unambiguous
  // singletons and field-equivalent duplicates, keyed by normalized claim number
  // (rankableActive is exactly that set). Conflicting claim-number collisions are
  // NOT identity-comparable across periods — source-row position is not stable —
  // so they are excluded from confirmed-new counts and reported as ambiguous.
  // Presence checks against the previous period use ALL previous claim numbers
  // (including any that were collisions there) so a number seen last period is
  // never mis-counted as new.
  const normClaimNo = (claim) => String(getClaimNo(claim)).trim().toUpperCase();
  const previousAllKeys = new Set(countedPrevious.map(normClaimNo));
  const previousAllCriticalKeys = new Set(
    countedPrevious.filter(isCritical).map(normClaimNo),
  );
  const newSincePrevious = rankableActive.filter(
    (claim) =>
      !previousCollisionKeys.has(normClaimNo(claim)) &&
      !previousAllKeys.has(normClaimNo(claim)),
  ).length;
  const newCriticalSincePrevious = rankableActive.filter(
    (claim) =>
      isCritical(claim) &&
      !previousCollisionKeys.has(normClaimNo(claim)) &&
      !previousAllCriticalKeys.has(normClaimNo(claim)),
  ).length;

  const managerCandidates = rankableActive.filter(
    (claim) =>
      isCritical(claim) ||
      (isStale(claim) && !isCritical(claim)) ||
      isZeroEstimate(claim) ||
      isMandate(claim) ||
      isClosure(claim),
  );
  const managerAttentionItems = managerCandidates
    .slice()
    .sort(compareByMateriality)
    .slice(0, caps.managerAttention)
    .map((claim) => ({
      ...claimItem(claim),
      conditions: {
        critical: isCritical(claim),
        stale: isStale(claim) && !isCritical(claim),
        zeroEstimate: isZeroEstimate(claim),
        mandate: isMandate(claim),
        closure: isClosure(claim),
      },
    }));
  const managerAttention = {
    items: managerAttentionItems,
    total: managerCandidates.length,
    hasMore: managerCandidates.length > managerAttentionItems.length,
  };

  // Comparison ambiguity = current collisions PLUS any previous-period collision
  // whose claim number matches a current comparable identity. The latter has no
  // current collision row, but its prior state is untrustworthy, so the comparison
  // for that number is still ambiguous (and its confirmed-new counts were suppressed
  // via previousCollisionKeys above). Surfacing it keeps the message honest.
  const currentComparableKeys = new Set(rankableActive.map(normClaimNo));
  const previousAmbiguousAffecting = previousIdentity.collisions
    .map((c) => c.claimNumber)
    .filter((no) => currentComparableKeys.has(String(no).trim().toUpperCase()));
  const comparisonAmbiguousClaimNumbers = [
    ...new Set([
      ...activeIdentity.collisions.map((c) => c.claimNumber),
      ...previousAmbiguousAffecting,
    ]),
  ];

  const dataQuality = {
    sourceRows: active.length,
    countedClaims: countedActive.length,
    // Only field-equivalent duplicates are suppressed from totals.
    duplicateRows: activeIdentity.fieldEquivalentRowsSuppressed,
    duplicateClaimNumbers: activeIdentity.fieldEquivalentClaimNumbers,
    // Conflicting claim-number collisions are retained in totals/exposure and
    // surfaced for reconciliation (full row detail kept here, not in the body).
    collisions: activeIdentity.collisions,
    collisionClaimNumbers: activeIdentity.collisions.map((c) => c.claimNumber),
    unresolvedCollisionRows: activeIdentity.collisions.reduce(
      (sum, c) => sum + c.rowCount,
      0,
    ),
    // Claim numbers whose newness cannot be confirmed across periods — current
    // collisions plus previous-period collisions matching a current comparable
    // identity (all excluded from the confirmed-new metrics above).
    comparisonAmbiguousClaimNumbers,
    // Row count reflects current-extract collision rows only (previous-only
    // ambiguities have no rows in this extract).
    comparisonAmbiguousRows: activeIdentity.collisions.reduce(
      (sum, c) => sum + c.rowCount,
      0,
    ),
  };

  return {
    generatedDate: options.generatedDate || null,
    extractDate: options.extractDate || null,
    freshness: options.freshness || null,
    comparisonAvailable,
    comparisonLabel: comparisonAvailable
      ? "Compared with previous extract"
      : "Comparison unavailable",
    active,
    metrics: {
      // Manager-facing counts collapse only field-equivalent duplicates; rows in
      // an unresolved claim-number collision are retained so their financial
      // impact stays in the totals and exposure until Cardinal reconciles them.
      active: countedActive.length,
      critical: countedCritical.length,
      stale: countedStale.length,
      exposure: countedExposure,
      zeroEstimate: countedActive.filter(isZeroEstimate).length,
      mandate: countedActive.filter(isMandate).length,
      closure: countedActive.filter(isClosure).length,
      noMovement: countedActive.filter(isNoMovement).length,
      previousActive: comparisonAvailable ? countedPrevious.length : null,
      activeDelta: comparisonAvailable
        ? countedActive.length - countedPrevious.length
        : null,
      newSincePrevious: comparisonAvailable ? newSincePrevious : null,
      newCriticalSincePrevious: comparisonAvailable
        ? newCriticalSincePrevious
        : null,
      newClaims: comparisonAvailable ? active.filter(isNew).length : null,
      newCritical: comparisonAvailable
        ? criticalClaims.filter(
            (claim) => !previousCritical.has(claimKey(claim, getClaimNo)),
          ).length
        : null,
    },
    managerAttention,
    dataQuality,
    attention,
    team,
    topRisks,
    handlers,
    handler: {
      active,
      critical: criticalClaims,
      stale: staleClaims,
      onTrack: Math.max(
        0,
        active.length - criticalClaims.length - staleClaims.length,
      ),
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
