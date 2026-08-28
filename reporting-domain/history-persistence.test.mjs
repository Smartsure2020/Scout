import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHistoricalRows } from "./history.mjs";
import {
  buildHistoryClaimRecords,
  historyFailureInfo,
  historyFailurePatch,
  historyRecoveryDecision,
  persistHistoryEvidenceWithStore,
  withHistoryDeadline,
} from "./history-persistence.mjs";

const activeUsers = [
  {
    id: "user-a",
    email: "handler-a@example.test",
    role: "handler",
    active: true,
  },
  {
    id: "user-b",
    email: "handler-b@example.test",
    role: "handler",
    active: true,
  },
];

function snapshot({
  row = "row-0",
  claim = "C-1",
  identityKey = `cardinal_claims:${claim}`,
  matchable = true,
  status = "registered",
  terminal = false,
} = {}) {
  return {
    claim_id: null,
    identity_key: matchable ? identityKey : null,
    identity_confidence: matchable ? "source_scoped" : "ambiguous",
    identity_matchable: matchable,
    source_row_identity: row,
    source_row_index: Number(row.replace(/\D/g, "")) || 0,
    source_claim_number: claim,
    handler_source: "Handler A",
    handler_email: "handler-a@example.test",
    resolved_scout_user_id: "user-a",
    handler_resolution: "resolved",
    status_raw: status,
    status_normalized: status,
    terminal,
    open: !terminal,
    operational_category: terminal ? "closed" : "registered",
    registered_date: "2026-08-27",
    dol_date: null,
    movement_date: null,
    repudiation_date: null,
    source_event_at: null,
    outstanding: 100,
    estimate: 100,
    paid: 0,
    mandate: 0,
    insurer: "Test Insurer",
    peril: "Fire",
    peril_type: "Property",
    insured: "Test Insured",
    description: "Test description",
    comments: "Source comment",
    calendar_age: 1,
    working_age: 1,
    age_band: "0-7",
    rule_version: "test-rules",
    priority_score: 0,
    priority_band: "P3",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
    source_evidence: {},
    _raw_source: { claimNo: claim },
    _evaluation: {},
    _row_status: terminal ? "terminal" : "open",
    movement_source_value: null,
  };
}

function manifest(id, qualitySummary = {}) {
  return {
    id,
    source_system: "cardinal_claims",
    received_at: `${id}-received`,
    effective_at: null,
    quality_summary: qualitySummary,
  };
}

function memoryStore(failOperation = null) {
  const claims = new Map();
  const snapshots = new Map();
  const changes = new Map();
  let nextClaimId = 1;
  const fail = (operation) => {
    if (failOperation === operation)
      throw new Error(`test ${operation} failure`);
  };

  return {
    claims,
    snapshots,
    changes,
    async listExistingSnapshots(extractId) {
      return [...snapshots.values()].filter(
        (row) => row.extract_id === extractId,
      );
    },
    async ensureClaimIds(rows, existingByRow) {
      const result = new Map(existingByRow);
      for (const row of rows) {
        if (result.has(row.source_row_identity)) continue;
        const key = row.identity_key || `ambiguous:${row.source_row_identity}`;
        if (!claims.has(key)) claims.set(key, `claim-${nextClaimId++}`);
        result.set(row.source_row_identity, claims.get(key));
      }
      return result;
    },
    async insertSnapshots(rows) {
      fail("snapshot_insert");
      for (const row of rows)
        snapshots.set(`${row.extract_id}:${row.source_row_identity}`, row);
    },
    async listSnapshots(extractId) {
      return [...snapshots.values()].filter(
        (row) => row.extract_id === extractId,
      );
    },
    async insertChanges(rows) {
      fail("change_insert");
      for (const row of rows) changes.set(row.dedupe_key, row);
    },
  };
}

test("claim identity records are batched without merging ambiguous duplicate rows", () => {
  const rows = [
    snapshot({ row: "row-0", claim: "C-1" }),
    snapshot({ row: "row-1", claim: "C-1", matchable: false }),
    snapshot({ row: "row-2", claim: "C-1", matchable: false }),
    snapshot({ row: "row-3", claim: "C-2" }),
  ];
  const records = buildHistoryClaimRecords(rows);
  assert.deepEqual(
    records.map((row) => row.identity_key),
    ["cardinal_claims:C-1", "cardinal_claims:C-2"],
  );
  assert.equal(
    records.every((row) => row.identity_matchable),
    true,
  );
});

test("history persistence writes identities, immutable snapshots, changes, and a usable count", async () => {
  const store = memoryStore();
  const current = manifest("extract-1", { comparable_to_previous: false });
  const normalized = {
    snapshots: [
      snapshot({ row: "row-0", claim: "C-1" }),
      snapshot({
        row: "row-1",
        claim: "C-2",
        status: "closed",
        terminal: true,
      }),
      snapshot({ row: "row-2", claim: "DUP-1", matchable: false }),
    ],
  };
  const result = await persistHistoryEvidenceWithStore({
    store,
    manifest: current,
    normalized,
    quality: current.quality_summary,
  });
  assert.equal(result.snapshotCount, 3);
  assert.equal(result.changeCount, 2);
  assert.equal(store.claims.size, 3);
  assert.equal(store.snapshots.size, 3);
  assert.equal(store.changes.size, 2);
  const persisted = [...store.snapshots.values()][0];
  assert.equal("_raw_source" in persisted, false);
  assert.equal(persisted.extract_id, "extract-1");
});

