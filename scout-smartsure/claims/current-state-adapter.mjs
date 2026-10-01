function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function qualityFlags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((flag) => String(flag || "").trim()).filter(Boolean))];
}

export function businessDateFromInstant(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-ZA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Reconstruct the canonical fields needed by Scout's operational rules from a
 * scout_claims row. Reporting-only Cardinal values remain in immutable history
 * and are deliberately not inferred here.
 */
export function currentStateRowToClaim(row = {}) {
  const age = nullableNumber(row.cardinal_age_days ?? row.age_days);
  const handler = String(row.handler_name || "Unassigned");
  return {
    claimId: row.claim_id || row.history_claim_id || null,
    age,
    ageProvided: age !== null,
    handler,
    handlerRaw: handler,
    handlerEmail: String(row.handler_email || ""),
    claimNo: String(row.claim_no || ""),
    status: String(row.status || ""),
    registeredDate: nullableDate(row.registered_date ?? row.registered),
    dol: nullableDate(row.dol),
    repudiationDate: nullableDate(row.repudiation_date),
    settledDate: nullableDate(row.settled_date),
    lastUpdated: nullableDate(row.last_updated),
    lastUpdatedSource: String(row.last_updated_source || ""),
    description: String(row.description || ""),
    insured: String(row.insured_name || ""),
    outstanding: nullableNumber(row.outstanding),
    estimate: nullableNumber(row.estimate),
    paid: nullableNumber(row.paid),
    peril: String(row.peril || ""),
    perilType: String(row.peril_type || ""),
    insurer: String(row.insurer || ""),
    comments: String(row.comments || ""),
    ingestionQualityFlags: qualityFlags(row.ingestion_quality_flags),
  };
}

if (typeof window !== "undefined") {
  window.ScoutCurrentStateAdapter = {
    businessDateFromInstant,
    currentStateRowToClaim,
  };
}
