/**
 * Per-handler scorecards for the weekly / monthly claims report.
 *
 * Mirrors the management "Claims Performance" cards:
 *   - Total Gross Registered: the current open book held by the handler at the
 *     closing boundary. Settled / terminal claims are excluded. (The label is
 *     kept from the manual report for familiarity.)
 *   - New Allocated Claims: open claims whose `Claim Registered` date falls
 *     inside the report period, attributed to the handler shown on the accepted
 *     closing Cardinal extract. Scout does not know the original allocation
 *     event, so a claim registered under one handler and moved to another
 *     before the closing extract counts under the latter.
 *   - Over 60 Days: open claims registered MORE than 60 calendar days before
 *     the closing extract date. Cardinal's `Age` is the pure calendar-date
 *     difference (verified on a real workbook), so this equals Cardinal
 *     Age > 60 for any claim whose Age is not frozen at a Settled Date. The
 *     Cardinal Age is compared as a QA check and disagreements are flagged.
 *
 * Who is a handler, the claims manager, the claims administrator or a former
 * handler is CONFIGURATION (the `reporting_roster` setting), never names in
 * code. Without a roster the cards are derived from SCOUT user roles and any
 * unmatched handler name is surfaced, not silently pooled.
 */
import {
  identityKey,
  identityTokens,
  resolveActiveScoutUsers,
  resolveScoutHandler,
} from "./roles.mjs";

export const HANDLER_SCORECARD_VERSION = "handler-scorecards-v1";
// "Over 60" means strictly more than 60 days; "91+" is the existing 91-and-over band.
export const OVER_60_THRESHOLD_DAYS = 60;
export const OVER_91_THRESHOLD_DAYS = 91;
export const ROSTER_ROLES = Object.freeze([
  "handler",
  "claims_manager",
  "claims_administrator",
  "former_handler",
]);

// Wording is decided once here so the PDF and the Reports page print identical text.
export const SCORECARD_ROLE_LABELS = Object.freeze({
  handler: "Claims handler",
  claims_manager: "Claims manager",
  management: "Management",
  former_handler: "Former handler",
  claims_administrator: "Claims administrator",
  unrecognised: "Unrecognised handler",
  unassigned: "No handler allocated",
});

const ROLE_RANK = {
  handler: 0,
  claims_manager: 1,
  management: 2,
  former_handler: 3,
  claims_administrator: 4,
  unrecognised: 5,
  unassigned: 6,
};

export const SCORECARD_DEFINITIONS = Object.freeze({
  gross_registered:
    "The current open book held by the handler at the closing extract: open claims only. Settled and other terminal claims (for example repudiated, rejected or duplicated) are excluded. The label is kept from the manual report.",
  new_allocated:
    "Open claims whose Claim Registered date falls inside the report period, attributed to the handler shown on the accepted closing Cardinal extract. Scout does not hold the original allocation event, so a claim moved between handlers during the period counts under the handler on the closing extract.",
  over_60:
    "Open claims registered more than 60 calendar days before the closing extract (Cardinal Age greater than 60). Settled and other terminal claims are excluded. Scout derives this from the registration date and compares it with Cardinal's own Age as a QA check.",
});

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

/**
 * Validate the stored roster. Invalid members are dropped and reported, so a
 * typo in settings can never silently change attribution.
 */
