/*
 * Pure parent-claim domain primitives (MS2).
 *
 * One source claim number represents ONE logical parent claim. A parent may
 * have 1..N immutable source rows in a given extract, and N may change between
 * extracts. Parent identity is therefore `source_system + normalized claim
 * number` only - never the row count, row index, or a child UUID.
 *
 * This module is deliberately pure: no Supabase, Worker bindings, APIs,
 * persistence, UI, or manifest/report-period orchestration. It consumes the
 * shared status primitives from claims-rules.mjs rather than reimplementing
 * status semantics. Reporting/history orchestration lives in their own modules
 * and consume these primitives.
 */

import { getStatusEvaluation } from "./claims-rules.mjs";

export const DEFAULT_SOURCE_SYSTEM = "cardinal_claims";

// Parent-identifying invariant fields. Two rows that share a claim number are
// only an identity conflict when they disagree on fields that identify the
// claim itself. Section/item-varying fields (status, handler, peril,
// description, outstanding, estimate, paid, mandate, sum insured) are
// deliberately excluded - they may legitimately differ per section.
export const PARENT_INVARIANT_FIELDS = Object.freeze([
  "insured",
  "registered_date",
  "dol_date",
  "insurer",
]);

// Fields projected as parent-level consensus values. A scalar is only trusted
// when the rows agree (or agree with some missing); disagreement never
// collapses to an arbitrary row.
export const CONSENSUS_FIELDS = Object.freeze([
  "insured",
  "registered_date",
  "dol_date",
  "insurer",
  "status_normalized",
  "handler_email",
  "movement_date",
]);

const DATE_FIELDS = new Set([
  "registered_date",
  "dol_date",
  "movement_date",
  "repudiation_date",
]);
const NUMERIC_FIELDS = new Set([
  "working_age",
  "calendar_age",
  "outstanding",
  "estimate",
  "paid",
  "mandate",
  "sum_insured",
  "repudiate_amount",
  "nett_claim",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null)
      return source[key];
  }
  return null;
}

function normalizedClaimNumber(value) {
  return hasValue(value) ? String(value).trim() : "";
}

function normalizedSourceSystem(value) {
  const system = String(value ?? "").trim();
  return system || DEFAULT_SOURCE_SYSTEM;
}

/**
 * Normalize a field value for equality/consensus comparison. Dates already
 * arrive as normalized YYYY-MM-DD strings; other strings are trimmed,
 * whitespace-collapsed and lowercased. No fuzzy matching.
 */
function normalizeFieldValue(value, field) {
  if (!hasValue(value)) return "";
  if (DATE_FIELDS.has(field)) return String(value).trim();
  if (NUMERIC_FIELDS.has(field)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      // Spreadsheet exports can leave a tiny floating-point residue where the
      // business value is zero. Treat that residue as zero for consensus, but
      // retain all meaningful non-zero differences as disagreements.
      return String(Math.abs(numeric) < 1e-9 ? 0 : numeric);
    }
  }
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The stable parent identity key: `source_system + ":" + normalized claim
 * number`. Returns null when no claim number is present - a missing claim
 * number never produces a fake key.
 */
export function parentIdentityKey(snapshotOrSource, { sourceSystem } = {}) {
  if (!snapshotOrSource || typeof snapshotOrSource !== "object") return null;
  const claimNumber = normalizedClaimNumber(
    firstValue(snapshotOrSource, [
      "source_claim_number",
      "claimNo",
      "claim_no",
      "claimNumber",
    ]),
  );
  if (!claimNumber) return null;
  const system = normalizedSourceSystem(
    snapshotOrSource.source_system ?? sourceSystem ?? DEFAULT_SOURCE_SYSTEM,
  );
  return `${system}:${claimNumber}`;
}

/**
 * Consensus across a parent's rows for one field, distinguishing:
 *  - "agree":       one distinct non-empty value, no missing values;
 *  - "partial":     one distinct non-empty value + one or more missing;
 *  - "disagree":    two or more distinct non-empty values;
 *  - "all_missing": no populated values.
 *
 * `value` is exposed (original representation) only when exactly one distinct
 * non-empty value exists (agree/partial); otherwise null. Never first/last/
 * max/min of disagreeing values.
 */
