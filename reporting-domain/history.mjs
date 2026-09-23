import { calendarAgeBand, toDateOnly } from "./date-periods.mjs";
import { normalizeClaim } from "./claims-contract.mjs";
import {
  CLAIMS_RULE_VERSION,
  evaluateClaim,
  getStatusEvaluation,
} from "./claims-rules.mjs";
import { resolveScoutHandler } from "./roles.mjs";

export const HISTORY_SCHEMA_VERSION = "scout-history-v1";
export const HISTORY_DERIVATION_VERSION = "scout-history-derivation-v1";
export const DEFAULT_SOURCE_SYSTEM = "cardinal_claims";
export const DEFAULT_MAX_ROW_COUNT_DROP_RATIO = 0.5;

const ACCEPTED_HISTORY_STATUSES = new Set([
  "accepted",
  "accepted_with_warnings",
]);

export class HistoryCorrectionLineageError extends Error {
  constructor(reason) {
    super(`Invalid history correction lineage: ${reason}`);
    this.name = "HistoryCorrectionLineageError";
    this.code = "history_correction_lineage_invalid";
  }
}

export class HistoryRetryLineageConflictError extends Error {
  constructor() {
    super("history_retry_lineage_conflict");
    this.name = "HistoryRetryLineageConflictError";
    this.code = "history_retry_lineage_conflict";
  }
}

function acceptedPersistedHistoryManifest(manifest) {
  return Boolean(
    manifest &&
    ACCEPTED_HISTORY_STATUSES.has(manifest.status) &&
    manifest.historical_persisted === true,
  );
}

function acceptedPersistedManifest(manifest, sourceSystem) {
  return Boolean(
    acceptedPersistedHistoryManifest(manifest) &&
    manifest.source_system === sourceSystem,
  );
}

function correctionChildren(manifests, parent, sourceSystem) {
  const children = [];
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (manifest?.correction_of_extract_id !== parent.id) continue;
    if (!acceptedPersistedHistoryManifest(manifest)) continue;
    if (manifest.id === parent.id)
      throw new HistoryCorrectionLineageError(
        "correction lineage self-reference detected",
      );
    if (manifest.source_system !== sourceSystem)
      throw new HistoryCorrectionLineageError(
        `correction child ${manifest.id} source system does not match`,
      );
    if (manifest.effective_date !== parent.effective_date)
      throw new HistoryCorrectionLineageError(
        `correction child ${manifest.id} effective date does not match parent`,
      );
    children.push(manifest);
  }
  return children;
}

function resolveCorrectionHead(manifests, predecessor, sourceSystem, visited) {
  let head = predecessor;
  while (true) {
    const children = correctionChildren(manifests, head, sourceSystem);
    if (children.length > 1)
      throw new HistoryCorrectionLineageError(
        `ambiguous accepted correction lineage for ${head.id}`,
      );
    if (children.length === 0) return head;
    const [child] = children;
    if (visited.has(child.id))
      throw new HistoryCorrectionLineageError(
        "correction lineage cycle detected",
      );
    visited.add(child.id);
    head = child;
  }
}

/**
 * Resolve the single accepted+persisted root (correction_of_extract_id ===
 * null) among `sameDate` manifests, then walk forward through its accepted
 * correction chain to the authoritative head for that effective date.
 * Fails closed - via correctionChildren's own checks plus the orphan check
 * here - rather than silently guessing whenever the manifests for that date
 * don't form exactly one clean chain (no root, multiple roots, correction
 * siblings, cycles, cross-date edges, or a correction whose declared parent
 * isn't reachable from the root).
 */
