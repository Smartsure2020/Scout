import { toDateOnly } from "./date-periods.mjs";
import { normalizeStatus } from "./claims-rules.mjs";

/**
 * The Phase 1 contract keeps identity provenance explicit. It never creates a
 * synthetic canonical ID from a claim number, handler, date, or array index.
 */
export function claimIdentity(claim) {
  return {
    databaseId: claim?.id ?? claim?.claim_id ?? null,
    sourceClaimNumber:
      claim?.claimNo ?? claim?.claim_no ?? claim?.claimNumber ?? null,
    canonicalClaimId:
      claim?.canonicalClaimId ?? claim?.canonical_claim_id ?? null,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[, ]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function dateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return toDateOnly(value);
}

/**
 * Normalize source field aliases without changing business meaning. Display
 * names are retained as descriptive data, never as identity or authorization.
 */
export function normalizeClaim(source = {}) {
  const identity = claimIdentity(source);
  return {
    ...identity,
    status: source.status ?? source.claims_status ?? null,
    normalizedStatus: normalizeStatus(source.status ?? source.claims_status),
    handlerEmail: source.handlerEmail ?? source.handler_email ?? null,
    handlerDisplayName:
      source.handlerDisplayName ??
      source.handler_name ??
      source.handler ??
      null,
    registeredDate: dateOrNull(
      source.registeredDate ?? source.claim_registered ?? source.registered_at,
    ),
    dolDate: dateOrNull(source.dolDate ?? source.dol ?? source.date_of_loss),
    movementDate: dateOrNull(
      source.movementDate ?? source.lastMovementDate ?? source.last_updated,
    ),
    repudiationDate: dateOrNull(
      source.repudiationDate ?? source.repudiation_date,
    ),
    extractEffectiveAt:
      source.extractEffectiveAt ?? source.extract_effective_at ?? null,
    firstObservedAt: source.firstObservedAt ?? source.first_observed_at ?? null,
    outstanding: numberOrNull(source.outstanding ?? source.nett_claim),
    estimate: numberOrNull(source.estimate ?? source.original_estimate),
    paid: numberOrNull(source.paid),
    mandate: numberOrNull(source.mandate),
    workingAge: numberOrNull(
      source.workingAge ?? source.age_days ?? source.age,
    ),
    calendarAge: numberOrNull(source.calendarAge),
    daysSinceMovement: numberOrNull(source.daysSinceMovement),
    possibleDuplicate: Boolean(source.possibleDuplicate),
    description: source.description ?? source.description_of_loss ?? null,
    comments: source.comments ?? null,
    provenance: {
      sourceEventAt: source.sourceEventAt ?? source.event_at ?? null,
      extractEffectiveAt:
        source.extractEffectiveAt ?? source.extract_effective_at ?? null,
      firstObservedAt:
        source.firstObservedAt ?? source.first_observed_at ?? null,
      observedBetween: source.observedBetween ?? null,
      derivation: source.derivation ?? "source",
    },
  };
}

export const CLAIM_CONTRACT_VERSION = "claims-contract-v1";
