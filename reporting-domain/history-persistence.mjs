import { buildObservedChanges } from "./history.mjs";

export const HISTORY_BATCH_SIZE = 200;

const COMPLETED_HISTORY_STATUSES = new Set([
  "accepted",
  "accepted_with_warnings",
  "rejected",
]);

export function tagHistoryPersistenceError(error, operation) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  if (!tagged.historyOperation && operation) {
    Object.defineProperty(tagged, "historyOperation", {
      configurable: true,
      enumerable: false,
      value: operation,
      writable: false,
    });
  }
  return tagged;
}

export async function withHistoryOperation(operation, callback) {
  try {
    return await callback();
  } catch (error) {
    throw tagHistoryPersistenceError(error, operation);
  }
}

export async function withHistoryDeadline(callback, timeoutMs = 20_000) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) return callback();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          tagHistoryPersistenceError(
            new Error("History persistence deadline exceeded"),
            "persistence_deadline",
          ),
        ),
      limit,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(callback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function historyFailureInfo(
  error,
  fallbackOperation = "history_persistence",
) {
  if (error?.historyFailure) return error.historyFailure;
  const message = String(error?.message || error || "").toLowerCase();
  let code = "unknown";
  if (
    /timeout|timed out|aborted|deadline|execution|duration|subrequest limit/.test(
      message,
    )
  ) {
    code = "execution_limit";
  } else if (
    /\b(401|403)\b|permission|rls|grant|not authorised|not authorized/.test(
      message,
    )
  ) {
    code = "access_denied";
  } else if (
    /\b404\b|does not exist|relation .* does not exist|missing table/.test(
      message,
    )
  ) {
    code = "schema_missing";
  } else if (/duplicate|unique|conflict/.test(message)) {
    code = "duplicate_conflict";
  } else if (/\b(400|422)\b|column|constraint|invalid|violates/.test(message)) {
    code = "schema_or_constraint";
  } else if (/supabase|upstream|fetch failed|network/.test(message)) {
    code = "upstream_failure";
  }
  return {
    code,
    operation: error?.historyOperation || fallbackOperation,
  };
}

export function historyFailurePatch(quality, error, fallbackOperation) {
  return {
    status: "partial_failure",
    historical_persisted: false,
    current_state_updated: false,
    quality_summary: {
      ...(quality || {}),
      historical_persistence_failure: historyFailureInfo(
        error,
        fallbackOperation,
      ),
    },
  };
}

export function buildHistoryClaimRecords(snapshots) {
  const records = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot?.identity_matchable || !snapshot.identity_key) continue;
    if (records.has(snapshot.identity_key)) continue;
    records.set(snapshot.identity_key, {
      source_system: snapshot.source_system || "cardinal_claims",
      source_claim_number: snapshot.source_claim_number,
      identity_key: snapshot.identity_key,
      identity_confidence: snapshot.identity_confidence,
      identity_matchable: true,
      identity_note: null,
    });
  }
  return [...records.values()];
}

export function buildHistorySnapshotRows(snapshots, extractId, claimIds) {
  return (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => {
    const {
      claim_id: _claimId,
      identity_key: _identityKey,
      identity_confidence: _identityConfidence,
      identity_matchable: _identityMatchable,
      _raw_source: _rawSource,
      _evaluation: _evaluation,
      _row_status: _rowStatus,
      movement_source_value: _movementSourceValue,
      ...row
    } = snapshot;
    return {
      ...row,
      extract_id: extractId,
      claim_id: claimIds.get(snapshot.source_row_identity),
      identity_key: snapshot.identity_key,
      identity_matchable: snapshot.identity_matchable,
      identity_confidence: snapshot.identity_confidence,
    };
  });
}

export async function persistHistoryEvidenceWithStore({
  store,
  manifest,
  previousManifest,
  normalized,
  quality,
}) {
  const existingRows = await withHistoryOperation("snapshot_lookup", () =>
    store.listExistingSnapshots(manifest.id),
  );
  const existingByRow = new Map(
    (existingRows || []).map((row) => [row.source_row_identity, row.claim_id]),
  );
  const snapshots = (normalized?.snapshots || []).map((snapshot) => ({
    ...snapshot,
  }));
  const claimIds = await withHistoryOperation("claim_identity_resolution", () =>
    store.ensureClaimIds(snapshots, existingByRow),
  );
  const snapshotRows = buildHistorySnapshotRows(
    snapshots,
    manifest.id,
    claimIds,
  );
  if (snapshotRows.some((row) => !row.claim_id)) {
    throw tagHistoryPersistenceError(
      new Error("Historical snapshot claim identity was not resolved"),
      "claim_identity_resolution",
    );
  }
  await withHistoryOperation("snapshot_insert", () =>
    store.insertSnapshots(snapshotRows),
  );

  const currentSnapshots = await withHistoryOperation("snapshot_readback", () =>
    store.listSnapshots(manifest.id),
  );
  const previousSnapshots = previousManifest
    ? await withHistoryOperation("previous_snapshot_lookup", () =>
        store.listSnapshots(previousManifest.id),
      )
    : [];
  const currentManifest = { ...manifest, quality_summary: quality };
  const changes = buildObservedChanges(
    previousManifest,
    previousSnapshots,
    currentManifest,
    currentSnapshots,
  ).map((change) => ({
    ...change,
    dedupe_key: [
      change.source_extract_id,
      change.claim_id,
      change.previous_extract_id || "none",
      change.change_type,
    ].join("|"),
  }));
  await withHistoryOperation("change_insert", () =>
    store.insertChanges(changes),
  );
  return {
    snapshotCount: currentSnapshots.length,
    changeCount: changes.length,
  };
}

export function historyRecoveryDecision(manifest, sourcePayloadAvailable) {
  if (!manifest) return { recoverable: false, reason: "manifest_missing" };
  if (COMPLETED_HISTORY_STATUSES.has(manifest.status)) {
    return { recoverable: false, reason: "manifest_terminal" };
  }
  if (!sourcePayloadAvailable) {
    return {
      recoverable: false,
      reason: "source_payload_unavailable",
      requires: "original_source_payload",
    };
  }
  return { recoverable: true, reason: "retry_original_source_payload" };
}
