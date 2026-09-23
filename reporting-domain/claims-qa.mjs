const STATUS_ALIASES = Object.freeze({
  reopen: "registered",
  "settled - recovery pending": "settled - awaiting recovery",
  "settled - tp approach pending": "settled - tp approach pending",
});

// Sentinels the source system emits when the status cell is intentionally empty.
// These normalize to "" so downstream evaluators classify the row as missing
// status, not unmapped status. Values below are compared post-normalization
// (already trimmed, lowercased, and with slash-spacing applied), so include
// the post-normalization spelling (e.g. "n / a" rather than "n/a").
// Scoped to only the spelling evidenced in the authoritative 09-15 Cardinal
// source capture. Do not add further spellings ("none", "(none)", "n/a", ...)
// without source evidence that Cardinal actually emits them as a missing-value
// placeholder  -  an unevidenced sentinel would silently suppress a genuine
// unmapped-status warning for whatever real status happens to collide with it.
const MISSING_STATUS_SENTINELS = new Set([
  "[none]",
]);

export function normalizeSourceStatus(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s*-\s*/g, " - ")
    .trim()
    .toLowerCase();
  if (MISSING_STATUS_SENTINELS.has(normalized)) return "";
  return STATUS_ALIASES[normalized] || normalized;
}

export function handlerIdentityKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function handlerIdentityTokens(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join("|");
}

export function sameHandlerIdentity(left, right) {
  const leftKey = handlerIdentityKey(left);
  const rightKey = handlerIdentityKey(right);
  return (
    Boolean(leftKey && rightKey) &&
    (leftKey === rightKey ||
      handlerIdentityTokens(left) === handlerIdentityTokens(right))
  );
}

export function historyMetadata(
  rawClaims,
  fileName,
  extractDate,
  uploadedAt = new Date().toISOString(),
) {
  const safeDate = extractDate || uploadedAt.split("T")[0];
  return {
    id: `${safeDate}-${uploadedAt.replace(/[-:.TZ]/g, "")}`,
    extractDate: safeDate,
    uploadedAt,
    fileName: fileName || "Uploaded extract",
    claimCount: Array.isArray(rawClaims) ? rawClaims.length : 0,
    schemaVersion: "scout-extract-metadata-v2",
  };
}

export function isNewlyTerminal(previous, current, isTerminal) {
  return Boolean(
    current &&
    isTerminal(current.status) &&
    (!previous || !isTerminal(previous.status)),
  );
}

export function compareExtractClaims(
  currentClaims = [],
  previousClaims = [],
  isTerminal = () => false,
) {
  const currentByNo = new Map(
    currentClaims
      .filter((claim) => claim?.claimNo)
      .map((claim) => [claim.claimNo, claim]),
  );
  const previousByNo = new Map(
    previousClaims
      .filter((claim) => claim?.claimNo)
      .map((claim) => [claim.claimNo, claim]),
  );
  const newClaims = [];
  const closedClaims = [];
  const statusChanges = [];
  const estimateChanges = [];

  currentByNo.forEach((claim, claimNo) => {
    const previous = previousByNo.get(claimNo);
    if (!previous) {
      newClaims.push(claim);
      return;
    }
    if (
      normalizeSourceStatus(previous.status) !==
      normalizeSourceStatus(claim.status)
    ) {
      statusChanges.push({
        claim,
        previousStatus: previous.status || "",
        currentStatus: claim.status || "",
      });
    }
    if (
      Math.round(Number(previous.estimate || 0) * 100) !==
      Math.round(Number(claim.estimate || 0) * 100)
    ) {
      estimateChanges.push({
        claim,
        previousEstimate: Number(previous.estimate || 0),
        currentEstimate: Number(claim.estimate || 0),
      });
    }
    if (isNewlyTerminal(previous, claim, isTerminal)) closedClaims.push(claim);
  });

  previousByNo.forEach((previous, claimNo) => {
    if (!currentByNo.has(claimNo)) closedClaims.push(previous);
  });

  return {
    hasPrevious: previousByNo.size > 0,
    newClaims,
    closedClaims,
    statusChanges,
    estimateChanges,
  };
}

if (typeof window !== "undefined") {
  window.ScoutClaimsQA = {
    compareExtractClaims,
    handlerIdentityKey,
    handlerIdentityTokens,
    historyMetadata,
    isNewlyTerminal,
    normalizeSourceStatus,
    sameHandlerIdentity,
  };
}