function resolveAuthoritativeHeadForDate(candidates, date, sourceSystem) {
  const sameDate = candidates.filter(
    (manifest) => manifest.effective_date === date,
  );
  const roots = sameDate.filter(
    (manifest) => !manifest.correction_of_extract_id,
  );
  if (roots.length === 0)
    throw new HistoryCorrectionLineageError(
      `no root extract found for effective date ${date}`,
    );
  if (roots.length > 1)
    throw new HistoryCorrectionLineageError(
      `ambiguous independent extracts for effective date ${date}`,
    );
  const [root] = roots;
  const visited = new Set([root.id]);
  const head = resolveCorrectionHead(candidates, root, sourceSystem, visited);
  const orphans = sameDate.filter((manifest) => !visited.has(manifest.id));
  if (orphans.length > 0)
    throw new HistoryCorrectionLineageError(
      `orphan correction(s) for effective date ${date}: ${orphans
        .map((manifest) => manifest.id)
        .join(", ")}`,
    );
  return head;
}

/**
 * Resolve the authoritative accepted+persisted manifest for the most recent
 * effective period strictly before `beforeDate` - by effective_date, never
 * by received_at/upload order. A correction received after a later
 * effective-date extract must not be able to displace that later period as
 * the comparison baseline just because it was received more recently.
 *
 * Portfolio/source scope is deliberately NOT part of this selection: the
 * existing assessExtractQuality() contract already treats a scope mismatch
 * between an extract and its resolved previousManifest as a downstream
 * quality warning (different_portfolio_scope), not a reason to pick a
 * different baseline. This preserves that contract as-is.
 *
 * Returns null if no prior effective period exists.
 */
export function resolveAuthoritativePriorPeriodManifest({
  manifests = [],
  beforeDate,
  sourceSystem = DEFAULT_SOURCE_SYSTEM,
} = {}) {
  if (!beforeDate) return null;
  const candidates = (Array.isArray(manifests) ? manifests : []).filter(
    (manifest) => acceptedPersistedManifest(manifest, sourceSystem),
  );
  const priorDates = candidates
    .map((manifest) => manifest.effective_date)
    .filter((date) => typeof date === "string" && date < beforeDate);
  if (priorDates.length === 0) return null;
  const latestPriorDate = priorDates.reduce((max, date) =>
    date > max ? date : max,
  );
  return resolveAuthoritativeHeadForDate(
    candidates,
    latestPriorDate,
    sourceSystem,
  );
}

/**
 * Resolve the authoritative accepted+persisted manifest for the most recent
 * effective period overall (no upper bound) - the effective-period-aware
 * equivalent of "the latest history extract". Used by /history/latest so a
 * backdated correction received today can't make it report an older
 * effective period than one that's already live.
 *
 * Returns null if no accepted+persisted manifest exists at all.
 */
export function resolveLatestAuthoritativeManifest({
  manifests = [],
  sourceSystem = DEFAULT_SOURCE_SYSTEM,
} = {}) {
  const candidates = (Array.isArray(manifests) ? manifests : []).filter(
    (manifest) => acceptedPersistedManifest(manifest, sourceSystem),
  );
  const dates = candidates
    .map((manifest) => manifest.effective_date)
    .filter((date) => typeof date === "string");
  if (dates.length === 0) return null;
  const latestDate = dates.reduce((max, date) => (date > max ? date : max));
  return resolveAuthoritativeHeadForDate(candidates, latestDate, sourceSystem);
}

/**
 * Resolve the genuine prior-period baseline for an explicit correction.
 * The target itself must be an accepted, persisted extract for the requested
 * date and must not already have an accepted persisted correction child.
 *
 * The prior period is resolved by effective_date via
 * resolveAuthoritativePriorPeriodManifest(), NOT by walking the target's own
 * stored previous_extract_id. That stored pointer is immutable historical
 * evidence of how the target was originally processed - it can be wrong (a
 * backdated correction received after a later extract stores a previous
 * pointer to whatever was most recently received, not the true prior
 * period), and trusting it here would let a stale/incorrect pointer on an
 * earlier extract silently propagate into a later correction's baseline.
 */
