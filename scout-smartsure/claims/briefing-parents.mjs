/*
 * MS2 parent-identity projection for manager briefings.
 *
 * This module is the single adapter between the raw briefing snapshot rows and
 * the shared briefing presentation model (briefing-model.mjs). It exists so that
 * every downstream metric, ranking, comparison and financial figure operates on
 * LOGICAL PARENT CLAIMS, never on raw snapshot rows.
 *
 * It deliberately does not invent a second identity model: logical identity,
 * consensus, conflict detection and lifecycle roll-up are imported from the
 * accepted reporting domain (reporting-domain/claim-parent.mjs). The briefing
 * layer only supplies its own field accessors and predicates through `helpers`.
 *
 * Rules (all inherited from the accepted MS2 parent model):
 *  - Parent identity is source_system + normalized source claim number only.
 *    Row count/cardinality never defines identity.
 *  - A single-row parent is passed through unchanged (single-row briefings are
 *    byte-for-byte what they were before MS2).
 *  - A multi-row parent counts once. Its lifecycle is rolled up conservatively
 *    (open if any usable child is open; terminal only if every usable child is
 *    terminal; missing/unmapped evidence never terminalizes).
 *  - Financial fields for a multi-row parent are left null: aggregation
 *    semantics are unproven, so briefings fail closed rather than sum child
 *    financials merely to obtain a number.
 *  - Differing child fields are NOT a collision. Only disagreement on
 *    claim-identifying invariants marks the parent ambiguous, and an ambiguous
 *    (or wholly unresolved) parent is gated out of new/critical comparison
 *    movement rather than manufacturing it.
 */

import {
  consensusValue,
  detectParentIdentityConflict,
  parentIdentityKey,
  rollUpParentState,
} from "../../reporting-domain/claim-parent.mjs";