export function normaliseReportingRoster(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.members)) {
    return { configured: false, version: null, members: [], errors: [] };
  }
  const errors = [];
  const seen = new Set();
  const members = [];
  for (const member of raw.members) {
    const id = text(member?.id);
    const label = text(member?.label);
    const role = text(member?.role);
    const match = (Array.isArray(member?.match) ? member.match : [])
      .map(text)
      .filter(Boolean);
    if (!id || !label || !ROSTER_ROLES.includes(role) || match.length === 0) {
      errors.push(`invalid_roster_member:${id || label || "unnamed"}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`duplicate_roster_member:${id}`);
      continue;
    }
    seen.add(id);
    members.push({ id, label, role, match });
  }
  return {
    configured: members.length > 0,
    version: text(raw.version),
    members,
    errors,
  };
}

function rosterMatches(member, candidates) {
  const memberKeys = member.match.map(identityKey);
  const memberTokens = member.match.map(identityTokens);
  return candidates.some((candidate) => {
    const key = identityKey(candidate);
    const tokens = identityTokens(candidate);
    return memberKeys.includes(key) || memberTokens.includes(tokens);
  });
}

function classifyClaim(claim, context) {
  const source = text(claim.handlerSource);
  const email = text(claim.handlerEmail);
  const byId =
    claim.resolvedScoutUserId !== null && claim.resolvedScoutUserId !== undefined
      ? context.usersById.get(String(claim.resolvedScoutUserId))
      : null;
  // Snapshots stored before a user/alias existed carry no resolved user id, so
  // resolve again from the preserved source text at report time.
  const reResolved =
    !byId && (source || email)
      ? resolveScoutHandler(context.activeUsers, source || email)
      : null;
  const user = byId || (reResolved?.status === "resolved" ? reResolved.user : null);
  const candidates = [source, email, user?.displayName, user?.email].filter(
    Boolean,
  );

  const matched = context.roster.members.filter((member) =>
    rosterMatches(member, candidates),
  );
  if (matched.length === 1) {
    const [member] = matched;
    return {
      key: `roster:${member.id}`,
      role: member.role,
      label: member.label,
      rosterMemberId: member.id,
      handlerEmail: user?.email ?? email,
      aliases: [member.label, ...member.match],
    };
  }
  if (matched.length > 1) {
    return {
      key: `ambiguous:${identityKey(source || email)}`,
      role: "unrecognised",
      label: source || email,
      reason: "ambiguous_roster_match",
    };
  }
  if (user) {
    return {
      key: `user:${user.key.value}`,
      role: user.role === "handler" ? "handler" : "management",
      label: user.displayName || user.email,
      handlerEmail: user.email,
      aliases: [user.displayName, user.email, source].filter(Boolean),
    };
  }
  if (source || email) {
    return {
      key: `raw:${identityKey(source || email)}`,
      role: "unrecognised",
      label: source || email,
      reason: "handler_not_recognised",
      aliases: [source || email],
    };
  }
  return { key: "unassigned", role: "unassigned", label: "Unassigned" };
}

// Cardinal's raw Age is preserved in snapshot source evidence from extracts
// uploaded after this check was introduced; older snapshots cannot be compared.
function cardinalAgeOf(claim) {
  const evidence = claim?.sourceEvidence;
  const raw = evidence?.cardinalAge ?? evidence?.age;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function emptyCard(identity) {
  return {
    key: identity.key,
    label: identity.label,
    role: identity.role,
    roster_member_id: identity.rosterMemberId ?? null,
    // Exact Cardinal / roster strings that belong to this card. Used to group
    // frozen queries and actions by handler without any fuzzy first-name match.
    aliases: [...new Set((identity.aliases ?? [identity.label]).filter(Boolean))],
    handler_email: identity.handlerEmail ?? null,
    gross_registered: 0,
    new_allocated: 0,
    over_60: 0,
    over_91: 0,
    oldest_open_age_days: null,
    cardinal_age_compared: 0,
    cardinal_age_disagreements: 0,
    over_60_by_cardinal_age: 0,
    cardinal_age_disagreement_claim_ids: [],
    open_claim_ids: [],
    new_allocated_claim_ids: [],
    over_60_claim_ids: [],
    flags: [],
    previous: null,
    _reason: identity.reason ?? null,
  };
}

function cardFlags(card) {
  const flags = [];
  const held = card.gross_registered;
  const claimWord = (count) => (count === 1 ? "claim is" : "claims are");
  if (card.role === "claims_administrator" && (held > 0 || card.new_allocated > 0)) {
    flags.push({
      code: "registration_account_holds_claims",
      severity: "critical",
      message:
        held > 0
          ? `${held} open ${claimWord(held)} still allocated to ${card.label} (claims administrator). The correct handler must be allocated.`
          : `${card.new_allocated} newly registered ${claimWord(card.new_allocated)} allocated to ${card.label} (claims administrator). The correct handler must be allocated.`,
    });
  }
  if (card.role === "unrecognised") {
    flags.push({
      code: card._reason || "handler_not_recognised",
      severity: "critical",
      message: `"${card.label}" is not a recognised SCOUT handler. Allocate the correct handler, or add them to the reporting roster.`,
    });
  }
  if (card.role === "unassigned" && (held > 0 || card.new_allocated > 0)) {
    flags.push({
      code: "claims_unassigned",
      severity: "critical",
      message: `${held} open ${claimWord(held)} have no handler allocated.`,
    });
  }
  if (card.role === "former_handler" && held > 0) {
    flags.push({
      code: "former_handler_open_claims",
      severity: "warning",
      message: `${held} open ${claimWord(held)} sit with ${card.label}, who no longer handles claims (typically re-opened for payment). Confirm ownership.`,
    });
  }
  // Cardinal's own Age is kept for reference only (card fields and the drillable
  // scorecard_cardinal_age_differs metric). Management decided Over 60 and the
  // ageing bands use the registration date, so a difference is not a warning.
  return flags;
}

export function describeCardinalAgeCheck(check) {
  if (check.status === "agrees")
    return `Cardinal Age (reference only): Cardinal's own Age agrees with the registration-date age on all ${check.compared} open claims compared.`;
  if (check.status === "disagreements")
    return `Cardinal Age (reference only): Cardinal stops its Age at the Settled Date, so it differs from the registration-date age on ${check.disagreements} of ${check.compared} open claims compared. Over 60 Days and ageing use the registration date; Cardinal Age would give ${check.over_60_by_cardinal_age} over 60.`;
  return "Cardinal Age (reference only): not available for this report, because the underlying extracts were stored before Cardinal's own Age was preserved.";
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function holderAction(card) {
  const flags = card.flags.filter((flag) => flag.code !== "cardinal_age_differs");
  if (flags.some((flag) => flag.severity === "critical"))
    return { action: "allocate", action_label: "Allocate correct handler" };
  if (flags.some((flag) => flag.severity === "warning"))
    return { action: "confirm", action_label: "Confirm ownership" };
  return { action: "none", action_label: "No action" };
}

/**
 * The two summary banners shown above the handler cards. Detailed per-holder
 * wording lives in each card's flags.
 */
export function summariseScorecardAlerts(cards) {
  const hasFlag = (card, severity) =>
    card.flags.some(
      (flag) => flag.severity === severity && flag.code !== "cardinal_age_differs",
    );
  const held = (card) => card.gross_registered || card.new_allocated;
  const list = (items) => items.map((card) => `${card.label} (${held(card)})`).join(", ");
  const critical = cards.filter((card) => hasFlag(card, "critical"));
  const confirm = cards.filter((card) => hasFlag(card, "warning"));
  const criticalClaims = critical.reduce((total, card) => total + held(card), 0);
  const confirmParts = [
    ...(confirm.length ? [`ownership to be confirmed for ${list(confirm)}`] : []),
  ];
  return {
    critical: critical.length
      ? {
          title: "Action required: the correct handler must be allocated",
          text: `${plural(criticalClaims, "claim is", "claims are")} held by someone who should not own them: ${list(critical)}. Details are under Recommendations & Action Plan.`,
          claim_count: criticalClaims,
        }
      : null,
    confirm: confirmParts.length
      ? { title: "For confirmation", text: `${confirmParts.join("; ")}.` }
      : null,
  };
}

function sortCards(cards, roster) {
  const order = new Map(roster.members.map((member, index) => [member.id, index]));
  return [...cards].sort((left, right) => {
    const rank = ROLE_RANK[left.role] - ROLE_RANK[right.role];
    if (rank !== 0) return rank;
    const leftIndex = order.get(left.roster_member_id);
    const rightIndex = order.get(right.roster_member_id);
    if (leftIndex !== undefined && rightIndex !== undefined)
      return leftIndex - rightIndex;
    return String(left.label).localeCompare(String(right.label));
  });
}

function previousFor(card, previousValue) {
  const prior = Array.isArray(previousValue?.cards)
    ? previousValue.cards.find((item) => item.key === card.key)
    : null;
  if (!prior) return null;
  return {
    gross_registered: prior.gross_registered,
    new_allocated: prior.new_allocated,
    over_60: prior.over_60,
  };
}

/**
 * @param closingRows   every claim (parent) in the closing snapshot, any status
 * @param period        { startLocalDate, endLocalDateExclusive }
 */
export function buildHandlerScorecards({
  closingRows = [],
  period,
  activeUsers = [],
  roster: rawRoster = null,
  previousValue = null,
} = {}) {
  const roster = normaliseReportingRoster(rawRoster);
  const users = resolveActiveScoutUsers(activeUsers);
  const context = {
    roster,
    activeUsers,
    usersById: new Map(
      users
        .filter((user) => user.id !== null && user.id !== undefined)
        .map((user) => [String(user.id), user]),
    ),
  };

  const cards = new Map();
  for (const member of roster.members) {
    if (member.role !== "handler") continue;
    const card = emptyCard({
      key: `roster:${member.id}`,
      role: "handler",
      label: member.label,
      rosterMemberId: member.id,
      aliases: [member.label, ...member.match],
    });
    cards.set(card.key, card);
  }

  let ageUnknown = 0;
  let cardinalAgeCompared = 0;
  let cardinalAgeUnavailable = 0;
  for (const claim of closingRows) {
    const identity = classifyClaim(claim, context);
    if (!cards.has(identity.key)) cards.set(identity.key, emptyCard(identity));
    const card = cards.get(identity.key);
    if (!card.handler_email && identity.handlerEmail)
      card.handler_email = identity.handlerEmail;

    // Settled / terminal claims are outside every headline figure.
    if (!claim.open || claim.terminal) continue;

    const registered = claim.registeredDate;
    if (
      registered &&
      period &&
      registered >= period.startLocalDate &&
      registered < period.endLocalDateExclusive
    ) {
      card.new_allocated += 1;
      card.new_allocated_claim_ids.push(claim.id);
    }

    card.gross_registered += 1;
    card.open_claim_ids.push(claim.id);
    const age = Number(claim.calendarAge);
    if (claim.calendarAge === null || claim.calendarAge === undefined || !Number.isFinite(age)) {
      ageUnknown += 1;
      continue;
    }
    if (card.oldest_open_age_days === null || age > card.oldest_open_age_days)
      card.oldest_open_age_days = age;
    if (age > OVER_60_THRESHOLD_DAYS) {
      card.over_60 += 1;
      card.over_60_claim_ids.push(claim.id);
    }
    if (age >= OVER_91_THRESHOLD_DAYS) card.over_91 += 1;

    // QA: Cardinal's own Age against the registration-derived age.
    const cardinalAge = cardinalAgeOf(claim);
    if (cardinalAge === null) {
      cardinalAgeUnavailable += 1;
    } else {
      cardinalAgeCompared += 1;
      card.cardinal_age_compared += 1;
      if (cardinalAge > OVER_60_THRESHOLD_DAYS) card.over_60_by_cardinal_age += 1;
      if (cardinalAge !== age) {
        card.cardinal_age_disagreements += 1;
        card.cardinal_age_disagreement_claim_ids.push(claim.id);
      }
    }
  }

  // Rostered handlers always get a card (a zero is information). Every other
  // holder only appears when they actually hold or were allocated claims.
  const visible = [...cards.values()].filter(
    (card) =>
      card.role === "handler" ||
      card.gross_registered > 0 ||
      card.new_allocated > 0,
  );
  const ordered = sortCards(visible, roster);
  // One claim belongs to exactly one card per figure, which is what lets each
  // figure be published as its own drillable team metric.
  const populations = {
    gross_registered: {},
    new_allocated: {},
    over_60: {},
    cardinal_age_differs: {},
  };
  for (const card of ordered) {
    populations.gross_registered[card.key] = card.open_claim_ids;
    populations.new_allocated[card.key] = card.new_allocated_claim_ids;
    populations.over_60[card.key] = card.over_60_claim_ids;
    populations.cardinal_age_differs[card.key] =
      card.cardinal_age_disagreement_claim_ids;
    card.flags = cardFlags(card);
    card.previous = previousFor(card, previousValue);
    card.role_label = SCORECARD_ROLE_LABELS[card.role] || "Handler";
    Object.assign(card, holderAction(card));
    delete card._reason;
    delete card.open_claim_ids;
    delete card.new_allocated_claim_ids;
    delete card.over_60_claim_ids;
    delete card.cardinal_age_disagreement_claim_ids;
  }

  const sum = (field) => ordered.reduce((total, card) => total + card[field], 0);
  const needsAllocation = ordered.filter((card) =>
    card.flags.some((flag) => flag.severity === "critical"),
  );
  const warnings = [];
  if (!roster.configured) warnings.push("reporting_roster_not_configured");
  if (roster.errors.length) warnings.push("reporting_roster_invalid_members");
  if (needsAllocation.length) warnings.push("claims_require_handler_allocation");
  if (ageUnknown) warnings.push("handler_scorecard_age_unavailable");
  const disagreements = sum("cardinal_age_disagreements");

  const previousTotals = previousValue?.totals ?? null;
  return {
    value: {
      version: HANDLER_SCORECARD_VERSION,
      definitions: SCORECARD_DEFINITIONS,
      roster: {
        configured: roster.configured,
        version: roster.version,
        member_count: roster.members.length,
        errors: roster.errors,
      },
      cards: ordered,
      alerts: summariseScorecardAlerts(ordered),
      totals: {
        gross_registered: sum("gross_registered"),
        new_allocated: sum("new_allocated"),
        over_60: sum("over_60"),
        over_91: sum("over_91"),
        previous: previousTotals
          ? {
              gross_registered: previousTotals.gross_registered,
              new_allocated: previousTotals.new_allocated,
              over_60: previousTotals.over_60,
            }
          : null,
      },
      allocation_required: {
        claim_count: needsAllocation.reduce(
          (total, card) => total + card.gross_registered,
          0,
        ),
        card_keys: needsAllocation.map((card) => card.key),
      },
      claims_without_age: ageUnknown,
      cardinal_age_check: (() => {
        const check = {
          compared: cardinalAgeCompared,
          unavailable: cardinalAgeUnavailable,
          disagreements,
          over_60_by_cardinal_age: sum("over_60_by_cardinal_age"),
          // Past snapshots predate preservation of Cardinal's Age; say so rather than imply agreement.
          status:
            cardinalAgeCompared === 0
              ? "unavailable"
              : disagreements
                ? "disagreements"
                : "agrees",
        };
        return { ...check, summary: describeCardinalAgeCheck(check) };
      })(),
    },
    warnings,
    populations,
  };
}