export function consensusValue(rows, field) {
  const raw = asArray(rows).map((row) => row?.[field]);
  const normalized = raw.map((value) => normalizeFieldValue(value, field));
  const nonEmpty = normalized.filter((value) => value !== "");
  const distinct = [...new Set(nonEmpty)];
  const missingCount = normalized.length - nonEmpty.length;
  let status;
  if (distinct.length === 0) status = "all_missing";
  else if (distinct.length > 1) status = "disagree";
  else if (missingCount > 0) status = "partial";
  else status = "agree";
  let value = null;
  if (distinct.length === 1) {
    const index = normalized.findIndex((entry) => entry === distinct[0]);
    value = index >= 0 ? raw[index] : null;
  }
  return { status, value, distinctCount: distinct.length, missingCount };
}

function buildConsensus(rows) {
  const consensus = {};
  for (const field of CONSENSUS_FIELDS) {
    const { status, value } = consensusValue(rows, field);
    consensus[field] = { status, value };
  }
  return consensus;
}

/**
 * Determine whether a parent's rows disagree on a claim-identifying invariant.
 * Only distinct NON-EMPTY normalized values count - a populated value paired
 * with a missing one is `partial` (incomplete warning), never a conflict.
 */
export function detectParentIdentityConflict(rows) {
  const conflicting = [];
  const incomplete = [];
  for (const field of PARENT_INVARIANT_FIELDS) {
    const { status } = consensusValue(rows, field);
    if (status === "disagree") conflicting.push(field);
    else if (status === "partial") incomplete.push(field);
  }
  return {
    identity_quality: conflicting.length ? "conflict" : "valid",
    conflicting_fields: conflicting,
    incomplete_fields: incomplete,
  };
}

// Resolve a row's terminal/open/mapped state. Persisted snapshots already carry
// authoritative `terminal`/`open` booleans computed at ingest, so prefer those;
// fall back to the shared status evaluation for rows that only carry a raw
// status. `mapped` (resolved vs unmapped/missing) comes from the normalized
// status and data-quality flags when the booleans are trusted.
function rowStatusEval(row) {
  if (typeof row?.terminal === "boolean" || typeof row?.open === "boolean") {
    const terminal = row.terminal === true;
    const flags = Array.isArray(row.data_quality_flags)
      ? row.data_quality_flags
      : [];
    const missing =
      row.status_normalized === "" ||
      row.status_normalized === null ||
      row.status_normalized === undefined ||
      flags.includes("missing_status");
    const unmapped = flags.includes("unmapped_status");
    return { terminal, open: !terminal, mapped: !missing && !unmapped };
  }
  return getStatusEvaluation(row?.status_raw ?? row?.status_normalized ?? "");
}

/**
 * Conservative parent state roll-up over N rows. Returns orthogonal
 * `lifecycle_state` (open | terminal) and `state_resolution` (resolved |
 * unresolved) plus quality flags.
 *
 * Rules:
 *  - TERMINAL only when every row is terminal (state_resolution resolved).
 *  - any open/non-terminal row -> OPEN.
 *  - unmapped/missing status is open, and never makes a parent terminal.
 *  - open + terminal -> open + parent_status_mixed.
 *  - open + unmapped  -> open + parent_status_incomplete.
 *  - all unmapped     -> open + state_resolution unresolved + parent_status_unresolved.
 */
export function rollUpParentState(rows) {
  const flags = [];
  const evals = asArray(rows).map(rowStatusEval);
  if (evals.length === 0) {
    return {
      lifecycle_state: "open",
      state_resolution: "unresolved",
      flags: ["parent_status_unresolved"],
    };
  }
  // A row's status is "resolved evidence" when it is a known terminal status
  // or maps to a rule; it is unresolved when open AND unmapped/missing.
  const isUnresolved = (evaluation) =>
    !evaluation.terminal && !evaluation.mapped;
  const allTerminal = evals.every((evaluation) => evaluation.terminal);
  if (allTerminal) {
    return { lifecycle_state: "terminal", state_resolution: "resolved", flags };
  }
  const anyTerminal = evals.some((evaluation) => evaluation.terminal);
  const anyOpenNonTerminal = evals.some((evaluation) => !evaluation.terminal);
  const anyUnresolved = evals.some(isUnresolved);
  const allUnresolved = evals.every(isUnresolved);
  if (anyTerminal && anyOpenNonTerminal) flags.push("parent_status_mixed");
  if (allUnresolved) {
    flags.push("parent_status_unresolved");
    return { lifecycle_state: "open", state_resolution: "unresolved", flags };
  }
  if (anyUnresolved) flags.push("parent_status_incomplete");
  return { lifecycle_state: "open", state_resolution: "resolved", flags };
}

