import {
  BUSINESS_TIME_ZONE,
  addDateOnly,
  calendarAgeBand,
  calendarDaysBetween,
  containsTimestamp,
  localDateTimeToInstant,
  monthlyPeriod,
  toDateOnly,
  weeklyPeriod,
} from "./date-periods.mjs";
import {
  CLAIMS_RULE_VERSION,
  evaluateClaim,
  evaluateMandateAndRisk,
  evaluateMovement,
  evaluateOperationalCategories,
  evaluateSla,
  getReadyToCloseCandidate,
} from "./claims-rules.mjs";
import {
  DEFAULT_MAX_ROW_COUNT_DROP_RATIO,
  HISTORY_SCHEMA_VERSION,
} from "./history.mjs";
import { resolveActiveScoutUsers } from "./roles.mjs";
import {
  consensusValue,
  diffParentPresence,
  groupSnapshotsByParent,
  parentIdentityKey,
} from "./claim-parent.mjs";

export const REPORTING_METRIC_VERSION = "claims-reporting-metrics-v2";
export const REPORT_SCHEMA_VERSION = "scout-report-v2";
export const REPORTING_QUALITY_VERSION = "scout-reporting-quality-v2";
export const REPORTING_DOMAIN = "claims";
export const REPORTING_TIME_ZONE = BUSINESS_TIME_ZONE;

const ACCEPTED_STATUSES = new Set(["accepted", "accepted_with_warnings"]);
const CORE_STATE_METRIC_IDS = new Set([
  "opening_inventory",
  "closing_inventory",
  "net_inventory_movement",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function parseInstant(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateFromInstant(value, timeZone = BUSINESS_TIME_ZONE) {
  const date = parseInstant(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]),
  );
  if (!values.year || !values.month || !values.day) return null;
  return `${String(values.year).padStart(4, "0")}-${String(values.month).padStart(2, "0")}-${String(values.day).padStart(2, "0")}`;
}

function hasAuthoritativeEffectiveDate(manifest) {
  if (!manifest?.effective_date) return false;
  if (manifest.effective_precision === "unknown") return false;
  return manifest?.source_metadata?.effective_date_basis !== "upload_received_date";
}

function manifestInstant(manifest, timeZone = BUSINESS_TIME_ZONE) {
  const exact = parseInstant(manifest?.effective_at);
  if (exact) return exact;
  if (hasAuthoritativeEffectiveDate(manifest)) {
    try {
      return localDateTimeToInstant(
        manifest.effective_date,
        "00:00:00",
        timeZone,
      );
    } catch {
      /* fall through to receipt time */
    }
  }
  const received = parseInstant(manifest?.received_at);
  if (received) return received;
  if (manifest?.effective_date) {
    try {
      return localDateTimeToInstant(
        manifest.effective_date,
        "00:00:00",
        timeZone,
      );
    } catch {
      return null;
    }
  }
  return null;
}

export function extractObservationInstant(
  manifest,
  timeZone = BUSINESS_TIME_ZONE,
) {
  return manifestInstant(manifest, timeZone);
}

function manifestPrecision(manifest) {
  if (manifest?.effective_at) return "source_exact";
  if (hasAuthoritativeEffectiveDate(manifest)) return "source_date";
  if (manifest?.received_at) return "observed_period";
  if (manifest?.effective_date) return "source_date";
  return "unavailable";
}

function manifestReferenceDate(manifest, timeZone = BUSINESS_TIME_ZONE) {
  return (
    dateFromInstant(manifest?.effective_at, timeZone) ||
    (hasAuthoritativeEffectiveDate(manifest)
      ? manifest.effective_date
      : dateFromInstant(manifest?.received_at, timeZone)) ||
    manifest?.effective_date
  );
}

function manifestIsAccepted(manifest) {
  const quality = asObject(manifest?.quality_summary);
  return (
    ACCEPTED_STATUSES.has(manifest?.status) &&
    manifest?.historical_persisted === true &&
    quality.completeness_state !== "incomplete" &&
    quality.hard_rejection !== true
  );
}

function sourceScope(manifest) {
  return manifest?.source_metadata?.portfolio_scope ?? null;
}

function scopeMatches(manifest, requestedScope) {
  const expected = requestedScope?.portfolio_scope ?? null;
  return expected === null || sourceScope(manifest) === expected;
}

function manifestSort(left, right, timeZone) {
  const leftTime = manifestInstant(left, timeZone)?.getTime() ?? -Infinity;
  const rightTime = manifestInstant(right, timeZone)?.getTime() ?? -Infinity;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const leftReceived = parseInstant(left?.received_at)?.getTime() ?? -Infinity;
  const rightReceived =
    parseInstant(right?.received_at)?.getTime() ?? -Infinity;
  if (leftReceived !== rightReceived) return leftReceived - rightReceived;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function hasCorrectionPointer(manifest) {
  return (
    manifest?.correction_of_extract_id !== null &&
    manifest?.correction_of_extract_id !== undefined
  );
}

function structurallyValidCorrectionEdge(child, parent) {
  return Boolean(
    parent &&
    child?.id &&
    child.id !== parent.id &&
    child.source_system === parent.source_system &&
    child.effective_date === parent.effective_date,
  );
}

function correctionCycleNodes(edges) {
  const visited = new Set();
  const cycleNodes = new Set();

  for (const start of edges.keys()) {
    if (visited.has(start)) continue;
    const path = [];
    const indexById = new Map();
    let current = start;
    while (edges.has(current) && !visited.has(current)) {
      if (indexById.has(current)) {
        for (let index = indexById.get(current); index < path.length; index++)
          cycleNodes.add(path[index]);
        break;
      }
      indexById.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    for (const id of path) visited.add(id);
  }
  return cycleNodes;
}

function correctionAuthorityGraph(candidates) {
  const manifestsById = new Map(
    candidates.filter((manifest) => manifest?.id).map((manifest) => [manifest.id, manifest]),
  );
  const correctionEdges = new Map();
  const malformedCorrectionIds = new Set();

  for (const child of candidates) {
    if (!hasCorrectionPointer(child)) continue;
    const parent = manifestsById.get(child.correction_of_extract_id);
    if (!structurallyValidCorrectionEdge(child, parent)) {
      malformedCorrectionIds.add(child.id);
      continue;
    }
    correctionEdges.set(child.id, parent.id);
  }

  for (const id of correctionCycleNodes(correctionEdges))
    malformedCorrectionIds.add(id);

  const childrenByParent = new Map();
  for (const [childId, parentId] of correctionEdges) {
    if (malformedCorrectionIds.has(childId)) continue;
    if (malformedCorrectionIds.has(parentId)) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }

  for (const children of childrenByParent.values()) {
    if (children.length <= 1) continue;
    for (const childId of children) malformedCorrectionIds.add(childId);
  }

  // A correction of a malformed correction is malformed as well. Iterate so
  // an invalid branch cannot re-enter the graph through a later child.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [childId, parentId] of correctionEdges) {
      if (malformedCorrectionIds.has(childId)) continue;
      const parent = manifestsById.get(parentId);
      if (hasCorrectionPointer(parent) && malformedCorrectionIds.has(parentId)) {
        malformedCorrectionIds.add(childId);
        changed = true;
      }
    }
  }

  const superseded = new Set();
  const validCorrectionIds = new Set();
  for (const [childId, parentId] of correctionEdges) {
    if (malformedCorrectionIds.has(childId)) continue;
    if (malformedCorrectionIds.has(parentId)) continue;
    validCorrectionIds.add(childId);
    superseded.add(parentId);
  }

  return { malformedCorrectionIds, superseded, validCorrectionIds };
}

function authoritativeManifestModel(manifests, scope) {
  const candidates = asArray(manifests).filter(
    (manifest) => manifestIsAccepted(manifest) && scopeMatches(manifest, scope),
  );
  const authorityGraph = correctionAuthorityGraph(candidates);
  const authoritative = candidates.filter(
    (manifest) =>
      !authorityGraph.malformedCorrectionIds.has(manifest.id) &&
      !authorityGraph.superseded.has(manifest.id),
  );
  return {
    candidates,
    superseded: authorityGraph.superseded,
    authoritative,
    authoritativeIds: new Set(authoritative.map((manifest) => manifest.id)),
  };
}

export function selectAuthoritativeManifests(manifests, { scope = {} } = {}) {
  return authoritativeManifestModel(manifests, scope).authoritative;
}

/**
 * Select the latest usable accepted extract at or before a reporting boundary.
 * Effective timestamp wins, then source date at local midnight, then receipt
 * time. Corrected versions supersede their referenced extract when both are
 * applicable to the same boundary.
 */
export function selectBoundaryExtract(
  manifests,
  boundary,
  { timeZone = BUSINESS_TIME_ZONE, scope = {} } = {},
) {
  const boundaryInstant = parseInstant(boundary);
  if (!boundaryInstant) {
    return {
      manifest: null,
      reason: "invalid_boundary",
      candidatesConsidered: 0,
    };
  }
  const model = authoritativeManifestModel(manifests, scope);
  const candidates = model.candidates.filter((manifest) => {
    const instant = manifestInstant(manifest, timeZone);
    return instant !== null && instant <= boundaryInstant;
  });
  const current = candidates.filter((manifest) =>
    model.authoritativeIds.has(manifest.id),
  );
  current.sort((left, right) => manifestSort(right, left, timeZone));
  const manifest = current[0] || null;
  return {
    manifest,
    reason: manifest ? null : "no_suitable_extract",
    candidatesConsidered: candidates.length,
    effectiveInstant: manifest ? manifestInstant(manifest, timeZone) : null,
    precision: manifest ? manifestPrecision(manifest) : "unavailable",
  };
}

export function reportingPeriod(
  reportType,
  periodStart,
  timeZone = BUSINESS_TIME_ZONE,
) {
  if (reportType === "weekly") return weeklyPeriod(periodStart, timeZone);
  if (reportType === "monthly") return monthlyPeriod(periodStart, timeZone);
  throw new RangeError(`Unsupported claims report type: ${reportType}`);
}

export function previousReportingPeriod(
  reportType,
  periodStart,
  timeZone = BUSINESS_TIME_ZONE,
) {
  const current = reportingPeriod(reportType, periodStart, timeZone);
  return reportingPeriod(
    reportType,
    addDateOnly(current.startLocalDate, reportType === "weekly" ? -7 : -1),
    timeZone,
  );
}

function snapshotsForExtract(snapshotsByExtract, extractId) {
  if (!extractId) return [];
  if (snapshotsByExtract instanceof Map)
    return asArray(snapshotsByExtract.get(extractId));
  return asArray(snapshotsByExtract?.[extractId]);
}

function allSnapshots(snapshotsByExtract) {
  if (snapshotsByExtract instanceof Map)
    return [...snapshotsByExtract.values()].flatMap(asArray);
  return Object.values(asObject(snapshotsByExtract)).flatMap(asArray);
}

function snapshotReference(snapshot) {
  return snapshot?.claim_id ?? snapshot?.identity_key ?? null;
}

function comparableSnapshotMap(snapshots) {
  const byKey = new Map();
  for (const snapshot of asArray(snapshots)) {
    if (!snapshot?.identity_matchable || !snapshot?.identity_key) continue;
    if (!byKey.has(snapshot.identity_key))
      byKey.set(snapshot.identity_key, snapshot);
  }
  return byKey;
}

function periodSnapshotRows(
  manifests,
  snapshotsByExtract,
  period,
  timeZone,
  scope,
  canonicalByKey,
) {
  const rows = [];
  const relevantManifests = authoritativeManifestModel(manifests, scope)
    .authoritative.filter((manifest) =>
      periodMembership(manifestInstant(manifest, timeZone), period),
    )
    .sort((left, right) => manifestSort(left, right, timeZone));
  for (const manifest of relevantManifests) {
    rows.push(
      ...parentClaimsForExtract(
        snapshotsForExtract(snapshotsByExtract, manifest.id),
        manifest,
        timeZone,
        canonicalByKey,
      ),
    );
  }
  const latestObservedByClaim = new Map();
  for (const row of rows) latestObservedByClaim.set(row.id, row);
  return [...latestObservedByClaim.values()];
}

/**
 * Derive parent-level lifecycle events across the AUTHORITATIVE extract chain
 * for a reporting period. Walks the last authoritative extract strictly before
 * the period (the comparison baseline, so the first in-period extract does not
 * mass-emit first_observed) plus every authoritative extract inside the period,
 * in effective chronological order, comparing each adjacent pair via the pure
 * parent presence diff. Superseded/non-authoritative extracts never
 * participate. Events are attributed to the observation instant of the CURRENT
 * extract in each transition, and only those whose instant is in the period are
 * returned.
 *
 * missing_from_extract is emitted only when the current extract is comparable to
 * its predecessor, and is NEVER a closure - closure is a deterministic
 * open->terminal parent transition (terminal_transition_observed) only.
 */
// The authoritative extract chain a period's lifecycle is derived over: the
// last authoritative extract strictly before the period (comparison baseline)
// followed by every authoritative extract inside the period, in effective
// chronological order. Fewer than two entries means no adjacent pair exists to
// derive lifecycle transitions from.
function authoritativeChainForPeriod(manifests, period, timeZone, scope) {
  const authoritative = authoritativeManifestModel(manifests, scope)
    .authoritative.filter((manifest) => manifestInstant(manifest, timeZone))
    .sort((left, right) => manifestSort(left, right, timeZone));
  let baseline = null;
  const inPeriod = [];
  for (const manifest of authoritative) {
    const instant = manifestInstant(manifest, timeZone);
    if (instant.getTime() < period.start.getTime()) {
      baseline = manifest;
    } else if (periodMembership(instant, period)) {
      inPeriod.push(manifest);
    }
  }
  return baseline ? [baseline, ...inPeriod] : inPeriod;
}

export function deriveParentLifecycleEvents(
  manifests,
  snapshotsByExtract,
  period,
  timeZone = BUSINESS_TIME_ZONE,
  scope = {},
) {
  const chain = authoritativeChainForPeriod(manifests, period, timeZone, scope);
  // Resolve canonical parenthood LONGITUDINALLY, but AS-OF the reporting
  // boundary: over authoritative history <= period.end only (all pre-period
  // baseline and in-period extracts, never a post-period extract). This is the
  // SAME bounded canonical domain the inventory, exact-closure and report
  // claim-row identity use, so lifecycle references stay in one domain and a
  // future authoritative extract cannot rewrite this period's lifecycle refs. A
  // legacy matchable singleton still never promotes a child UUID because the
  // pre-period ambiguity is retained.
  const authoritativeIds = authoritativeIdsAsOf(
    manifests,
    period.end,
    timeZone,
    scope,
  );
  const canonicalByKey = buildParentCanonicalIndex(
    snapshotsByExtract,
    authoritativeIds,
  );
  const events = [];
  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1];
    const current = chain[index];
    const currentInstant = manifestInstant(current, timeZone);
    if (!periodMembership(currentInstant, period)) continue;
    const comparable =
      current.quality_summary?.comparable_to_previous !== false;
    const previousParents = groupSnapshotsByParent(
      snapshotsForExtract(snapshotsByExtract, previous.id),
    );
    const currentParents = groupSnapshotsByParent(
      snapshotsForExtract(snapshotsByExtract, current.id),
    );
    // Map a logical parent key to the SAME reporting reference id the metric
    // populations use (canonical claim UUID when one exists, else the parent
    // identity key) so lifecycle and inventory populations stay consistent.
    const refFrom = (parents) => {
      const map = new Map();
      for (const parent of parents)
        map.set(
          parent.parent_identity_key,
          parentReferenceId(parent, canonicalByKey),
        );
      return map;
    };
    const currentRefs = refFrom(currentParents);
    const previousRefs = refFrom(previousParents);
    for (const event of diffParentPresence(previousParents, currentParents)) {
      if (event.type === "missing_from_extract" && !comparable) continue;
      const claimRef =
        event.type === "missing_from_extract"
          ? previousRefs.get(event.parent_identity_key)
          : currentRefs.get(event.parent_identity_key);
      events.push({
        ...event,
        claim_ref: claimRef ?? event.parent_identity_key,
        observed_at: currentInstant.toISOString(),
        source_extract_id: current.id,
        previous_extract_id: previous.id,
      });
    }
  }
  return events;
}

