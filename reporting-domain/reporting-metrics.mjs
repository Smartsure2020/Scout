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

export const REPORTING_METRIC_VERSION = "claims-reporting-metrics-v1";
export const REPORT_SCHEMA_VERSION = "scout-report-v1";
export const REPORTING_QUALITY_VERSION = "scout-reporting-quality-v1";
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

function manifestInstant(manifest, timeZone = BUSINESS_TIME_ZONE) {
  const exact = parseInstant(manifest?.effective_at);
  if (exact) return exact;
  if (manifest?.effective_date) {
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
  return parseInstant(manifest?.received_at);
}

export function extractObservationInstant(
  manifest,
  timeZone = BUSINESS_TIME_ZONE,
) {
  return manifestInstant(manifest, timeZone);
}

function manifestPrecision(manifest) {
  if (manifest?.effective_at) return "source_exact";
  if (manifest?.effective_date) return "source_date";
  if (manifest?.received_at) return "observed_period";
  return "unavailable";
}

function manifestReferenceDate(manifest, timeZone = BUSINESS_TIME_ZONE) {
  return (
    manifest?.effective_date ||
    dateFromInstant(manifest?.effective_at, timeZone) ||
    dateFromInstant(manifest?.received_at, timeZone)
  );
}

function manifestIsAccepted(manifest) {
  const quality = asObject(manifest?.quality_summary);
  return (
    ACCEPTED_STATUSES.has(manifest?.status) &&
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

function supersededIds(candidates) {
  const ids = new Set();
  const candidateIds = new Set(candidates.map((manifest) => manifest.id));
  for (const manifest of candidates) {
    if (
      manifest?.correction_of_extract_id &&
      candidateIds.has(manifest.correction_of_extract_id)
    ) {
      ids.add(manifest.correction_of_extract_id);
    }
  }
  return ids;
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
  const candidates = asArray(manifests).filter((manifest) => {
    const instant = manifestInstant(manifest, timeZone);
    return (
      manifestIsAccepted(manifest) &&
      scopeMatches(manifest, scope) &&
      instant !== null &&
      instant <= boundaryInstant
    );
  });
  const superseded = supersededIds(candidates);
  const current = candidates.filter((manifest) => !superseded.has(manifest.id));
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

function uniqueSnapshots(snapshots) {
  const byIdentity = new Map();
  for (const snapshot of asArray(snapshots)) {
    const key = snapshot?.identity_key || snapshotReference(snapshot);
    if (!key || !snapshot?.identity_matchable) continue;
    byIdentity.set(key, snapshot);
  }
  return [...byIdentity.values()];
}

function periodSnapshotRows(
  manifests,
  snapshotsByExtract,
  period,
  timeZone,
  scope,
) {
  const rows = [];
  const relevantManifests = asArray(manifests)
    .filter(
      (manifest) =>
        manifestIsAccepted(manifest) &&
        scopeMatches(manifest, scope) &&
        periodMembership(manifestInstant(manifest, timeZone), period),
    )
    .sort((left, right) => manifestSort(left, right, timeZone));
  for (const manifest of relevantManifests) {
    rows.push(
      ...uniqueSnapshots(
        snapshotsForExtract(snapshotsByExtract, manifest.id),
      ).map((snapshot) => mapSnapshotToClaim(snapshot, manifest, timeZone)),
    );
  }
  const latestObservedByClaim = new Map();
  for (const row of rows) latestObservedByClaim.set(row.id, row);
  return [...latestObservedByClaim.values()];
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
) {
  const openingRows = openingSelection.manifest
    ? uniqueSnapshots(
        snapshotsForExtract(snapshotsByExtract, openingSelection.manifest.id),
      ).map((snapshot) =>
        mapSnapshotToClaim(snapshot, openingSelection.manifest, timeZone),
      )
    : [];
  const closingRows = closingSelection.manifest
    ? uniqueSnapshots(
        snapshotsForExtract(snapshotsByExtract, closingSelection.manifest.id),
      ).map((snapshot) =>
        mapSnapshotToClaim(snapshot, closingSelection.manifest, timeZone),
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

function firstObservedMetric(changes, period, registeredIds, evidence) {
  const ids = new Set();
  for (const change of changes) {
    if (
      change?.change_type === "first_observed" &&
      periodMembership(changeInstant(change), period) &&
      change?.claim_id &&
      !registeredIds.has(String(change.claim_id))
    ) {
      ids.add(String(change.claim_id));
    }
  }
  if (!changes.some((change) => change?.change_type === "first_observed")) {
    return unavailableMetric(
      "new_claims_first_observed",
      "first_observed_history_unavailable",
    );
  }
  return metric("new_claims_first_observed", ids.size, {
    precision: "observed_period",
    claimIds: [...ids],
    evidence: { ...evidence, change_type: "first_observed" },
  });
}

function closureMetrics(changes, period, evidence) {
  const exact = new Set();
  const observed = new Set();
  const exactTypes = new Set([
    "closure_event",
    "claim_closed",
    "terminal_transition",
  ]);
  for (const change of changes) {
    if (!periodMembership(changeInstant(change), period) || !change?.claim_id)
      continue;
    if (
      exactTypes.has(change.change_type) &&
      change.source_event_at &&
      change.provenance === "source_explicit"
    ) {
      exact.add(String(change.claim_id));
    } else if (change.change_type === "terminal_transition_observed") {
      observed.add(String(change.claim_id));
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
  for (const [id, field, definition] of fields) {
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
  const byClaim = new Map();
  for (const snapshot of snapshotsForExtract(
    snapshotsByExtract,
    preferredExtractId,
  )) {
    const claimId = snapshotReference(snapshot);
    if (claimId) byClaim.set(String(claimId), snapshot);
  }
  for (const snapshot of allSnapshots(snapshotsByExtract)) {
    const claimId = snapshotReference(snapshot);
    if (claimId && !byClaim.has(String(claimId)))
      byClaim.set(String(claimId), snapshot);
  }
  const manifestsById = new Map(
    asArray(manifests).map((manifest) => [manifest.id, manifest]),
  );
  return [...membership.entries()].map(([claimId, entry]) => {
    const snapshot = byClaim.get(claimId);
    const manifest = manifestsById.get(snapshot?.extract_id);
    const claim =
      snapshot && manifest
        ? mapSnapshotToClaim(snapshot, manifest, timeZone)
        : null;
    return {
      claim_id: snapshot?.claim_id ?? claimId,
      source_system: snapshot?.source_system ?? "cardinal_claims",
      source_claim_number:
        snapshot?.source_claim_number ?? claim?.sourceClaimNumber ?? null,
      identity_key: snapshot?.identity_key ?? claim?.identity_key ?? null,
      metric_ids: entry.metric_ids.sort(),
      membership_reasons: entry.membership_reasons,
      handler_snapshot:
        snapshot?.handler_source ?? claim?.handlerSource ?? null,
      handler_email_snapshot:
        snapshot?.handler_email ?? claim?.handlerEmail ?? null,
      resolved_scout_user_id_snapshot:
        snapshot?.resolved_scout_user_id ?? claim?.resolvedScoutUserId ?? null,
      status_snapshot:
        snapshot?.status_normalized ?? claim?.statusNormalized ?? null,
      insurer_snapshot: snapshot?.insurer ?? claim?.insurer ?? null,
      peril_snapshot: snapshot?.peril ?? claim?.peril ?? null,
      registered_date_snapshot:
        snapshot?.registered_date ?? claim?.registeredDate ?? null,
      calendar_age_snapshot:
        snapshot?.calendar_age ?? claim?.calendarAge ?? null,
      working_age_snapshot: snapshot?.working_age ?? claim?.workingAge ?? null,
      outstanding_snapshot: snapshot?.outstanding ?? claim?.outstanding ?? null,
      estimate_snapshot: snapshot?.estimate ?? claim?.estimate ?? null,
      paid_snapshot: snapshot?.paid ?? claim?.paid ?? null,
      relevant_flags: {
        priority: snapshot?.priority_flags ?? [],
        operational: snapshot?.operational_flags ?? [],
        quality: snapshot?.data_quality_flags ?? [],
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
  const openingSelection = selectBoundaryExtract(manifests, period.start, {
    timeZone,
    scope,
  });
  const closingSelection = selectBoundaryExtract(manifests, period.end, {
    timeZone,
    scope,
  });
  const state = closingState(
    openingSelection,
    closingSelection,
    snapshotsByExtract,
    timeZone,
  );
  const coverage = coverageAssessment({
    period,
    manifests,
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
  const periodChanges = asArray(changes).filter((change) =>
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
    manifests,
    snapshotsByExtract,
    period,
    timeZone,
    scope,
  );
  const registered = sourceDateRegistrationMetric(
    periodRows.length ? periodRows : state.closingRows,
    period,
    closingEvidence,
  );
  metrics.new_claims_registered = registered;
  const registeredIds = new Set(registered.claim_population.claim_ids);
  metrics.new_claims_first_observed = firstObservedMetric(
    periodChanges,
    period,
    registeredIds,
    { evidence_type: "observed_change", period: period.start.toISOString() },
  );
  const closures = closureMetrics(periodChanges, period, {
    evidence_type: "observed_change",
    period: period.start.toISOString(),
  });
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
      manifests,
      timeZone,
      closingSelection.manifest?.id ?? null,
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