/**
 * Group immutable snapshots for a single extract into deterministic parent
 * projections. Rows with no claim number (no parent key) are excluded - they
 * are rejected upstream and never silently grouped. Presence is always
 * "present" (the parent exists in this extract); identity_quality, state and
 * consensus are orthogonal properties.
 */
export function groupSnapshotsByParent(snapshots) {
  const groups = new Map();
  for (const snapshot of asArray(snapshots)) {
    const key = parentIdentityKey(snapshot);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snapshot);
  }
  const projections = [];
  for (const [key, unordered] of groups) {
    const rows = unordered
      .slice()
      .sort(
        (left, right) =>
          (left.source_row_index ?? 0) - (right.source_row_index ?? 0),
      );
    const conflict = detectParentIdentityConflict(rows);
    const state = rollUpParentState(rows);
    const flags = [...state.flags];
    if (rows.length > 1) flags.push("multi_row_claim");
    if (conflict.identity_quality === "conflict")
      flags.push("parent_identity_conflict");
    for (const field of conflict.incomplete_fields)
      flags.push(`parent_field_incomplete:${field}`);
    projections.push({
      parent_identity_key: key,
      source_system: rows[0].source_system || DEFAULT_SOURCE_SYSTEM,
      source_claim_number: rows[0].source_claim_number ?? null,
      rows,
      row_count: rows.length,
      presence: "present",
      identity_quality: conflict.identity_quality,
      state_resolution: state.state_resolution,
      lifecycle_state: state.lifecycle_state,
      quality_flags: [...new Set(flags)],
      consensus: buildConsensus(rows),
    });
  }
  projections.sort((left, right) =>
    left.parent_identity_key.localeCompare(right.parent_identity_key),
  );
  return projections;
}

function toParentMap(parents) {
  if (parents instanceof Map) return parents;
  const map = new Map();
  for (const parent of asArray(parents)) {
    if (parent?.parent_identity_key)
      map.set(parent.parent_identity_key, parent);
  }
  return map;
}

/**
 * Pure pairwise presence/lifecycle diff between two sets of parent
 * projections. No manifest/report-period knowledge. Presence and trust are
 * separate: a parent that becomes (or was) a conflict is still present, so
 * valid<->conflict never yields first_observed / missing_from_extract.
 *
 * Detail lifecycle transitions (terminal_transition_observed / reopened) are
 * emitted only when BOTH sides are resolved and non-conflicting. A parent
 * disappearing produces missing_from_extract - never a closure/terminal
 * transition.
 */
export function diffParentPresence(previousParents, currentParents) {
  const previous = toParentMap(previousParents);
  const current = toParentMap(currentParents);
  const events = [];
  for (const [key, currentParent] of current) {
    const previousParent = previous.get(key);
    if (!previousParent) {
      events.push({ type: "first_observed", parent_identity_key: key });
      continue;
    }
    const bothTrustworthy =
      previousParent.state_resolution === "resolved" &&
      currentParent.state_resolution === "resolved" &&
      previousParent.identity_quality !== "conflict" &&
      currentParent.identity_quality !== "conflict";
    if (!bothTrustworthy) continue;
    if (
      previousParent.lifecycle_state === "open" &&
      currentParent.lifecycle_state === "terminal"
    ) {
      events.push({
        type: "terminal_transition_observed",
        parent_identity_key: key,
      });
    } else if (
      previousParent.lifecycle_state === "terminal" &&
      currentParent.lifecycle_state === "open"
    ) {
      events.push({ type: "reopened", parent_identity_key: key });
    }
  }
  for (const [key] of previous) {
    if (!current.has(key))
      events.push({ type: "missing_from_extract", parent_identity_key: key });
  }
  return events;
}