function metricPopulation(ids = []) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].sort();
  return { count: unique.length, claim_ids: unique };
}

function metric(
  id,
  value,
  {
    precision = "snapshot_exact",
    availability = "available",
    claimIds = [],
    warnings = [],
    definition = id,
    evidence = {},
    details = null,
  } = {},
) {
  return {
    id,
    value,
    definition,
    metric_definition_version: REPORTING_METRIC_VERSION,
    precision,
    availability,
    claim_population: metricPopulation(claimIds),
    coverage_warnings: [...new Set(warnings.filter(Boolean))],
    evidence,
    ...(details === null ? {} : { details }),
  };
}

function unavailableMetric(id, reason, warnings = [], details = null) {
  return metric(id, null, {
    availability: "unavailable",
    precision: "unavailable",
    warnings: [reason, ...warnings],
    details,
  });
}

function periodMembership(value, period) {
  const instant = parseInstant(value);
  return Boolean(instant && containsTimestamp(instant, period));
}

function changeInstant(change) {
  return (
    parseInstant(change?.source_event_at) ||
    parseInstant(change?.observed_at) ||
    parseInstant(change?.first_observed_at)
  );
}

function mapSnapshotToClaim(snapshot, manifest, timeZone) {
  const asOfDate = manifestReferenceDate(manifest, timeZone);
  const movementAge =
    snapshot?.movement_date && asOfDate
      ? calendarDaysBetween(snapshot.movement_date, asOfDate)
      : null;
  return {
    id: snapshotReference(snapshot),
    claim_id: snapshot?.claim_id ?? null,
    identity_key: snapshot?.identity_key ?? null,
    sourceClaimNumber: snapshot?.source_claim_number ?? null,
    status: snapshot?.status_raw ?? snapshot?.status_normalized ?? null,
    registeredDate: snapshot?.registered_date ?? null,
    dolDate: snapshot?.dol_date ?? null,
    movementDate: snapshot?.movement_date ?? null,
    repudiationDate: snapshot?.repudiation_date ?? null,
    sourceEventAt: snapshot?.source_event_at ?? null,
    outstanding: snapshot?.outstanding ?? null,
    estimate: snapshot?.estimate ?? null,
    paid: snapshot?.paid ?? null,
    mandate: snapshot?.mandate ?? null,
    workingAge: snapshot?.working_age ?? null,
    calendarAge: snapshot?.calendar_age ?? null,
    daysSinceMovement: movementAge,
    handlerSource: snapshot?.handler_source ?? null,
    handlerEmail: snapshot?.handler_email ?? null,
    resolvedScoutUserId: snapshot?.resolved_scout_user_id ?? null,
    handlerResolution: snapshot?.handler_resolution ?? "unassigned",
    terminal: Boolean(snapshot?.terminal),
    open: Boolean(snapshot?.open),
    statusNormalized: snapshot?.status_normalized ?? null,
    insurer: snapshot?.insurer ?? null,
    peril: snapshot?.peril ?? null,
    perilType: snapshot?.peril_type ?? null,
    insured: snapshot?.insured ?? null,
    description: snapshot?.description ?? null,
    comments: snapshot?.comments ?? null,
    dataQualityFlags: asArray(snapshot?.data_quality_flags),
    sourceEvidence: snapshot?.source_evidence ?? null,
    snapshotExtractId: manifest?.id ?? null,
    snapshotEffectiveDate: asOfDate,
  };
}