export function resolveCorrectionBaseline({
  manifests = [],
  correctionOfExtractId,
  extractDate,
  sourceSystem = DEFAULT_SOURCE_SYSTEM,
} = {}) {
  const candidates = Array.isArray(manifests) ? manifests : [];
  const byId = new Map(
    candidates
      .filter((manifest) => manifest?.id)
      .map((manifest) => [manifest.id, manifest]),
  );
  const target = byId.get(correctionOfExtractId);
  if (!target)
    throw new HistoryCorrectionLineageError("correction target was not found");
  if (target.source_system !== sourceSystem)
    throw new HistoryCorrectionLineageError(
      "correction target source system does not match",
    );
  if (!ACCEPTED_HISTORY_STATUSES.has(target.status))
    throw new HistoryCorrectionLineageError(
      "correction target is not accepted",
    );
  if (target.historical_persisted !== true)
    throw new HistoryCorrectionLineageError(
      "correction target is not historically persisted",
    );
  if (!extractDate || target.effective_date !== extractDate)
    throw new HistoryCorrectionLineageError(
      "correction target effective date does not match the upload date",
    );

  const directChildren = correctionChildren(
    candidates,
    target,
    sourceSystem,
  );
  if (directChildren.length > 1)
    throw new HistoryCorrectionLineageError(
      `ambiguous accepted correction lineage for ${target.id}`,
    );
  if (directChildren.length === 1)
    throw new HistoryCorrectionLineageError(
      `correction target ${target.id} is already superseded`,
    );

  return {
    targetManifest: target,
    previousManifest: resolveAuthoritativePriorPeriodManifest({
      manifests: candidates,
      beforeDate: target.effective_date,
      sourceSystem,
    }),
  };
}

export function assertCorrectionRetryLineage({
  existingManifest,
  correctionOfExtractId,
  extractDate,
  sourceSystem = DEFAULT_SOURCE_SYSTEM,
  previousManifest = null,
} = {}) {
  if (!existingManifest) return;
  const expectedCorrectionId = correctionOfExtractId ?? null;
  const expectedPreviousId = previousManifest?.id ?? null;
  const actualCorrectionId = existingManifest.correction_of_extract_id ?? null;
  const actualPreviousId = existingManifest.previous_extract_id ?? null;
  if (
    existingManifest.source_system !== sourceSystem ||
    existingManifest.effective_date !== extractDate ||
    actualCorrectionId !== expectedCorrectionId ||
    actualPreviousId !== expectedPreviousId
  )
    throw new HistoryRetryLineageConflictError();
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function computeSourceChecksum(payload, suppliedChecksum = null) {
  if (suppliedChecksum)
    return { checksum: String(suppliedChecksum), basis: "source-file" };
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return { checksum, basis: "claims-json-payload" };
}

const DERIVED_CHECKSUM_FIELDS = new Set([
  "workingAge",
  "working_age",
  "calendarAge",
  "daysSinceMovement",
  "days_since_movement",
  "priority",
  "priorityScore",
  "priority_score",
  "priorityFlags",
  "priority_flags",
  "recommendedAction",
  "recommended_action",
  "dataQuality",
  "data_quality",
  "claimSnapshot",
  "claim_snapshot",
  "possibleDuplicate",
  "possible_duplicate",
  "lastUpdatedSource",
  "last_updated_source",
  "ruleVersion",
  "rule_version",
  "operationalFlags",
  "operational_flags",
]);

/** Exclude Scout-computed fields so retries remain source-content idempotent. */
export function sourceChecksumPayload(claims) {
  return (Array.isArray(claims) ? claims : []).map((claim) => {
    if (!claim || typeof claim !== "object") return claim;
    return Object.fromEntries(
      Object.entries(claim).filter(
        ([key]) => !DERIVED_CHECKSUM_FIELDS.has(key),
      ),
    );
  });
}

const DATE_FIELDS = [
  ["registered_date", ["registeredDate", "claim_registered", "registered_at"]],
  ["dol_date", ["dolDate", "dol", "date_of_loss"]],
  ["movement_date", ["movementDate", "lastMovementDate", "last_updated"]],
  ["repudiation_date", ["repudiationDate", "repudiation_date"]],
];

const NUMERIC_FIELDS = [
  ["outstanding", ["outstanding", "nett_claim"]],
  ["estimate", ["estimate", "original_estimate"]],
  ["paid", ["paid"]],
  ["mandate", ["mandate"]],
];

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null)
      return source[key];
  }
  return null;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function normalizedClaimNumber(value) {
  return hasValue(value) ? String(value).trim() : "";
}