const UNTRUSTED_CONSENSUS = new Set(["disagree", "all_missing"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// A consensus scalar is only trusted when the rows agree (or agree-with-missing).
// Disagreement/all-missing never collapses to an arbitrary row value.
function consensusScalar(rows, field) {
  const { status, value } = consensusValue(rows, field);
  return UNTRUSTED_CONSENSUS.has(status) ? null : value;
}

/**
 * Group input claims into logical parents, preserving first-seen order so the
 * projected list is deterministic and matches the pre-MS2 order for the common
 * single-row case. Claims with no derivable parent key are never dropped: each
 * becomes its own singleton under a synthetic key (they are rejected upstream in
 * production, but the briefing layer must never silently lose a claim).
 */
export function groupClaimsByParent(claims) {
  const groups = new Map();
  const order = [];
  let synthetic = 0;
  for (const claim of asArray(claims)) {
    const key = parentIdentityKey(claim) || `__unkeyed:${(synthetic += 1)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(claim);
  }
  return order.map((key) => ({ key, rows: groups.get(key) }));
}

function defaultHelpers(helpers) {
  return {
    getAge: helpers.getAge || (() => 0),
    getStatus: helpers.getStatus || ((claim) => claim?.status ?? ""),
    getHandler: helpers.getHandler || ((claim) => claim?.handler ?? ""),
    getInsured: helpers.getInsured || ((claim) => claim?.insured ?? ""),
    getDaysSinceMovement:
      helpers.getDaysSinceMovement ||
      ((claim) =>
        claim?.daysSinceMovement ?? claim?.days_since_movement ?? null),
    isTerminalRow: helpers.isTerminalRow || (() => false),
    // Higher rank == more operationally severe. Drives which usable child is the
    // presentation representative (and therefore the parent-safe reason/action).
    rankRow: helpers.rankRow || (() => 0),
    hasDuplicateFlag: helpers.hasDuplicateFlag || (() => false),
    // Per-child severity predicates, used to conservatively aggregate parent
    // criticality/staleness from child evidence (not inherited from one child).
    isCriticalRow: helpers.isCriticalRow || (() => false),
    isStaleRow: helpers.isStaleRow || (() => false),
  };
}

// Handler is a section-varying field, so a multi-row parent's handler is resolved
// by consensus, not taken from an arbitrary representative child:
//  - unanimous populated handler        -> preserve it;
//  - one populated value plus missing    -> preserve that consensus value;
//  - multiple distinct populated handlers-> a deterministic neutral handler
//    ("Multiple handlers"), flagged ambiguous so team totals never attribute the
//    parent to one arbitrary child handler.
function resolveParentHandler(rows) {
  const effective = rows.map((row) =>
    String(row?.handler_source || row?.handler_email || "").trim(),
  );
  const populated = effective.filter(Boolean);
  const distinct = [...new Set(populated.map((value) => value.toLowerCase()))];
  if (distinct.length > 1)
    return { handler: "Multiple handlers", email: "", ambiguous: true };
  if (distinct.length === 0)
    return { handler: "Unassigned", email: "", ambiguous: false };
  const handler = populated.find(
    (value) => value.toLowerCase() === distinct[0],
  );
  const emails = rows
    .map((row) => String(row?.handler_email || "").trim())
    .filter(Boolean);
  const distinctEmails = [
    ...new Set(emails.map((value) => value.toLowerCase())),
  ];
  const email = distinctEmails.length === 1 ? emails[0] : "";
  return { handler, email, ambiguous: false };
}

function decorateSingle(claim, key) {
  // Single-row parents are unchanged; only non-invasive metadata is attached so
  // downstream code can treat every projected claim uniformly. Crucially no
  // lifecycle override is set, so single-row terminal/new semantics stay exactly
  // as they were before MS2.
  return {
    ...claim,
    __parent: {
      key,
      multiRow: false,
      financialsAvailable: true,
      gateComparison: false,
      identityQuality: "valid",
      rowCount: 1,
    },
  };
}

function pickRepresentative(rows, { getAge, rankRow }) {
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        rankRow(right.row) - rankRow(left.row) ||
        getAge(right.row) - getAge(left.row) ||
        left.index - right.index,
    )[0].row;
}

function projectMultiRow(key, rows, helpers) {
  const {
    getAge,
    getStatus,
    getInsured,
    getDaysSinceMovement,
    isTerminalRow,
    hasDuplicateFlag,
    isCriticalRow,
    isStaleRow,
  } = helpers;
  const conflict = detectParentIdentityConflict(rows);
  const state = rollUpParentState(rows);
  const open = state.lifecycle_state === "open";

  // Presentation is drawn from a usable child of the SAME lifecycle as the
  // parent: an open parent speaks through its most severe open child, a terminal
  // parent through a terminal child. This keeps next-action/reason parent-safe.
  const lifecyclePool = rows.filter((row) =>
    open ? !isTerminalRow(row) : isTerminalRow(row),
  );
  const severityRows = lifecyclePool.length ? lifecyclePool : rows;
  const representative = pickRepresentative(severityRows, helpers);

  // Parent severity is conservatively aggregated from child evidence: the parent
  // is critical if ANY usable child breaches authoritative critical severity, and
  // stale (when not critical) if ANY usable child is stale. This never depends on
  // source row order and is never arbitrarily inherited from a single child.
  const criticalEvidence = severityRows.some((row) => isCriticalRow(row));
  const staleEvidence =
    !criticalEvidence && severityRows.some((row) => isStaleRow(row));

  const claimNumber =
    rows[0]?.source_claim_number ??
    rows[0]?.claim_no ??
    rows[0]?.claimNo ??
    (key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);

  const handlerResolution = resolveParentHandler(rows);
  const insured = consensusScalar(rows, "insured");
  const movement = consensusValue(rows, "movement_date");
  const daysSinceMovement = UNTRUSTED_CONSENSUS.has(movement.status)
    ? null
    : getDaysSinceMovement(representative);

  // registered_date is a parent invariant, so ages agree; max is a conservative
  // (attention-favouring) tie-break when a row is missing an age.
  const age = rows.reduce((max, row) => Math.max(max, getAge(row)), 0);

  // Cardinality is never a collision. A parent is flagged possibly-duplicate
  // ONLY on a real identity-invariant conflict, or an explicit per-row ambiguity
  // flag — never merely because it has more than one section row.
  const duplicate =
    conflict.identity_quality === "conflict" || rows.some(hasDuplicateFlag);

  const qualityFlags = [
    ...new Set([
      ...state.flags,
      "multi_row_claim",
      ...(conflict.identity_quality === "conflict"
        ? ["parent_identity_conflict"]
        : []),
      ...(handlerResolution.ambiguous ? ["parent_handler_ambiguous"] : []),
    ]),
  ];

  return {
    ...representative,
    id: key,
    claimNo: claimNumber,
    claim_no: claimNumber,
    claim_number: claimNumber,
    status: getStatus(representative),
    handler: handlerResolution.handler,
    handler_name: handlerResolution.handler,
    handler_email: handlerResolution.email,
    insured: insured || getInsured(representative),
    insured_name: insured || getInsured(representative),
    workingAge: age,
    working_age: age,
    age_days: age,
    // Fail closed: multi-row financial aggregation is unproven. Every alias the
    // briefing accessors read is nulled so no figure is fabricated from rows.
    outstanding: null,
    outstanding_amount: null,
    nett_claim: null,
    estimate: null,
    cardinal_estimate: null,
    original_estimate: null,
    own_damage_original_estimate: null,
    paid: null,
    paid_amount: null,
    mandate: null,
    daysSinceMovement,
    days_since_movement: daysSinceMovement,
    possibleDuplicate: duplicate,
    possible_duplicate: duplicate,
    __parent: {
      key,
      multiRow: true,
      lifecycleState: state.lifecycle_state,
      stateResolution: state.state_resolution,
      identityQuality: conflict.identity_quality,
      financialsAvailable: false,
      handlerAmbiguous: handlerResolution.ambiguous,
      // Conservatively aggregated severity from child evidence (order-independent).
      criticalEvidence,
      staleEvidence,
      // Ambiguous or wholly unresolved parents must not drive new/critical
      // comparison movement.
      gateComparison:
        conflict.identity_quality === "conflict" ||
        state.state_resolution === "unresolved",
      qualityFlags,
      rowCount: rows.length,
    },
  };
}

/**
 * Project an array of briefing claims into logical-parent claims. Returns one
 * entry per logical parent, in first-seen order. Single-row parents are returned
 * unchanged (plus metadata); multi-row parents are collapsed parent-safely.
 */
export function projectBriefingParents(claims, helpers = {}) {
  const resolved = defaultHelpers(helpers);
  return groupClaimsByParent(claims).map(({ key, rows }) =>
    rows.length === 1
      ? decorateSingle(rows[0], key)
      : projectMultiRow(key, rows, resolved),
  );
}
