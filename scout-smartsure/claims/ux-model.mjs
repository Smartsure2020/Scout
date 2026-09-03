const REPORTING_TIME_ZONE = "Africa/Johannesburg";

const FRESHNESS_LABELS = Object.freeze({
  current: "Current",
  stale: "Stale",
  warning: "Loaded with warnings",
  unavailable: "Unavailable",
});

function datePartsInZone(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  return datePartsInZone(value);
}

export function formatExtractDate(value) {
  const key = dateOnly(value);
  if (!key) return "Extract date unavailable";
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${key}T12:00:00Z`));
}

export function formatReceivedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: REPORTING_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function getFreshnessModel({
  claimsAvailable = false,
  extractDate = null,
  receivedAt = null,
  warningCount = 0,
  now = new Date(),
  unavailableMessage = "No live extract is available.",
} = {}) {
  if (!claimsAvailable) {
    return {
      state: "unavailable",
      label: FRESHNESS_LABELS.unavailable,
      extractDate: null,
      extractDateLabel: "Extract date unavailable",
      receivedAt: null,
      receivedAtLabel: "",
      warningCount: 0,
      message: unavailableMessage,
    };
  }

  const extractDateKey = dateOnly(extractDate);
  const todayKey = dateOnly(now);
  const isStale = Boolean(extractDateKey && todayKey && extractDateKey < todayKey);
  const normalizedWarningCount = Number.isFinite(Number(warningCount))
    ? Math.max(0, Number(warningCount))
    : 0;
  const state = isStale
    ? "stale"
    : normalizedWarningCount > 0 || !extractDateKey
      ? "warning"
      : "current";
  const extractDateLabel = extractDateKey
    ? formatExtractDate(extractDateKey)
    : "Extract date unavailable";
  const receivedAtLabel = formatReceivedAt(receivedAt);
  const warningText = normalizedWarningCount
    ? `${normalizedWarningCount} data quality warning${normalizedWarningCount === 1 ? "" : "s"}`
    : "";

  return {
    state,
    label: FRESHNESS_LABELS[state],
    extractDate: extractDateKey,
    extractDateLabel,
    receivedAt: receivedAt || null,
    receivedAtLabel,
    warningCount: normalizedWarningCount,
    message: isStale
      ? `Last accepted extract: ${extractDateLabel}`
      : `Extract: ${extractDateLabel}`,
    warningText,
  };
}

export function hasValidComparison(current, previous) {
  return Array.isArray(current) && Array.isArray(previous);
}

export function comparisonUnavailableLabel(current, previous) {
  return hasValidComparison(current, previous)
    ? ""
    : "Comparison unavailable";
}

if (typeof window !== "undefined") {
  window.ScoutUX = {
    formatExtractDate,
    formatReceivedAt,
    getFreshnessModel,
    hasValidComparison,
    comparisonUnavailableLabel,
  };
}