function parseDate(value, field, qualityFlags) {
  if (!hasValue(value)) return null;
  try {
    return toDateOnly(value);
  } catch {
    qualityFlags.push(`invalid_date:${field}`);
    return null;
  }
}

function parseNumber(value, field, qualityFlags) {
  if (!hasValue(value)) return null;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    qualityFlags.push(`numeric_parse_failure:${field}`);
    return null;
  }
  const parsed = Number(String(value).replace(/[Rr,\s]/g, ""));
  if (Number.isFinite(parsed)) return parsed;
  qualityFlags.push(`numeric_parse_failure:${field}`);
  return null;
}

function parseSourceEventAt(value) {
  if (!hasValue(value) || /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim()))
    return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceEvidence(source) {
  const keys = [
    "claimNo",
    "claim_no",
    "claimNumber",
    "status",
    "claims_status",
    "handler",
    "handler_name",
    "handlerEmail",
    "handler_email",
    "insured",
    "insured_name",
    "insurer",
    "insurer_name",
    "peril",
    "perilType",
    "peril_type",
    "description",
    "description_of_loss",
    "comments",
    "registeredDate",
    "claim_registered",
    "dolDate",
    "dol",
    "date_of_loss",
    "movementDate",
    "lastMovementDate",
    "last_updated",
    "repudiationDate",
    "repudiation_date",
    "outstanding",
    "nett_claim",
    "estimate",
    "original_estimate",
    "paid",
    "mandate",
    "sourceEventAt",
    "event_at",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => source?.[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function operationalFlagCodes(evaluation) {
  return Object.entries(evaluation.operationalCategories || {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
}

function priorityBand(score) {
  if (score >= 60) return "P1";
  if (score >= 30) return "P2";
  return "P3";
}

function normalizedSourceHandler(source) {
  return firstValue(source, [
    "handlerEmail",
    "handler_email",
    "handler",
    "handler_name",
  ]);
}

function buildSnapshot(source, index, context, duplicateClaimNumbers) {
  const qualityFlags = [];
  const sourceClaimNumber = firstValue(source, [
    "claimNo",
    "claim_no",
    "claimNumber",
  ]);
  const claimNumber = normalizedClaimNumber(sourceClaimNumber);
  if (!claimNumber) qualityFlags.push("missing_claim_number");

  const rawStatus = firstValue(source, ["status", "claims_status"]);
  const status = getStatusEvaluation(rawStatus);
  // A row is "missing status" when either the source cell was empty OR the
  // shared normalization treats its value as a known missing-value sentinel
  // (e.g. "[none]"). In both cases the semantically-normalized status is "".
  const hasSemanticStatus = status.normalizedStatus !== "";
  if (!status.mapped && !status.terminal && hasSemanticStatus)
    qualityFlags.push("unmapped_status");
  if (!hasSemanticStatus) qualityFlags.push("missing_status");
  if (duplicateClaimNumbers.has(claimNumber) && claimNumber) {
    qualityFlags.push("duplicate_claim_number", "identity_ambiguity");
  }

  const handlerSource = normalizedSourceHandler(source);
  const handlerResolution = resolveScoutHandler(
    context.activeUsers,
    handlerSource,
  );
  if (handlerResolution.status === "unrecognised")
    qualityFlags.push("unrecognised_handler");
  if (handlerResolution.status === "ambiguous")
    qualityFlags.push("ambiguous_handler");
  if (handlerResolution.status === "unassigned")
    qualityFlags.push("unassigned_handler");

  const dates = Object.fromEntries(
    DATE_FIELDS.map(([field, aliases]) => [
      field,
      parseDate(firstValue(source, aliases), field, qualityFlags),
    ]),
  );
  const numbers = Object.fromEntries(
    NUMERIC_FIELDS.map(([field, aliases]) => [
      field,
      parseNumber(firstValue(source, aliases), field, qualityFlags),
    ]),
  );
  const movementSourceValue = firstValue(source, [
    "movementDate",
    "lastMovementDate",
    "last_updated",
  ]);
  const sourceEventAt = parseSourceEventAt(
    firstValue(source, ["sourceEventAt", "event_at"]),
  );
  const identityIsMatchable =
    Boolean(claimNumber) && !duplicateClaimNumbers.has(claimNumber);
  const identityKey = identityIsMatchable
    ? `${context.sourceSystem}:${claimNumber}`
    : null;
  const claim = normalizeClaim({
    ...source,
    claimNo: sourceClaimNumber,
    status: rawStatus,
    handlerEmail:
      handlerResolution.user?.email ??
      (String(handlerSource ?? "").includes("@")
        ? String(handlerSource).trim().toLowerCase()
        : null),
    registeredDate: dates.registered_date,
    dolDate: dates.dol_date,
    movementDate: dates.movement_date,
    repudiationDate: dates.repudiation_date,
    outstanding: numbers.outstanding,
    estimate: numbers.estimate,
    paid: numbers.paid,
    mandate: numbers.mandate,
    workingAge: firstValue(source, [
      "workingAge",
      "working_age",
      "age_days",
      "age",
    ]),
    calendarAge: source.calendarAge,
    daysSinceMovement: source.daysSinceMovement ?? source.days_since_movement,
  });

  let evaluation;
  try {
    evaluation = evaluateClaim(claim, {
      asOfDate: context.effectiveDate,
      onUnsupported: "throw",
    });
  } catch (error) {
    evaluation = evaluateClaim(
      { ...claim, registeredDate: null },
      { asOfDate: context.effectiveDate },
    );
    qualityFlags.push(
      error?.name === "UnsupportedCalendarCoverageError"
        ? "unsupported_calendar_coverage"
        : "derived_evaluation_error",
    );
  }

  const workingAge = evaluation.ages.workingAge;
  const calendarAge = evaluation.ages.calendarAge;
  const rowStatus = status.open ? "open" : "terminal";
  return {
    claim_id: null,
    identity_key: identityKey,
    identity_confidence: identityIsMatchable ? "source_scoped" : "ambiguous",
    identity_matchable: identityIsMatchable,
    source_row_identity: `row-${index}`,
    source_row_index: index,
    source_claim_number:
      sourceClaimNumber === null || sourceClaimNumber === undefined
        ? null
        : String(sourceClaimNumber),
    handler_source:
      handlerSource === null || handlerSource === undefined
        ? null
        : String(handlerSource),
    handler_email: claim.handlerEmail,
    resolved_scout_user_id: handlerResolution.user?.id ?? null,
    handler_resolution: handlerResolution.status,
    status_raw:
      rawStatus === null || rawStatus === undefined ? null : String(rawStatus),
    status_normalized: status.normalizedStatus,
    terminal: status.terminal,
    open: status.open,
    operational_category: status.category,
    registered_date: dates.registered_date,
    dol_date: dates.dol_date,
    movement_date: dates.movement_date,
    repudiation_date: dates.repudiation_date,
    source_event_at: sourceEventAt,
    outstanding: numbers.outstanding,
    estimate: numbers.estimate,
    paid: numbers.paid,
    mandate: numbers.mandate,
    insurer: firstValue(source, ["insurer", "insurer_name"]),
    peril: firstValue(source, ["peril"]),
    peril_type: firstValue(source, ["perilType", "peril_type"]),
    insured: firstValue(source, ["insured", "insured_name"]),
    description: firstValue(source, ["description", "description_of_loss"]),
    comments: firstValue(source, ["comments"]),
    calendar_age: calendarAge,
    working_age: workingAge,
    age_band: calendarAgeBand(calendarAge),
    rule_version: evaluation.ruleVersion || CLAIMS_RULE_VERSION,
    priority_score: evaluation.priority.score,
    priority_band: priorityBand(evaluation.priority.score),
    priority_flags: evaluation.priority.flags,
    operational_flags: operationalFlagCodes(evaluation),
    data_quality_flags: [...new Set(qualityFlags)],
    source_evidence: sourceEvidence(source),
    movement_source_value: movementSourceValue,
    _raw_source: source,
    _evaluation: evaluation,
    _row_status: rowStatus,
  };
}

export function normalizeHistoricalRows(
  rows,
  {
    sourceSystem = DEFAULT_SOURCE_SYSTEM,
    effectiveDate = null,
    activeUsers = [],
  } = {},
) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const claimNumbers = inputRows
    .map((row) =>
      normalizedClaimNumber(
        firstValue(row, ["claimNo", "claim_no", "claimNumber"]),
      ),
    )
    .filter(Boolean);
  const counts = new Map();
  for (const claimNumber of claimNumbers)
    counts.set(claimNumber, (counts.get(claimNumber) || 0) + 1);
  const duplicateClaimNumbers = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
  const snapshots = [];
  const rejectedRows = [];
  for (const [index, source] of inputRows.entries()) {
    if (!source || typeof source !== "object") {
      rejectedRows.push({ rowIndex: index, flags: ["invalid_row"] });
      continue;
    }
    const snapshot = buildSnapshot(
      source,
      index,
      { sourceSystem, effectiveDate, activeUsers },
      duplicateClaimNumbers,
    );
    if (snapshot.data_quality_flags.includes("missing_claim_number")) {
      rejectedRows.push({
        rowIndex: index,
        flags: snapshot.data_quality_flags,
      });
      continue;
    }
    snapshots.push(snapshot);
  }
  const quality = {
    source_row_count: inputRows.length,
    normalized_claim_count: snapshots.length,
    accepted_claim_count: snapshots.length,
    rejected_claim_count: rejectedRows.length,
    invalid_row_count: rejectedRows.length,
    duplicate_claim_number_count: duplicateClaimNumbers.size,
    identity_ambiguity_count: snapshots.filter((row) =>
      row.data_quality_flags.includes("identity_ambiguity"),
    ).length,
    unknown_handler_count: snapshots.filter((row) =>
      row.data_quality_flags.includes("unrecognised_handler"),
    ).length,
    unmapped_status_count: snapshots.filter((row) =>
      row.data_quality_flags.includes("unmapped_status"),
    ).length,
    invalid_date_count: snapshots.reduce(
      (count, row) =>
        count +
        row.data_quality_flags.filter((flag) =>
          flag.startsWith("invalid_date:"),
        ).length,
      0,
    ),
    invalid_numeric_count: snapshots.reduce(
      (count, row) =>
        count +
        row.data_quality_flags.filter((flag) =>
          flag.startsWith("numeric_parse_failure:"),
        ).length,
      0,
    ),
    warning_count: snapshots.filter((row) => row.data_quality_flags.length > 0)
      .length,
    hard_rejection: inputRows.length === 0 || snapshots.length === 0,
  };
  return { snapshots, rejectedRows, quality };
}

export function assessExtractQuality(
  normalized,
  {
    previousManifest = null,
    sourceSystem = DEFAULT_SOURCE_SYSTEM,
    schemaVersion = HISTORY_SCHEMA_VERSION,
    sourceMetadata = {},
    maxRowCountDropRatio = DEFAULT_MAX_ROW_COUNT_DROP_RATIO,
  } = {},
) {
  const warnings = [];
  const quality = { ...normalized.quality };
  const previousScope =
    previousManifest?.source_metadata?.portfolio_scope ?? null;
  const currentScope = sourceMetadata?.portfolio_scope ?? null;
  const comparable = Boolean(
    previousManifest &&
    previousManifest.source_system === sourceSystem &&
    previousManifest.schema_version === schemaVersion &&
    ["accepted", "accepted_with_warnings"].includes(previousManifest.status) &&
    previousManifest.quality_summary?.completeness_state !== "incomplete" &&
    previousScope === currentScope,
  );
  if (previousManifest && previousManifest.source_system !== sourceSystem)
    warnings.push("different_source_system");
  if (previousManifest && previousManifest.schema_version !== schemaVersion)
    warnings.push("different_schema_version");
  if (previousManifest && previousScope !== currentScope)
    warnings.push("different_portfolio_scope");
  if (normalized.quality.hard_rejection) warnings.push("no_accepted_rows");
  const previousAcceptedCount = previousManifest
    ? (previousManifest.accepted_claim_count ??
      previousManifest.claim_count ??
      0)
    : 0;
  if (previousManifest && comparable && previousAcceptedCount > 0) {
    const dropRatio =
      1 - normalized.quality.accepted_claim_count / previousAcceptedCount;
    quality.row_count_drop_ratio = Math.max(0, dropRatio);
    if (dropRatio >= maxRowCountDropRatio)
      warnings.push("material_row_count_drop");
  } else {
    quality.row_count_drop_ratio = null;
  }
  const incomplete =
    warnings.includes("material_row_count_drop") ||
    warnings.includes("different_portfolio_scope") ||
    warnings.includes("different_schema_version");
  quality.completeness_state = incomplete ? "incomplete" : "complete";
  quality.comparable_to_previous = comparable && !incomplete;
  if (quality.warning_count > 0 || quality.rejected_claim_count > 0) {
    warnings.push("row_quality_warnings");
  }
  quality.warnings = warnings;
  quality.quality_state = quality.hard_rejection
    ? "rejected"
    : warnings.length
      ? "warning"
      : "ok";
  return quality;
}

function comparableMap(snapshots) {
  const counts = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot.identity_matchable || !snapshot.identity_key) continue;
    counts.set(
      snapshot.identity_key,
      (counts.get(snapshot.identity_key) || 0) + 1,
    );
  }
  const map = new Map();
  for (const snapshot of snapshots) {
    if (
      snapshot.identity_matchable &&
      snapshot.identity_key &&
      counts.get(snapshot.identity_key) === 1
    ) {
      map.set(snapshot.identity_key, snapshot);
    }
  }
  return map;
}

function boundary(manifest, preferred) {
  return (
    manifest?.[preferred] ||
    manifest?.effective_at ||
    manifest?.received_at ||
    null
  );
}

function makeChange(
  type,
  currentManifest,
  previousManifest,
  claimId,
  oldValue,
  newValue,
  options = {},
) {
  const sourceEventAt = options.sourceEventAt || null;
  const sourceExplicit = Boolean(sourceEventAt);
  const hasPrevious = Boolean(previousManifest?.id);
  return {
    claim_id: claimId,
    change_type: type,
    source_extract_id: currentManifest.id,
    previous_extract_id: previousManifest?.id ?? null,
    old_value: oldValue ?? null,
    new_value: newValue ?? null,
    source_event_at: sourceEventAt,
    first_observed_at: boundary(currentManifest, "received_at"),
    observed_after: boundary(previousManifest, "received_at"),
    observed_at:
      boundary(currentManifest, "effective_at") ||
      boundary(currentManifest, "received_at"),
    provenance:
      options.provenance ||
      (sourceExplicit ? "source_explicit" : "extract_observed"),
    timestamp_precision:
      options.precision ||
      (sourceExplicit
        ? "exact_timestamp"
        : hasPrevious
          ? "between_extracts"
          : "unknown"),
    derived_by_version: HISTORY_DERIVATION_VERSION,
  };
}

function valuesDiffer(left, right) {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function changedFields(previous, current) {
  return [
    [
      "status_changed",
      "status",
      { raw: previous.status_raw, normalized: previous.status_normalized },
      { raw: current.status_raw, normalized: current.status_normalized },
    ],
    [
      "handler_changed",
      "handler",
      {
        source: previous.handler_source,
        email: previous.handler_email,
        user_id: previous.resolved_scout_user_id,
      },
      {
        source: current.handler_source,
        email: current.handler_email,
        user_id: current.resolved_scout_user_id,
      },
    ],
    [
      "movement_changed",
      "movement_date",
      previous.movement_date,
      current.movement_date,
    ],
    ["estimate_changed", "estimate", previous.estimate, current.estimate],
    [
      "outstanding_changed",
      "outstanding",
      previous.outstanding,
      current.outstanding,
    ],
    ["paid_changed", "paid", previous.paid, current.paid],
    ["mandate_changed", "mandate", previous.mandate, current.mandate],
  ].filter(([, , oldValue, newValue]) => valuesDiffer(oldValue, newValue));
}

export function buildObservedChanges(
  previousManifest,
  previousSnapshots,
  currentManifest,
  currentSnapshots,
) {
  const changes = [];
  const previous = comparableMap(previousSnapshots || []);
  const current = comparableMap(currentSnapshots || []);
  for (const [identityKey, snapshot] of current) {
    const previousSnapshot = previous.get(identityKey);
    if (!previousSnapshot) {
      changes.push(
        makeChange(
          "first_observed",
          currentManifest,
          previousManifest,
          snapshot.claim_id,
          null,
          {
            source_claim_number: snapshot.source_claim_number,
            status: snapshot.status_normalized,
          },
        ),
      );
      continue;
    }
    for (const [type, field, oldValue, newValue] of changedFields(
      previousSnapshot,
      snapshot,
    )) {
      const movementSourceEvent =
        type === "movement_changed" ? snapshot.source_event_at : null;
      changes.push(
        makeChange(
          type,
          currentManifest,
          previousManifest,
          snapshot.claim_id,
          oldValue,
          newValue,
          {
            sourceEventAt: movementSourceEvent,
            precision: movementSourceEvent
              ? "exact_timestamp"
              : type === "movement_changed"
                ? "source_date"
                : undefined,
          },
        ),
      );
    }
    if (!previousSnapshot.terminal && snapshot.terminal) {
      changes.push(
        makeChange(
          "terminal_transition_observed",
          currentManifest,
          previousManifest,
          snapshot.claim_id,
          { terminal: false, status: previousSnapshot.status_normalized },
          { terminal: true, status: snapshot.status_normalized },
          { provenance: "system_derived", precision: "between_extracts" },
        ),
      );
    }
    if (previousSnapshot.terminal && snapshot.open) {
      changes.push(
        makeChange(
          "reopened",
          currentManifest,
          previousManifest,
          snapshot.claim_id,
          { terminal: true, status: previousSnapshot.status_normalized },
          { terminal: false, status: snapshot.status_normalized },
          { provenance: "system_derived", precision: "between_extracts" },
        ),
      );
    }
  }
  if (
    previousManifest &&
    currentManifest.quality_summary?.comparable_to_previous
  ) {
    for (const [identityKey, previousSnapshot] of previous) {
      if (!current.has(identityKey)) {
        changes.push(
          makeChange(
            "missing_from_extract",
            currentManifest,
            previousManifest,
            previousSnapshot.claim_id,
            {
              source_claim_number: previousSnapshot.source_claim_number,
              status: previousSnapshot.status_normalized,
            },
            null,
            { provenance: "extract_observed", precision: "between_extracts" },
          ),
        );
      }
    }
  }
  return deduplicateChanges(changes);
}

export function deduplicateChanges(changes) {
  const seen = new Set();
  return (Array.isArray(changes) ? changes : []).filter((change) => {
    const key = [
      change.source_extract_id,
      change.claim_id,
      change.previous_extract_id || "none",
      change.change_type,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function safeHistorySnapshot(snapshot) {
  const {
    source_evidence: _sourceEvidence,
    _raw_source: _rawSource,
    _evaluation: _evaluation,
    ...safe
  } = snapshot || {};
  return safe;
}