function extractIdsOf(snapshotsByExtract) {
  return snapshotsByExtract instanceof Map
    ? [...snapshotsByExtract.keys()]
    : Object.keys(asObject(snapshotsByExtract));
}

/**
 * LONGITUDINAL canonical-parent resolution. Canonical parenthood must never be
 * decided from a single extract: the pre-MS2 normalizer marked a row matchable
 * whenever its claim number was not duplicated IN THAT EXTRACT, so a legitimate
 * ambiguous lineage with changing cardinality (2 -> 1 -> 2) can present a
 * MATCHABLE singleton in the middle extract. That singleton's UUID must not be
 * promoted to parent identity.
 *
 * Aggregating every authoritative row for a logical parent_identity_key, a
 * canonical UUID is affirmed ONLY when, across the whole lineage: no row was
 * ever non-matchable, and exactly one distinct claim_id was ever observed
 * (the parent-aware persistence model's shared UUID). Any legacy ambiguity -
 * a non-matchable row anywhere, or more than one historical UUID - forces the
 * parent to the stable parent_identity_key with claim_id NULL.
 *
 * Returns Map<parent_identity_key, canonicalUuid | null>.
 */
function buildParentCanonicalIndex(snapshotsByExtract, authoritativeIds) {
  const agg = new Map();
  for (const extractId of extractIdsOf(snapshotsByExtract)) {
    if (authoritativeIds && !authoritativeIds.has(extractId)) continue;
    for (const row of snapshotsForExtract(snapshotsByExtract, extractId)) {
      const key = parentIdentityKey(row);
      if (!key) continue;
      let entry = agg.get(key);
      if (!entry) {
        entry = { claimIds: new Set(), anyNonMatchable: false };
        agg.set(key, entry);
      }
      if (row?.identity_matchable === true && row?.identity_key) {
        if (row.claim_id) entry.claimIds.add(String(row.claim_id));
      } else {
        entry.anyNonMatchable = true;
      }
    }
  }
  const canonical = new Map();
  for (const [key, entry] of agg) {
    canonical.set(
      key,
      !entry.anyNonMatchable && entry.claimIds.size === 1
        ? [...entry.claimIds][0]
        : null,
    );
  }
  return canonical;
}