test("deterministic fixture preserves duplicates, handlers, terminal/open, financial, and missing-date evidence", async () => {
  const normalized = normalizeHistoricalRows(
    [
      {
        claimNo: "C-1",
        status: "Registered",
        handler: "handler-a@example.test",
        outstanding: "R100",
        estimate: "R100",
      },
      {
        claimNo: "C-2",
        status: "Closed Paid",
        handler: "handler-b@example.test",
        paid: "R80",
        estimate: "R80",
      },
      {
        claimNo: "DUP-1",
        status: "Registered",
        handler: "handler-a@example.test",
      },
      {
        claimNo: "DUP-1",
        status: "Registered",
        handler: "handler-b@example.test",
      },
      {
        claimNo: "C-5",
        status: "New status",
        handler: "Unknown handler",
        registeredDate: "not-a-date",
        outstanding: "not-a-number",
      },
    ],
    {
      sourceSystem: "cardinal_claims",
      effectiveDate: "2026-08-27",
      activeUsers,
    },
  );
  assert.equal(normalized.snapshots.length, 5);
  assert.equal(normalized.quality.duplicate_claim_number_count, 1);
  assert.equal(normalized.quality.identity_ambiguity_count, 2);
  assert.equal(normalized.snapshots[1].terminal, true);
  assert.equal(normalized.snapshots[0].open, true);
  assert.equal(normalized.snapshots[1].paid, 80);
  assert.equal(
    normalized.snapshots[4].data_quality_flags.includes(
      "invalid_date:registered_date",
    ),
    true,
  );
  assert.equal(normalized.snapshots[4].handler_resolution, "unrecognised");

  const store = memoryStore();
  const result = await persistHistoryEvidenceWithStore({
    store,
    manifest: manifest("fixture-extract", { comparable_to_previous: false }),
    normalized,
    quality: normalized.quality,
  });
  assert.equal(result.snapshotCount, 5);
  assert.equal(store.snapshots.size, 5);
});

test("retry is idempotent after a partial write and does not create duplicate identities", async () => {
  const store = memoryStore();
  const current = manifest("extract-1", { comparable_to_previous: false });
  const normalized = { snapshots: [snapshot({ row: "row-0", claim: "C-1" })] };
  await persistHistoryEvidenceWithStore({
    store,
    manifest: current,
    normalized,
    quality: current.quality_summary,
  });
  await persistHistoryEvidenceWithStore({
    store,
    manifest: current,
    normalized,
    quality: current.quality_summary,
  });
  assert.equal(store.claims.size, 1);
  assert.equal(store.snapshots.size, 1);
  assert.equal(store.changes.size, 1);
});

test("history persistence failures become safe terminal metadata with an operation", async () => {
  const store = memoryStore("snapshot_insert");
  let error;
  try {
    await persistHistoryEvidenceWithStore({
      store,
      manifest: manifest("extract-1"),
      normalized: { snapshots: [snapshot()] },
      quality: { quality_state: "ok" },
    });
    assert.fail("expected persistence to fail");
  } catch (caught) {
    error = caught;
  }
  const failure = historyFailureInfo(error);
  assert.equal(failure.code, "unknown");
  assert.equal(failure.operation, "snapshot_insert");
  const patch = historyFailurePatch({ quality_state: "ok" }, error);
  assert.equal(patch.status, "partial_failure");
  assert.equal(patch.historical_persisted, false);
  assert.deepEqual(
    patch.quality_summary.historical_persistence_failure,
    failure,
  );
  assert.equal(
    "message" in patch.quality_summary.historical_persistence_failure,
    false,
  );
});

test("persistence has a deadline before a Worker execution limit can leave processing ambiguous", async () => {
  await assert.rejects(
    withHistoryDeadline(() => new Promise(() => {}), 5),
    (error) => {
      assert.equal(error.historyOperation, "persistence_deadline");
      assert.equal(historyFailureInfo(error).code, "execution_limit");
      return true;
    },
  );
});

test("existing manifests require the original source payload for safe retry", () => {
  assert.deepEqual(historyRecoveryDecision({ status: "processing" }, false), {
    recoverable: false,
    reason: "source_payload_unavailable",
    requires: "original_source_payload",
  });
  assert.deepEqual(
    historyRecoveryDecision({ status: "partial_failure" }, true),
    { recoverable: true, reason: "retry_original_source_payload" },
  );
  assert.deepEqual(historyRecoveryDecision({ status: "accepted" }, true), {
    recoverable: false,
    reason: "manifest_terminal",
  });
});