// Longitudinal canonical UUID for a parent projection, resolved from the whole
// lineage (canonicalByKey). Falls back to a conservative per-projection check
// only when no lineage index is supplied.
function parentCanonicalClaimId(parent, canonicalByKey) {
  if (canonicalByKey) return canonicalByKey.get(parent.parent_identity_key) ?? null;
  const rows = parent.rows || [];
  if (rows.length === 0) return null;
  const allMatchable = rows.every(
    (row) => row?.identity_matchable === true && Boolean(row?.identity_key),
  );
  if (!allMatchable) return null;
  const ids = new Set(rows.map((row) => row?.claim_id).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

// Deterministic metric-population identity: the longitudinal canonical claim
// UUID when one is affirmed, else the stable logical parent identity key (so a
// parent with a NULL claim_id is never dropped and never borrows a child UUID).
function parentReferenceId(parent, canonicalByKey) {
  return (
    parentCanonicalClaimId(parent, canonicalByKey) ?? parent.parent_identity_key
  );
}

// Map every authoritative historical child claim_id to its stable logical-parent
// reference id, using the SAME longitudinal resolution, so evidence keyed by a
// raw child UUID normalizes into the parent identity domain for deduplication.
// Deterministic regardless of snapshotsByExtract iteration order because the
// canonical index is aggregated over all extracts first.
function buildParentRefIndex(snapshotsByExtract, authoritativeIds, canonicalByKey) {
  const index = new Map();
  for (const extractId of extractIdsOf(snapshotsByExtract)) {
    if (authoritativeIds && !authoritativeIds.has(extractId)) continue;
    for (const row of snapshotsForExtract(snapshotsByExtract, extractId)) {
      const key = parentIdentityKey(row);
      if (!key || !row?.claim_id) continue;
      index.set(String(row.claim_id), canonicalByKey.get(key) ?? key);
    }
  }
  return index;
}

// AS-OF authoritative scope: the authoritative manifest ids whose observation
// instant is at or before a reporting boundary. Canonical parent identity for a
// report must be resolved from history <= the report's closing boundary only, so
// a FUTURE authoritative extract (after the period) can never retroactively
// change an earlier report's parent reference or claim_id. All earlier history -
// pre-period baseline and older ambiguity evidence - is retained, which the
// legacy 2 -> 1 singleton-trap detection depends on. Because the closing
// boundary extract is the latest authoritative extract at/before period.end,
// bounding by period.end selects exactly the same authoritative extracts as
// bounding by the selected closing extract's instant.
function authoritativeIdsAsOf(manifests, boundaryInstant, timeZone, scope) {
  return new Set(
    authoritativeManifestModel(manifests, scope)
      .authoritative.filter((manifest) => {
        const instant = manifestInstant(manifest, timeZone);
        return instant && instant.getTime() <= boundaryInstant.getTime();
      })
      .map((manifest) => manifest.id),
  );
}

// True when an authoritative extract exists strictly before the period start -
// the comparison baseline first-observed derivation needs for the first
// in-period extract.
function hasPrePeriodBaseline(manifests, period, timeZone, scope) {
  return authoritativeManifestModel(manifests, scope)
    .authoritative.filter((manifest) => manifestInstant(manifest, timeZone))
    .some(
      (manifest) =>
        manifestInstant(manifest, timeZone).getTime() < period.start.getTime(),
    );
}

function consensusScalar(parent, field) {
  const { status, value } = consensusValue(parent.rows, field);
  return status === "disagree" || status === "all_missing" ? null : value;
}

/**
 * Project one logical parent claim into the claim shape the metric functions
 * consume. A single-row parent maps exactly as the pre-MS2 row did (same id,
 * same scalars) so existing single-row reporting is unchanged. A multi-row
 * parent counts once, rolls its state up conservatively, exposes only
 * consensus scalars, and leaves financial fields null (aggregation unresolved).
 */
function mapParentToClaim(parent, manifest, timeZone, canonicalByKey) {
  if (parent.row_count === 1) {
    const claim = mapSnapshotToClaim(parent.rows[0], manifest, timeZone);
    claim.id = parentReferenceId(parent, canonicalByKey);
    claim.parent_identity_key = parent.parent_identity_key;
    claim.canonical_claim_id = parentCanonicalClaimId(parent, canonicalByKey);
    claim.rowCount = 1;
    claim.multiRow = false;
    claim.identityQuality = parent.identity_quality;
    claim.parentQualityFlags = parent.quality_flags;
    return claim;
  }
  const asOfDate = manifestReferenceDate(manifest, timeZone);
  const registeredDate = consensusScalar(parent, "registered_date");
  const movementDate = consensusScalar(parent, "movement_date");
  const calendarAge =
    registeredDate && asOfDate
      ? calendarDaysBetween(registeredDate, asOfDate)
      : null;
  return {
    id: parentReferenceId(parent, canonicalByKey),
    claim_id: parentCanonicalClaimId(parent, canonicalByKey),
    parent_identity_key: parent.parent_identity_key,
    canonical_claim_id: parentCanonicalClaimId(parent, canonicalByKey),
    identity_key: parent.parent_identity_key,
    sourceClaimNumber: parent.source_claim_number,
    open: parent.lifecycle_state === "open",
    terminal: parent.lifecycle_state === "terminal",
    stateResolution: parent.state_resolution,
    statusNormalized: consensusScalar(parent, "status_normalized"),
    registeredDate,
    dolDate: consensusScalar(parent, "dol_date"),
    movementDate,
    calendarAge,
    workingAge: null,
    daysSinceMovement:
      movementDate && asOfDate
        ? calendarDaysBetween(movementDate, asOfDate)
        : null,
    // Financial aggregation semantics are unproven for multi-row parents:
    // never sum/max/first - leave null and let the metric fail closed.
    outstanding: null,
    estimate: null,
    paid: null,
    mandate: null,
    handlerSource: consensusScalar(parent, "handler_source"),
    handlerEmail: consensusScalar(parent, "handler_email"),
    resolvedScoutUserId: consensusScalar(parent, "resolved_scout_user_id"),
    handlerResolution: "unassigned",
    insurer: consensusScalar(parent, "insurer"),
    insured: consensusScalar(parent, "insured"),
    dataQualityFlags: parent.quality_flags,
    snapshotExtractId: manifest?.id ?? null,
    snapshotEffectiveDate: asOfDate,
    rowCount: parent.row_count,
    multiRow: true,
    identityQuality: parent.identity_quality,
    parentQualityFlags: parent.quality_flags,
  };
}

function parentClaimsForExtract(snapshots, manifest, timeZone, canonicalByKey) {
  return groupSnapshotsByParent(snapshots).map((parent) =>
    mapParentToClaim(parent, manifest, timeZone, canonicalByKey),
  );
}

// Open multi-row parents whose aggregation semantics remain unresolved - the
// population that forces financial and C-metrics to fail closed.
function unresolvedMultiRowParents(rows) {
  return asArray(rows).filter((claim) => claim.multiRow && claim.open);
}

function excludedParentNumbers(parents) {
  return [
    ...new Set(
      parents
        .map((claim) => claim.sourceClaimNumber ?? claim.parent_identity_key)
        .filter(Boolean),
    ),
  ].sort();
}

function evaluateSnapshotClaim(claim) {
  try {
    return evaluateClaim(claim, { asOfDate: claim.snapshotEffectiveDate });
  } catch {
    return evaluateClaim(claim, {
      asOfDate: claim.snapshotEffectiveDate,
      onUnsupported: "return",
    });
  }
}

function closingState(
  openingSelection,
  closingSelection,
  snapshotsByExtract,
  timeZone,
  canonicalByKey,
) {
  const openingRows = openingSelection.manifest
    ? parentClaimsForExtract(
        snapshotsForExtract(snapshotsByExtract, openingSelection.manifest.id),
        openingSelection.manifest,
        timeZone,
        canonicalByKey,
      )
    : [];
  const closingRows = closingSelection.manifest
    ? parentClaimsForExtract(
        snapshotsForExtract(snapshotsByExtract, closingSelection.manifest.id),
        closingSelection.manifest,
        timeZone,
        canonicalByKey,
      )
    : [];
  return {
    openingRows,
    closingRows,
    openingById: new Map(openingRows.map((claim) => [claim.id, claim])),
    closingById: new Map(closingRows.map((claim) => [claim.id, claim])),
  };
}

function openClaims(rows) {
  return rows.filter((claim) => claim.open && !claim.terminal);
}

function claimEvaluation(claim) {
  return evaluateSnapshotClaim(claim);
}

function sourceDateRegistrationMetric(rows, period, evidence) {
  const matchable = rows.filter((claim) => claim.id);
  const withDate = matchable.filter((claim) => claim.registeredDate);
  if (withDate.length === 0)
    return unavailableMetric(
      "new_claims_registered",
      "registration_date_unavailable",
    );
  const ids = withDate
    .filter(
      (claim) =>
        claim.registeredDate >= period.startLocalDate &&
        claim.registeredDate < period.endLocalDateExclusive,
    )
    .map((claim) => claim.id);
  const warnings =
    withDate.length < matchable.length ? ["unknown_registration_dates"] : [];
  return metric("new_claims_registered", ids.length, {
    precision: "source_date",
    claimIds: ids,
    warnings,
    evidence: { ...evidence, source_field: "registered_date" },
  });
}

// First-observed is derived from parent PRESENCE across the authoritative
// extract chain (parent absent -> present), never from legacy row-era stored
// first_observed change rows. Unavailable when no authoritative adjacent pair
// exists to compare (single extract, no prior-period baseline).
function firstObservedMetric(
  lifecycleEvents,
  registeredIds,
  evidence,
  comparable,
) {
  if (!comparable) {
    return unavailableMetric(
      "new_claims_first_observed",
      "first_observed_history_unavailable",
    );
  }
  const ids = new Set();
  for (const event of lifecycleEvents) {
    if (
      event.type === "first_observed" &&
      event.claim_ref &&
      !registeredIds.has(String(event.claim_ref))
    ) {
      ids.add(String(event.claim_ref));
    }
  }
  return metric("new_claims_first_observed", ids.size, {
    precision: "observed_period",
    claimIds: [...ids],
    evidence: {
      ...evidence,
      change_type: "first_observed",
      derivation: "parent_presence",
    },
  });
}

// Closure counts (a) exact source-explicit closure events from stored changes
// and (b) deterministic parent open->terminal transitions DERIVED from the
// authoritative chain. A parent merely disappearing (missing_from_extract) is
// never a closure.
function closureMetrics(
  changes,
  lifecycleEvents,
  period,
  evidence,
  parentRefFor,
) {
  const exact = new Set();
  const observed = new Set();
  const exactTypes = new Set([
    "closure_event",
    "claim_closed",
    "terminal_transition",
  ]);
  // Both closure streams must dedupe in the SAME logical-parent identity domain.
  // Stored exact evidence is keyed by a scout_history_claims UUID (a per-row
  // CHILD UUID for old ambiguous lineage); derived evidence is keyed by the
  // logical parent reference. Normalize the exact side to the logical parent so
  // a single claim closed with both source-exact and observed evidence is
  // counted once, never promoting an arbitrary child UUID.
  const toParentRef =
    typeof parentRefFor === "function" ? parentRefFor : (id) => id;
  for (const change of changes) {
    if (!periodMembership(changeInstant(change), period) || !change?.claim_id)
      continue;
    if (
      exactTypes.has(change.change_type) &&
      change.source_event_at &&
      change.provenance === "source_explicit"
    ) {
      exact.add(String(toParentRef(String(change.claim_id))));
    }
  }
  for (const event of lifecycleEvents) {
    if (event.type === "terminal_transition_observed" && event.claim_ref) {
      observed.add(String(event.claim_ref));
    }
  }
  const combined = new Set([...exact, ...observed]);
  return {
    closed: metric("claims_closed", combined.size, {
      precision:
        exact.size && observed.size
          ? "mixed"
          : exact.size
            ? "source_exact"
            : "observed_period",
      claimIds: [...combined],
      warnings: exact.size
        ? []
        : ["exact_closure_event_timestamps_unavailable"],
      evidence: {
        ...evidence,
        exact_source_count: exact.size,
        observed_transition_count: observed.size,
      },
      details: {
        exact_source_count: exact.size,
        observed_terminal_transition_count: observed.size,
      },
    }),
    exact: exact.size
      ? metric("claims_closed_exact", exact.size, {
          precision: "source_exact",
          claimIds: [...exact],
          evidence,
        })
      : unavailableMetric(
          "claims_closed_exact",
          "exact_closure_events_unavailable",
        ),
    observed: metric("claims_closed_observed", observed.size, {
      precision: "observed_period",
      claimIds: [...observed],
      evidence,
    }),
  };
}

function ageingMetric(closingOpen, evidence) {
  const bands = {
    "0-30": [],
    "31-60": [],
    "61-90": [],
    "91+": [],
    unknown: [],
  };
  for (const claim of closingOpen) {
    const band = calendarAgeBand(claim.calendarAge);
    bands[band || "unknown"].push(claim.id);
  }
  const value = Object.fromEntries(
    Object.entries(bands).map(([band, ids]) => [band, ids.length]),
  );
  const claimIds = Object.values(bands).flat();
  const sixtyPlus = closingOpen
    .filter(
      (claim) => claim.calendarAge !== null && Number(claim.calendarAge) >= 60,
    )
    .map((claim) => claim.id);
  return {
    distribution: metric("ageing_distribution", value, {
      precision: "snapshot_exact",
      claimIds,
      evidence,
      details: { claim_ids_by_band: bands },
    }),
    sixtyPlus: metric("open_claims_60_plus", sixtyPlus.length, {
      precision: "snapshot_exact",
      claimIds: sixtyPlus,
      evidence,
    }),
    ninetyOnePlus: metric("open_claims_91_plus", bands["91+"].length, {
      precision: "snapshot_exact",
      claimIds: bands["91+"],
      evidence,
    }),
  };
}

function slaMetrics(closingOpen, evidence) {
  const compliant = [];
  const breached = [];
  const unmapped = [];
  const unknown = [];
  for (const claim of closingOpen) {
    const result = evaluateSla(claim, {
      asOfDate: claim.snapshotEffectiveDate,
      onUnsupported: "return",
    });
    if (result.compliant) compliant.push(claim.id);
    else if (result.breached) breached.push(claim.id);
    else if (result.state === "unmapped") unmapped.push(claim.id);
    else unknown.push(claim.id);
  }
  const denominator = compliant.length + breached.length;
  const warnings = [];
  if (unmapped.length)
    warnings.push("unmapped_statuses_excluded_from_denominator");
  if (unknown.length) warnings.push("working_age_or_sla_mapping_unavailable");
  const details = {
    compliant: compliant.length,
    breached: breached.length,
    unmapped: unmapped.length,
    unknown: unknown.length,
    total_evaluated: closingOpen.length,
    denominator,
    claim_ids_by_class: { compliant, breached, unmapped, unknown },
  };
  return {
    compliance: metric(
      "sla_compliance",
      denominator ? compliant.length / denominator : null,
      {
        precision: denominator ? "snapshot_exact" : "unavailable",
        availability: denominator ? "available" : "unavailable",
        claimIds: compliant,
        warnings: denominator
          ? warnings
          : ["sla_denominator_zero", ...warnings],
        evidence,
        details,
      },
    ),
    breaches: metric("sla_breaches", breached.length, {
      precision: "snapshot_exact",
      claimIds: breached,
      warnings,
      evidence,
      details,
    }),
    summary: details,
  };
}

function movementMetrics(closingOpen, evidence) {
  const over14 = [];
  const over30 = [];
  const unknown = [];
  for (const claim of closingOpen) {
    const result = evaluateMovement(claim, {
      asOfDate: claim.snapshotEffectiveDate,
    });
    if (result.over30) over30.push(claim.id);
    else if (result.over14) over14.push(claim.id);
    else if (result.daysSinceMovement === null) unknown.push(claim.id);
  }
  const warnings = unknown.length ? ["movement_date_unavailable"] : [];
  return {
    over14: metric("no_movement_over_14", over14.length + over30.length, {
      precision: "snapshot_exact",
      claimIds: [...over14, ...over30],
      warnings,
      evidence,
      details: {
        strict_over_14_claim_ids: over14,
        over_30_claim_ids: over30,
        unknown_claim_ids: unknown,
      },
    }),
    over30: metric("no_movement_over_30", over30.length, {
      precision: "snapshot_exact",
      claimIds: over30,
      warnings,
      evidence,
      details: { unknown_claim_ids: unknown },
    }),
  };
}

function readyAndAnomalyMetrics(closingOpen, evidence) {
  const readyIds = [];
  const byReason = {};
  const zeroEstimate = [];
  for (const claim of closingOpen) {
    const ready = getReadyToCloseCandidate(claim);
    if (ready) {
      readyIds.push(claim.id);
      byReason[ready.code] = byReason[ready.code] || [];
      byReason[ready.code].push(claim.id);
    }
    const evaluation = claimEvaluation(claim);
    if (evaluation.zeroEstimateAnomaly) zeroEstimate.push(claim.id);
  }
  return {
    ready: metric("ready_to_close", readyIds.length, {
      precision: "snapshot_exact",
      claimIds: readyIds,
      evidence,
      details: {
        claim_ids_by_reason: byReason,
        count_by_reason: Object.fromEntries(
          Object.entries(byReason).map(([key, ids]) => [key, ids.length]),
        ),
      },
    }),
    zeroEstimate: metric("zero_estimate_payment_request", zeroEstimate.length, {
      precision: "snapshot_exact",
      claimIds: zeroEstimate,
      evidence,
    }),
  };
}

function operationalHealthMetric(closingOpen, evidence) {
  const categories = {
    assessor_overdue: [],
    investigator_overdue: [],
    broker_overdue: [],
    high_value_mandate_attention: [],
    legal_recovery: [],
    nfo_ombudsman: [],
    fraud: [],
    repudiation_expired: [],
  };
  for (const claim of closingOpen) {
    const operational = evaluateOperationalCategories(claim);
    const risk = evaluateMandateAndRisk(claim);
    if (operational.assessorOverdue) categories.assessor_overdue.push(claim.id);
    if (operational.investigatorOverdue)
      categories.investigator_overdue.push(claim.id);
    if (operational.brokerOverdue) categories.broker_overdue.push(claim.id);
    if (risk.highValue || risk.mandate)
      categories.high_value_mandate_attention.push(claim.id);
    if (operational.legalRecovery) categories.legal_recovery.push(claim.id);
    if (operational.nfoOmbudsman || risk.nfoOrOmbudsman)
      categories.nfo_ombudsman.push(claim.id);
    if (operational.fraud || risk.fraud) categories.fraud.push(claim.id);
    if (operational.repudiationExpired)
      categories.repudiation_expired.push(claim.id);
  }
  const value = Object.fromEntries(
    Object.entries(categories).map(([key, ids]) => [key, ids.length]),
  );
  return metric("operational_health", value, {
    precision: "snapshot_exact",
    claimIds: Object.values(categories).flat(),
    evidence,
    details: { claim_ids_by_category: categories },
  });
}

function financialMetrics(closingOpen, evidence) {
  const fields = [
    ["financial_open_outstanding", "outstanding", "open_outstanding_exposure"],
    ["financial_estimate_total", "estimate", "estimate_total"],
    ["financial_paid_total", "paid", "paid_total"],
  ];
  const metrics = {};
  // Each financial field fails closed independently when any open multi-row
  // parent has unresolved aggregation semantics. The single-row subtotal is a
  // diagnostic only - it is NEVER published as the metric value, because
  // identical child values do not prove additive-vs-repeated semantics.
  const unresolved = unresolvedMultiRowParents(closingOpen);
  const singleRow = closingOpen.filter((claim) => !claim.multiRow);
  const excludedNumbers = excludedParentNumbers(unresolved);
  for (const [id, field, definition] of fields) {
    if (unresolved.length > 0) {
      const knownSingleRow = singleRow.filter(
        (claim) =>
          claim[field] !== null &&
          claim[field] !== undefined &&
          Number.isFinite(Number(claim[field])),
      );
      metrics[id] = unavailableMetric(
        id,
        "financial_aggregation_unresolved",
        [],
        {
          reason: "financial_aggregation_unresolved",
          definition,
          unresolved_parent_count: unresolved.length,
          unresolved_claim_numbers: excludedNumbers,
          known_single_row_subtotal: knownSingleRow.reduce(
            (sum, claim) => sum + Number(claim[field]),
            0,
          ),
        },
      );
      continue;
    }
    const known = closingOpen.filter(
      (claim) =>
        claim[field] !== null &&
        claim[field] !== undefined &&
        Number.isFinite(Number(claim[field])),
    );
    const warnings =
      known.length < closingOpen.length ? ["financial_value_missing"] : [];
    metrics[id] = metric(
      id,
      known.reduce((sum, claim) => sum + Number(claim[field]), 0),
      {
        precision: "snapshot_exact",
        claimIds: closingOpen.map((claim) => claim.id),
        warnings,
        definition,
        evidence,
        details: {
          known_value_claim_count: known.length,
          total_open_claim_count: closingOpen.length,
        },
      },
    );
  }
  metrics.payment_requested_events = unavailableMetric(
    "payment_requested_events",
    "payment_event_semantics_unavailable",
  );
  metrics.payment_released_events = unavailableMetric(
    "payment_released_events",
    "payment_event_semantics_unavailable",
  );
  return metrics;
}

function handlerKey(user) {
  return user?.id !== null && user?.id !== undefined
    ? String(user.id)
    : user?.email || null;
}

function handlerMetricValue(claims, activeUsers, evidence, changes = []) {
  const users = resolveActiveScoutUsers(activeUsers).sort((left, right) =>
    String(left.displayName || left.email || "").localeCompare(
      String(right.displayName || right.email || ""),
    ),
  );
  const handlers = users.filter((user) => user.role === "handler");
  const usersByKey = new Map(users.map((user) => [handlerKey(user), user]));
  const activityByUser = new Map();
  for (const change of changes) {
    if (change.change_type !== "handler_changed") continue;
    const oldKey =
      change.old_value?.user_id ??
      change.old_value?.email ??
      change.old_value?.handler;
    const newKey =
      change.new_value?.user_id ??
      change.new_value?.email ??
      change.new_value?.handler;
    if (oldKey) {
      const value = activityByUser.get(String(oldKey)) || { in: [], out: [] };
      value.out.push(String(change.claim_id));
      activityByUser.set(String(oldKey), value);
    }
    if (newKey) {
      const value = activityByUser.get(String(newKey)) || { in: [], out: [] };
      value.in.push(String(change.claim_id));
      activityByUser.set(String(newKey), value);
    }
  }
  const rows = handlers.map((handler) => {
    const key = handlerKey(handler);
    const owned = claims.filter(
      (claim) => String(claim.resolvedScoutUserId ?? "") === String(key),
    );
    const open = owned.filter((claim) => claim.open && !claim.terminal);
    const evaluated = open.map((claim) => ({
      claim,
      result: evaluateSla(claim, {
        asOfDate: claim.snapshotEffectiveDate,
        onUnsupported: "return",
      }),
    }));
    const movement = movementMetrics(open, evidence);
    const ready = readyAndAnomalyMetrics(open, evidence);
    const operational = evaluateOperationalCategories;
    const assessor = open
      .filter((claim) => operational(claim).assessorOverdue)
      .map((claim) => claim.id);
    const investigator = open
      .filter((claim) => operational(claim).investigatorOverdue)
      .map((claim) => claim.id);
    const broker = open
      .filter((claim) => operational(claim).brokerOverdue)
      .map((claim) => claim.id);
    const sixty = open
      .filter((claim) => Number(claim.calendarAge) >= 60)
      .map((claim) => claim.id);
    const ninetyOne = open
      .filter((claim) => Number(claim.calendarAge) >= 91)
      .map((claim) => claim.id);
    const breaches = evaluated
      .filter(({ result }) => result.breached)
      .map(({ claim }) => claim.id);
    const activity = activityByUser.get(String(key)) || { in: [], out: [] };
    return {
      handler_id: handler.id ?? null,
      handler_email: handler.email,
      handler_name: handler.displayName || handler.email,
      open_claims: open.length,
      open_claim_ids: open.map((claim) => claim.id),
      claims_60_plus: sixty.length,
      claims_60_plus_ids: sixty,
      claims_91_plus: ninetyOne.length,
      claims_91_plus_ids: ninetyOne,
      sla_breaches: breaches.length,
      sla_breach_ids: breaches,
      no_movement_over_14: movement.over14.value,
      no_movement_over_14_ids: movement.over14.claim_population.claim_ids,
      no_movement_over_30: movement.over30.value,
      no_movement_over_30_ids: movement.over30.claim_population.claim_ids,
      ready_to_close: ready.ready.value,
      ready_to_close_ids: ready.ready.claim_population.claim_ids,
      assessor_overdue: assessor.length,
      assessor_overdue_ids: assessor,
      investigator_overdue: investigator.length,
      investigator_overdue_ids: investigator,
      broker_overdue: broker.length,
      broker_overdue_ids: broker,
      reassignments_in: new Set(activity.in).size,
      reassignments_in_ids: [...new Set(activity.in)],
      reassignments_out: new Set(activity.out).size,
      reassignments_out_ids: [...new Set(activity.out)],
    };
  });
  const managerHeld = claims.filter((claim) => {
    const user = usersByKey.get(String(claim.resolvedScoutUserId ?? ""));
    return user && ["manager", "admin"].includes(user.role);
  });
  const unresolved = claims.filter((claim) => {
    const user = usersByKey.get(String(claim.resolvedScoutUserId ?? ""));
    return !user || user.role === "unknown";
  });
  return {
    handlers: rows,
    manager_held_other: {
      count: managerHeld.length,
      claim_ids: managerHeld.map((claim) => claim.id),
    },
    unassigned_unresolved: {
      count: unresolved.length,
      claim_ids: unresolved.map((claim) => claim.id),
    },
    active_handler_count: handlers.length,
  };
}

function assignmentActivity(changes, period, evidence) {
  const reassignmentsIn = new Set();
  const reassignmentsOut = new Set();
  const assignmentObserved = new Set();
  for (const change of changes) {
    if (
      change.change_type !== "handler_changed" ||
      !periodMembership(changeInstant(change), period)
    )
      continue;
    if (!change.claim_id) continue;
    assignmentObserved.add(String(change.claim_id));
    const oldEmail = change.old_value?.email || null;
    const newEmail = change.new_value?.email || null;
    if (oldEmail) reassignmentsOut.add(String(change.claim_id));
    if (newEmail) reassignmentsIn.add(String(change.claim_id));
  }
  return metric("assignment_activity", assignmentObserved.size, {
    precision: assignmentObserved.size ? "observed_period" : "unavailable",
    availability: assignmentObserved.size ? "available" : "unavailable",
    claimIds: [...assignmentObserved],
    warnings: assignmentObserved.size ? [] : ["assignment_history_unavailable"],
    evidence,
    details: {
      reassignments_in: reassignmentsIn.size,
      reassignments_in_claim_ids: [...reassignmentsIn],
      reassignments_out: reassignmentsOut.size,
      reassignments_out_claim_ids: [...reassignmentsOut],
    },
  });
}

function qualityWarnings(manifests) {
  const warnings = new Set();
  for (const manifest of manifests) {
    const quality = asObject(manifest.quality_summary);
    for (const warning of asArray(quality.warnings)) warnings.add(warning);
    if (quality.unmapped_status_count > 0) warnings.add("unmapped_statuses");
    if (quality.unknown_handler_count > 0) warnings.add("unresolved_handlers");
    if (quality.identity_ambiguity_count > 0)
      warnings.add("identity_ambiguity");
  }
  return [...warnings];
}

function coverageAssessment({
  period,
  manifests,
  openingSelection,
  closingSelection,
  timeZone,
  requestedScope,
}) {
  const accepted = asArray(manifests)
    .filter(
      (manifest) =>
        manifestIsAccepted(manifest) && scopeMatches(manifest, requestedScope),
    )
    .filter((manifest) =>
      periodMembership(manifestInstant(manifest, timeZone), period),
    );
  const warningExtracts = accepted.filter(
    (manifest) => manifest.status === "accepted_with_warnings",
  );
  const firstAccepted =
    [...accepted].sort((left, right) =>
      manifestSort(left, right, timeZone),
    )[0] || null;
  const lastAccepted =
    [...accepted].sort((left, right) =>
      manifestSort(right, left, timeZone),
    )[0] || null;
  const warnings = qualityWarnings(
    [...accepted, openingSelection.manifest, closingSelection.manifest].filter(
      Boolean,
    ),
  );
  if (!openingSelection.manifest) warnings.push("no_opening_snapshot");
  if (!closingSelection.manifest) warnings.push("no_closing_snapshot");
  warnings.push(
    "missing_expected_coverage_not_identifiable_without_cadence_contract",
  );
  warnings.push("payment_activity_unavailable_without_source_event_semantics");
  const status = !closingSelection.manifest
    ? "insufficient"
    : !openingSelection.manifest
      ? "partial"
      : warningExtracts.length ||
          warnings.some(
            (warning) =>
              warning !==
                "missing_expected_coverage_not_identifiable_without_cadence_contract" &&
              warning !==
                "payment_activity_unavailable_without_source_event_semantics",
          )
        ? "usable_with_warnings"
        : "complete";
  const earliest = [...asArray(manifests)]
    .filter(
      (manifest) =>
        manifestIsAccepted(manifest) && scopeMatches(manifest, requestedScope),
    )
    .sort((left, right) => manifestSort(left, right, timeZone))[0];
  return {
    status,
    requested_period_start: period.start.toISOString(),
    requested_period_end: period.end.toISOString(),
    requested_period_start_local_date: period.startLocalDate,
    requested_period_end_local_date: period.endLocalDateExclusive,
    timezone: timeZone,
    opening_extract_id: openingSelection.manifest?.id ?? null,
    closing_extract_id: closingSelection.manifest?.id ?? null,
    first_accepted_extract_in_period: firstAccepted?.id ?? null,
    last_accepted_extract_in_period: lastAccepted?.id ?? null,
    accepted_extract_count: accepted.length,
    warning_quality_extract_count: warningExtracts.length,
    missing_expected_coverage: [],
    missing_expected_coverage_identifiable: false,
    source_scope: requestedScope?.portfolio_scope ?? null,
    historical_capability_start_date: manifestReferenceDate(earliest, timeZone),
    warnings: [...new Set(warnings)],
    opening_selection_reason: openingSelection.reason,
    closing_selection_reason: closingSelection.reason,
    opening_selection_precision: openingSelection.precision,
    closing_selection_precision: closingSelection.precision,
  };
}

function comparisonForMetrics(currentMetrics, previousSnapshot) {
  const previousMetrics = asObject(previousSnapshot?.metrics);
  const comparison = {};
  for (const [id, current] of Object.entries(currentMetrics)) {
    if (!current || typeof current.value !== "number") continue;
    const previous = previousMetrics[id];
    const previousValue =
      previous && typeof previous.value === "number" ? previous.value : null;
    const delta = previousValue === null ? null : current.value - previousValue;
    comparison[id] = {
      current: current.value,
      previous: previousValue,
      absolute_delta: delta,
      percentage_delta:
        previousValue === null || previousValue === 0
          ? null
          : delta / Math.abs(previousValue),
      direction:
        delta === null
          ? "unavailable"
          : delta === 0
            ? "flat"
            : delta > 0
              ? "increase"
              : "decrease",
    };
  }
  return comparison;
}

function buildReportClaimRows(
  metrics,
  snapshotsByExtract,
  manifests,
  timeZone,
  preferredExtractId = null,
  authoritativeManifestIds = null,
  canonicalByKey = null,
) {
  const membership = new Map();
  for (const [metricId, value] of Object.entries(metrics)) {
    for (const claimId of value?.claim_population?.claim_ids || []) {
      const entry = membership.get(String(claimId)) || {
        metric_ids: [],
        membership_reasons: {},
      };
      if (!entry.metric_ids.includes(metricId)) entry.metric_ids.push(metricId);
      entry.membership_reasons[metricId] = value.definition || metricId;
      membership.set(String(claimId), entry);
    }
    if (value?.details?.claim_ids_by_band) {
      for (const [band, ids] of Object.entries(
        value.details.claim_ids_by_band,
      )) {
        for (const claimId of ids) {
          const entry = membership.get(String(claimId)) || {
            metric_ids: [],
            membership_reasons: {},
          };
          if (!entry.metric_ids.includes(metricId))
            entry.metric_ids.push(metricId);
          entry.membership_reasons[metricId] = band;
          membership.set(String(claimId), entry);
        }
      }
    }
  }
  const isAuthoritativeSnapshot = (snapshot) =>
    !authoritativeManifestIds ||
    authoritativeManifestIds.has(snapshot?.extract_id);
  const manifestsById = new Map(
    asArray(manifests).map((manifest) => [manifest.id, manifest]),
  );
  // Index logical parent projections by their metric-population reference id.
  // Parents are extract-scoped, so group per extract (preferred extract first
  // so the closing snapshot wins), never across extracts.
  const parentByRef = new Map();
  const indexExtract = (extractId) => {
    if (!extractId) return;
    const manifest = manifestsById.get(extractId) || null;
    const snaps = snapshotsForExtract(snapshotsByExtract, extractId).filter(
      isAuthoritativeSnapshot,
    );
    for (const parent of groupSnapshotsByParent(snaps)) {
      const ref = String(parentReferenceId(parent, canonicalByKey));
      if (!parentByRef.has(ref)) parentByRef.set(ref, { parent, manifest });
    }
  };
  indexExtract(preferredExtractId);
  for (const manifest of asArray(manifests)) indexExtract(manifest.id);

  return [...membership.entries()].map(([claimId, entry]) => {
    const found = parentByRef.get(claimId) || {};
    const parent = found.parent || null;
    const manifest = found.manifest || null;
    const isMultiRow = Boolean(parent && parent.row_count > 1);
    const singleRow = parent && parent.row_count === 1 ? parent.rows[0] : null;
    const claim =
      singleRow && manifest
        ? mapSnapshotToClaim(singleRow, manifest, timeZone)
        : null;
    const scalar = (field, singleValue) =>
      isMultiRow ? consensusScalar(parent, field) : singleValue;
    return {
      // Canonical parent UUID when one legitimately exists, else NULL (old
      // ambiguous multi-row parents). Never a child row UUID as the parent.
      claim_id: parent ? parentCanonicalClaimId(parent, canonicalByKey) : null,
      parent_identity_key: parent?.parent_identity_key ?? null,
      source_system: parent?.source_system ?? "cardinal_claims",
      source_claim_number: parent?.source_claim_number ?? null,
      identity_key: parent?.parent_identity_key ?? null,
      metric_ids: entry.metric_ids.sort(),
      membership_reasons: entry.membership_reasons,
      handler_snapshot: scalar("handler_source", claim?.handlerSource ?? null),
      handler_email_snapshot: scalar(
        "handler_email",
        claim?.handlerEmail ?? null,
      ),
      resolved_scout_user_id_snapshot: scalar(
        "resolved_scout_user_id",
        claim?.resolvedScoutUserId ?? null,
      ),
      status_snapshot: scalar(
        "status_normalized",
        claim?.statusNormalized ?? null,
      ),
      insurer_snapshot: scalar("insurer", claim?.insurer ?? null),
      peril_snapshot: isMultiRow ? null : (singleRow?.peril ?? null),
      registered_date_snapshot: scalar(
        "registered_date",
        claim?.registeredDate ?? null,
      ),
      calendar_age_snapshot: isMultiRow ? null : (claim?.calendarAge ?? null),
      working_age_snapshot: isMultiRow ? null : (claim?.workingAge ?? null),
      // Multi-row financial aggregation is unresolved: never copy or sum a
      // child row's money onto the parent - persist NULL.
      outstanding_snapshot: isMultiRow
        ? null
        : (singleRow?.outstanding ?? null),
      estimate_snapshot: isMultiRow ? null : (singleRow?.estimate ?? null),
      paid_snapshot: isMultiRow ? null : (singleRow?.paid ?? null),
      relevant_flags: {
        priority: singleRow?.priority_flags ?? [],
        operational: singleRow?.operational_flags ?? [],
        quality: singleRow?.data_quality_flags ?? [],
        row_count: parent?.row_count ?? 0,
        parent_quality_flags: parent?.quality_flags ?? [],
      },
    };
  });
}

function stateMetric(id, rows, extract, predicate, evidence, warnings = []) {
  if (!extract)
    return unavailableMetric(id, "boundary_snapshot_unavailable", warnings);
  const ids = rows.filter(predicate).map((claim) => claim.id);
  return metric(id, ids.length, {
    precision: "snapshot_exact",
    claimIds: ids,
    warnings,
    evidence: { ...evidence, extract_id: extract.id },
  });
}

function qualityConfiguration() {
  return {
    version: REPORTING_QUALITY_VERSION,
    history_schema_version: HISTORY_SCHEMA_VERSION,
    material_extract_row_drop_threshold: DEFAULT_MAX_ROW_COUNT_DROP_RATIO,
  };
}

/**
 * Build a complete deterministic report snapshot from immutable manifests,
 * snapshots, and observed changes. No current-state claims table is accepted
 * as an input. `previousSnapshot` is optional and is used only for comparison.
 */
export function buildReportSnapshot({
  reportType,
  periodStart,
  timeZone = BUSINESS_TIME_ZONE,
  manifests = [],
  snapshotsByExtract = new Map(),
  changes = [],
  activeUsers = [],
  scope = { kind: "team" },
  previousSnapshot = null,
  configurationWarnings = [],
} = {}) {
  const period = reportingPeriod(reportType, periodStart, timeZone);
  const authoritativeModel = authoritativeManifestModel(manifests, scope);
  const authoritativeManifests = authoritativeModel.authoritative;
  const openingSelection = selectBoundaryExtract(manifests, period.start, {
    timeZone,
    scope,
  });
  const closingSelection = selectBoundaryExtract(manifests, period.end, {
    timeZone,
    scope,
  });
  // Resolve canonical parenthood ONCE, LONGITUDINALLY, but AS-OF the report
  // closing boundary. The canonical index is built from authoritative history at
  // or before period.end only (which, because the closing extract is the latest
  // authoritative extract <= period.end, is exactly the lineage through the
  // selected closing extract) - never from authoritative extracts that arrived
  // AFTER this report's boundary. A future extract can therefore never rewrite
  // this report's parent reference or claim_id, while all earlier history
  // (pre-period baseline and older ambiguity) is retained for the 2 -> 1
  // singleton trap. Every downstream projection (closing state, period rows,
  // lifecycle refs, exact-closure ref normalization, report claim rows) shares
  // this single as-of index, so a logical parent resolves to the same stable
  // reference id everywhere, independent of map iteration order.
  const asOfAuthoritativeIds = authoritativeIdsAsOf(
    manifests,
    period.end,
    timeZone,
    scope,
  );
  const asOfAuthoritativeManifests = authoritativeManifests.filter((manifest) =>
    asOfAuthoritativeIds.has(manifest.id),
  );
  const canonicalByKey = buildParentCanonicalIndex(
    snapshotsByExtract,
    asOfAuthoritativeIds,
  );
  const state = closingState(
    openingSelection,
    closingSelection,
    snapshotsByExtract,
    timeZone,
    canonicalByKey,
  );
  const coverage = coverageAssessment({
    period,
    manifests: authoritativeManifests,
    openingSelection,
    closingSelection,
    timeZone,
    requestedScope: scope,
  });
  const openingOpen = openClaims(state.openingRows);
  const closingOpen = openClaims(state.closingRows);
  const openingEvidence = {
    evidence_type: "historical_snapshot",
    precision: openingSelection.precision,
    boundary: period.start.toISOString(),
  };
  const closingEvidence = {
    evidence_type: "historical_snapshot",
    precision: closingSelection.precision,
    boundary: period.end.toISOString(),
  };
  const periodChanges = asArray(changes).filter(
    (change) =>
      (!change?.source_extract_id ||
        authoritativeModel.authoritativeIds.has(change.source_extract_id)) &&
      periodMembership(changeInstant(change), period),
  );
  const metrics = {};
  metrics.opening_inventory = stateMetric(
    "opening_inventory",
    openingOpen,
    openingSelection.manifest,
    () => true,
    openingEvidence,
  );
  metrics.closing_inventory = stateMetric(
    "closing_inventory",
    closingOpen,
    closingSelection.manifest,
    () => true,
    closingEvidence,
  );
  metrics.net_inventory_movement =
    metrics.opening_inventory.availability === "available" &&
    metrics.closing_inventory.availability === "available"
      ? metric(
          "net_inventory_movement",
          metrics.closing_inventory.value - metrics.opening_inventory.value,
          {
            precision: "snapshot_exact",
            claimIds: [
              ...metrics.opening_inventory.claim_population.claim_ids,
              ...metrics.closing_inventory.claim_population.claim_ids,
            ],
            evidence: {
              ...closingEvidence,
              derivation: "closing_minus_opening",
            },
          },
        )
      : unavailableMetric(
          "net_inventory_movement",
          "opening_or_closing_snapshot_unavailable",
        );

  const periodRows = periodSnapshotRows(
    authoritativeManifests,
    snapshotsByExtract,
    period,
    timeZone,
    scope,
    canonicalByKey,
  );
  const registered = sourceDateRegistrationMetric(
    periodRows.length ? periodRows : state.closingRows,
    period,
    closingEvidence,
  );
  metrics.new_claims_registered = registered;
  const registeredIds = new Set(registered.claim_population.claim_ids);
  const parentLifecycle = deriveParentLifecycleEvents(
    manifests,
    snapshotsByExtract,
    period,
    timeZone,
    scope,
  );
  // First-observed is only a COMPLETE period metric when a pre-period
  // authoritative baseline exists to establish parent absence/presence for the
  // FIRST in-period extract. Without it, the first in-period population has no
  // predecessor and would be silently omitted, so fail closed rather than
  // publish a hidden partial count. (>= 2 in-period extracts with no baseline is
  // still incomplete for exactly that first extract.)
  const lifecycleComparable = hasPrePeriodBaseline(
    manifests,
    period,
    timeZone,
    scope,
  );
  metrics.new_claims_first_observed = firstObservedMetric(
    parentLifecycle,
    registeredIds,
    { evidence_type: "observed_change", period: period.start.toISOString() },
    lifecycleComparable,
  );
  // Normalize stored exact-closure child UUIDs to the same logical-parent domain
  // as the derived lifecycle stream so a parent is never double-counted.
  const parentRefIndex = buildParentRefIndex(
    snapshotsByExtract,
    asOfAuthoritativeIds,
    canonicalByKey,
  );
  const closures = closureMetrics(
    periodChanges,
    parentLifecycle,
    period,
    { evidence_type: "observed_change", period: period.start.toISOString() },
    (claimId) => parentRefIndex.get(String(claimId)) ?? claimId,
  );
  metrics.claims_closed = closures.closed;
  metrics.claims_closed_exact = closures.exact;
  metrics.claims_closed_observed = closures.observed;
  const ageing = ageingMetric(closingOpen, closingEvidence);
  metrics.ageing_distribution = ageing.distribution;
  metrics.open_claims_60_plus = ageing.sixtyPlus;
  metrics.open_claims_91_plus = ageing.ninetyOnePlus;
  const sla = slaMetrics(closingOpen, closingEvidence);
  metrics.sla_compliance = sla.compliance;
  metrics.sla_breaches = sla.breaches;
  metrics.sla_summary = metric("sla_summary", sla.summary, {
    precision: closingSelection.manifest ? "snapshot_exact" : "unavailable",
    availability: closingSelection.manifest ? "available" : "unavailable",
    claimIds: closingOpen.map((claim) => claim.id),
    warnings: closingSelection.manifest
      ? []
      : ["boundary_snapshot_unavailable"],
    evidence: closingEvidence,
  });
  const movement = movementMetrics(closingOpen, closingEvidence);
  metrics.no_movement_over_14 = movement.over14;
  metrics.no_movement_over_30 = movement.over30;
  const ready = readyAndAnomalyMetrics(closingOpen, closingEvidence);
  metrics.ready_to_close = ready.ready;
  metrics.zero_estimate_payment_request = ready.zeroEstimate;
  metrics.operational_health = operationalHealthMetric(
    closingOpen,
    closingEvidence,
  );
  Object.assign(metrics, financialMetrics(closingOpen, closingEvidence));
  metrics.assignment_activity = assignmentActivity(periodChanges, period, {
    evidence_type: "observed_change",
    period: period.start.toISOString(),
  });
  metrics.handler_performance = metric(
    "handler_performance",
    handlerMetricValue(
      closingOpen,
      activeUsers,
      closingEvidence,
      periodChanges,
    ),
    {
      precision: closingSelection.manifest ? "snapshot_exact" : "unavailable",
      availability: closingSelection.manifest ? "available" : "unavailable",
      claimIds: closingOpen.map((claim) => claim.id),
      warnings: closingSelection.manifest
        ? []
        : ["boundary_snapshot_unavailable"],
      evidence: closingEvidence,
    },
  );

  // C-metric capability boundary: any open multi-row parent whose semantics are
  // unresolved makes the WHOLE affected metric unavailable - never a hidden
  // partial that silently omits those parents from a portfolio figure.
  const unresolvedParents = unresolvedMultiRowParents(closingOpen);
  if (unresolvedParents.length > 0) {
    const details = {
      reason: "multi_row_parent_aggregation_unresolved",
      excluded_parent_count: unresolvedParents.length,
      excluded_claim_numbers: excludedParentNumbers(unresolvedParents),
    };
    const gatedMetricIds = [
      "sla_compliance",
      "sla_breaches",
      "sla_summary",
      "no_movement_over_14",
      "no_movement_over_30",
      "ready_to_close",
      "zero_estimate_payment_request",
      "operational_health",
      "handler_performance",
      "assignment_activity",
    ];
    for (const id of gatedMetricIds) {
      metrics[id] = unavailableMetric(
        id,
        "multi_row_parent_aggregation_unresolved",
        [],
        details,
      );
    }
  }

  if (
    !closingSelection.manifest ||
    closingRowsUnavailable(state, closingSelection)
  ) {
    const unavailableStateMetrics = [
      "closing_inventory",
      "ageing_distribution",
      "open_claims_60_plus",
      "open_claims_91_plus",
      "sla_compliance",
      "sla_breaches",
      "sla_summary",
      "no_movement_over_14",
      "no_movement_over_30",
      "ready_to_close",
      "zero_estimate_payment_request",
      "operational_health",
      "financial_open_outstanding",
      "financial_estimate_total",
      "financial_paid_total",
      "handler_performance",
    ];
    for (const id of unavailableStateMetrics) {
      metrics[id] = unavailableMetric(id, "closing_snapshot_rows_unavailable");
    }
    metrics.net_inventory_movement = unavailableMetric(
      "net_inventory_movement",
      "opening_or_closing_snapshot_unavailable",
    );
  }

  const comparisons = comparisonForMetrics(metrics, previousSnapshot);
  const allWarnings = [
    ...coverage.warnings,
    ...configurationWarnings,
    ...Object.values(metrics).flatMap(
      (value) => value?.coverage_warnings || [],
    ),
  ];
  const coreUnavailable = [...CORE_STATE_METRIC_IDS].some(
    (id) => metrics[id]?.availability === "unavailable",
  );
  const finalCoverageStatus =
    coverage.status === "insufficient" ||
    (coreUnavailable && !closingSelection.manifest)
      ? "insufficient"
      : coverage.status === "partial" || coreUnavailable
        ? "partial"
        : configurationWarnings.length
          ? "usable_with_warnings"
          : coverage.status;
  coverage.status = finalCoverageStatus;
  coverage.warnings = [...new Set(allWarnings)];
  return {
    domain: REPORTING_DOMAIN,
    report_type: reportType,
    report_schema_version: REPORT_SCHEMA_VERSION,
    metric_definition_version: REPORTING_METRIC_VERSION,
    claims_rule_version: CLAIMS_RULE_VERSION,
    quality_rule_version: REPORTING_QUALITY_VERSION,
    quality_configuration: qualityConfiguration(),
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    period_start_local_date: period.startLocalDate,
    period_end_local_date: period.endLocalDateExclusive,
    timezone: timeZone,
    scope,
    coverage_status: coverage.status,
    coverage,
    opening_extract_id: openingSelection.manifest?.id ?? null,
    closing_extract_id: closingSelection.manifest?.id ?? null,
    metrics,
    comparisons,
    activity: {
      changes_considered: periodChanges.length,
      disappearance_is_not_closure: true,
      exact_closure_events_supported:
        closures.exact.availability === "available",
    },
    claim_rows: buildReportClaimRows(
      metrics,
      snapshotsByExtract,
      asOfAuthoritativeManifests,
      timeZone,
      closingSelection.manifest?.id ?? null,
      asOfAuthoritativeIds,
      canonicalByKey,
    ),
  };
}

function closingRowsUnavailable(state, closingSelection) {
  return Boolean(
    closingSelection.manifest &&
    Number(
      closingSelection.manifest.accepted_claim_count ??
        closingSelection.manifest.claim_count ??
        0,
    ) > 0 &&
    state.closingRows.length === 0,
  );
}

export function reportScopeKey(scope = { kind: "team" }) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(scope).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

export function metricPopulationForSnapshot(snapshot, metricId) {
  const metricValue = snapshot?.metrics?.[metricId];
  return metricValue?.claim_population?.claim_ids || [];
}

export function supportedReportTypes() {
  return ["weekly", "monthly"];
}
