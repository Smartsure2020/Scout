import assert from "node:assert/strict";
import test from "node:test";

import {
  assessExtractQuality,
  buildObservedChanges,
  computeSourceChecksum,
  deduplicateChanges,
  HISTORY_SCHEMA_VERSION,
  normalizeHistoricalRows,
  sourceChecksumPayload,
} from "./history.mjs";

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

function manifest(id, receivedAt, qualitySummary, overrides = {}) {
  return {
    id,
    source_system: "cardinal_claims",
    schema_version: HISTORY_SCHEMA_VERSION,
    status: "accepted",
    claim_count: qualitySummary.normalized_claim_count,
    received_at: receivedAt,
    effective_at: null,
    effective_date: receivedAt.slice(0, 10),
    quality_summary: qualitySummary,
    ...overrides,
  };
}

function normalize(rows, effectiveDate = "2026-08-24") {
  return normalizeHistoricalRows(rows, {
    sourceSystem: "cardinal_claims",
    effectiveDate,
    activeUsers,
  });
}

function assignClaimIds(snapshots, ids = new Map()) {
  return snapshots.map((snapshot) => ({
    ...snapshot,
    claim_id: snapshot.identity_matchable
      ? ids.get(snapshot.identity_key) ||
        ids
          .set(snapshot.identity_key, `claim-${ids.size + 1}`)
          .get(snapshot.identity_key)
      : `ambiguous-${snapshot.source_row_identity}`,
  }));
}

test("source checksum is deterministic, order-independent for object keys, and content-sensitive", async () => {
  const first = await computeSourceChecksum({
    b: 2,
    a: 1,
    rows: [{ status: "active" }],
  });
  const same = await computeSourceChecksum({
    rows: [{ status: "active" }],
    a: 1,
    b: 2,
  });
  const changed = await computeSourceChecksum({
    b: 2,
    a: 1,
    rows: [{ status: "terminal" }],
  });
  assert.equal(first.checksum, same.checksum);
  assert.notEqual(first.checksum, changed.checksum);
  assert.equal(first.basis, "claims-json-payload");
  assert.deepEqual(
    sourceChecksumPayload([
      {
        claimNo: "C-1",
        status: "Registered",
        workingAge: 5,
        priority: { score: 10 },
      },
    ]),
    [{ claimNo: "C-1", status: "Registered" }],
  );
});

test("first extract normalization preserves source fields and derived rule version", () => {
  const result = normalize([
    {
      claimNo: " C-001 ",
      status: "Registered",
      handler: "handler-a@example.test",
      registeredDate: "2026-08-20",
      dol: "2026-08-19",
      lastUpdated: "2026-08-22",
      outstanding: "R100,000",
      estimate: "120000",
      paid: "0",
      mandate: "100000",
      insurer: "Example Insurer",
      peril: "Fire",
      description: "Source description",
      comments: "Source comment",
    },
  ]);
  assert.equal(result.snapshots.length, 1);
  const snapshot = result.snapshots[0];
  assert.equal(snapshot.source_claim_number, " C-001 ");
  assert.equal(snapshot.identity_matchable, true);
  assert.equal(snapshot.handler_email, "handler-a@example.test");
  assert.equal(snapshot.resolved_scout_user_id, "user-a");
  assert.equal(snapshot.outstanding, 100000);
  assert.equal(snapshot.estimate, 120000);
  assert.equal(snapshot.rule_version, "claims-operations-rules-v1");
  assert.equal(snapshot.source_evidence.claimNo, " C-001 ");
});

test("malformed rows are rejected while partial valid extracts are preserved", () => {
  const result = normalize([
    { status: "Registered", handler: "handler-a@example.test" },
    {
      claimNo: "C-002",
      status: "Registered",
      handler: "handler-a@example.test",
    },
  ]);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.rejectedRows.length, 1);
  assert.equal(result.quality.rejected_claim_count, 1);
  assert.equal(result.quality.hard_rejection, false);
  const allInvalid = normalize([{ status: "Registered" }]);
  assert.equal(allInvalid.quality.hard_rejection, true);
});

test("duplicate claim numbers remain separate and non-matchable", () => {
  const result = normalize([
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
  ]);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.quality.duplicate_claim_number_count, 1);
  assert.equal(
    result.snapshots.every((snapshot) => snapshot.identity_matchable === false),
    true,
  );
  assert.equal(
    result.snapshots.every((snapshot) =>
      snapshot.data_quality_flags.includes("identity_ambiguity"),
    ),
    true,
  );
});

test("unknown handler and status are preserved as quality warnings", () => {
  const result = normalize([
    {
      claimNo: "Q-1",
      status: "New status from Cardinal",
      handler: "Historical Handler",
    },
  ]);
  const flags = result.snapshots[0].data_quality_flags;
  assert.equal(flags.includes("unrecognised_handler"), true);
  assert.equal(flags.includes("unmapped_status"), true);
  assert.equal(result.snapshots[0].handler_source, "Historical Handler");
  assert.equal(result.snapshots[0].resolved_scout_user_id, null);
});

test("same nominal date with a different payload is a corrected version, not an overwrite", async () => {
  const first = await computeSourceChecksum({
    extractDate: "2026-08-24",
    claims: [{ claimNo: "C-1", status: "Registered" }],
  });
  const corrected = await computeSourceChecksum({
    extractDate: "2026-08-24",
    claims: [{ claimNo: "C-1", status: "Payment Requested" }],
  });
  assert.notEqual(first.checksum, corrected.checksum);
});

test("quality gate suppresses disappearance generation after a 50 percent row-count drop", () => {
  const previous = manifest("extract-1", "2026-08-24T08:00:00.000Z", {
    normalized_claim_count: 2,
    completeness_state: "complete",
  });
  const currentNormalized = normalize([
    { claimNo: "C-1", status: "Registered", handler: "handler-a@example.test" },
  ]);
  const quality = assessExtractQuality(currentNormalized, {
    previousManifest: previous,
  });
  assert.equal(quality.completeness_state, "incomplete");
  assert.equal(quality.comparable_to_previous, false);
  assert.equal(quality.warnings.includes("material_row_count_drop"), true);
});

test("status, handler, and financial differences generate one observed change each", () => {
  const previousNormalized = normalize([
    {
      claimNo: "C-1",
      status: "Registered",
      handler: "handler-a@example.test",
      outstanding: 100000,
    },
  ]);
  const currentNormalized = normalize([
    {
      claimNo: "C-1",
      status: "Payment Requested",
      handler: "handler-b@example.test",
      outstanding: 120000,
    },
  ]);
  const ids = new Map();
  const previousSnapshots = assignClaimIds(previousNormalized.snapshots, ids);
  const currentSnapshots = assignClaimIds(currentNormalized.snapshots, ids);
  const previousQuality = {
    normalized_claim_count: 1,
    completeness_state: "complete",
  };
  const currentQuality = {
    normalized_claim_count: 1,
    completeness_state: "complete",
    comparable_to_previous: true,
  };
  const changes = buildObservedChanges(
    manifest("extract-1", "2026-08-24T08:00:00.000Z", previousQuality),
    previousSnapshots,
    manifest("extract-2", "2026-08-25T08:00:00.000Z", currentQuality),
    currentSnapshots,
  );
  assert.deepEqual(changes.map((change) => change.change_type).sort(), [
    "handler_changed",
    "outstanding_changed",
    "status_changed",
  ]);
  assert.equal(
    changes.every(
      (change) => change.timestamp_precision === "between_extracts",
    ),
    true,
  );
  assert.equal(
    changes.every((change) => change.source_event_at === null),
    true,
  );
});

test("same state produces no changes and retry deduplication is stable", () => {
  const normalized = normalize([
    { claimNo: "C-1", status: "Registered", handler: "handler-a@example.test" },
  ]);
  const ids = new Map();
  const snapshots = assignClaimIds(normalized.snapshots, ids);
  const quality = {
    normalized_claim_count: 1,
    completeness_state: "complete",
    comparable_to_previous: true,
  };
  const first = manifest("extract-1", "2026-08-24T08:00:00.000Z", quality);
  const second = manifest("extract-2", "2026-08-25T08:00:00.000Z", quality);
  const changes = buildObservedChanges(first, snapshots, second, snapshots);
  assert.equal(changes.length, 0);
  const duplicate = deduplicateChanges([
    {
      source_extract_id: "e2",
      claim_id: "c1",
      previous_extract_id: "e1",
      change_type: "status_changed",
    },
    {
      source_extract_id: "e2",
      claim_id: "c1",
      previous_extract_id: "e1",
      change_type: "status_changed",
    },
  ]);
  assert.equal(duplicate.length, 1);
});

test("appearance, terminal transition, reopening, and disappearance are distinct", () => {
  const monday = normalize([
    {
      claimNo: "A",
      status: "Registered",
      handler: "handler-a@example.test",
      outstanding: 100000,
    },
    { claimNo: "B", status: "Registered", handler: "handler-b@example.test" },
  ]);
  const tuesday = normalize([
    {
      claimNo: "A",
      status: "Registered",
      handler: "handler-b@example.test",
      outstanding: 120000,
    },
    { claimNo: "B", status: "Closed Paid", handler: "handler-b@example.test" },
  ]);
  const wednesday = normalize([
    {
      claimNo: "A",
      status: "Registered",
      handler: "handler-b@example.test",
      outstanding: 120000,
    },
  ]);
  const ids = new Map();
  const mondaySnapshots = assignClaimIds(monday.snapshots, ids);
  const tuesdaySnapshots = assignClaimIds(tuesday.snapshots, ids);
  const wednesdaySnapshots = assignClaimIds(wednesday.snapshots, ids);
  const mondayManifest = manifest("monday", "2026-08-24T08:00:00.000Z", {
    normalized_claim_count: 2,
    completeness_state: "complete",
    comparable_to_previous: false,
  });
  const tuesdayManifest = manifest("tuesday", "2026-08-25T08:00:00.000Z", {
    normalized_claim_count: 2,
    completeness_state: "complete",
    comparable_to_previous: true,
  });
  const wednesdayManifest = manifest("wednesday", "2026-08-26T08:00:00.000Z", {
    normalized_claim_count: 1,
    completeness_state: "incomplete",
    comparable_to_previous: false,
  });
  const firstChanges = buildObservedChanges(
    null,
    [],
    mondayManifest,
    mondaySnapshots,
  );
  const secondChanges = buildObservedChanges(
    mondayManifest,
    mondaySnapshots,
    tuesdayManifest,
    tuesdaySnapshots,
  );
  const thirdChanges = buildObservedChanges(
    tuesdayManifest,
    tuesdaySnapshots,
    wednesdayManifest,
    wednesdaySnapshots,
  );
  assert.equal(
    firstChanges.filter((change) => change.change_type === "first_observed")
      .length,
    2,
  );
  assert.equal(
    secondChanges.filter((change) => change.change_type === "handler_changed")
      .length,
    1,
  );
  assert.equal(
    secondChanges.filter(
      (change) => change.change_type === "outstanding_changed",
    ).length,
    1,
  );
  assert.equal(
    secondChanges.filter(
      (change) => change.change_type === "terminal_transition_observed",
    ).length,
    1,
  );
  assert.equal(
    thirdChanges.some(
      (change) => change.change_type === "terminal_transition_observed",
    ),
    false,
  );
  assert.equal(
    thirdChanges.some(
      (change) => change.change_type === "missing_from_extract",
    ),
    false,
  );
  const reopened = normalize([
    { claimNo: "B", status: "Registered", handler: "handler-b@example.test" },
  ]);
  const reopenedSnapshots = assignClaimIds(reopened.snapshots, ids);
  const reopenedManifest = manifest("thursday", "2026-08-27T08:00:00.000Z", {
    normalized_claim_count: 2,
    completeness_state: "complete",
    comparable_to_previous: true,
  });
  const reopenChanges = buildObservedChanges(
    tuesdayManifest,
    tuesdaySnapshots,
    reopenedManifest,
    reopenedSnapshots,
  );
  assert.equal(
    reopenChanges.some((change) => change.change_type === "reopened"),
    true,
  );
});

test("moderate disappearance is recorded without being called closure", () => {
  const previous = normalize([
    { claimNo: "C-1", status: "Registered", handler: "handler-a@example.test" },
    { claimNo: "C-2", status: "Registered", handler: "handler-a@example.test" },
    { claimNo: "C-3", status: "Registered", handler: "handler-a@example.test" },
  ]);
  const current = normalize([
    { claimNo: "C-1", status: "Registered", handler: "handler-a@example.test" },
    { claimNo: "C-2", status: "Registered", handler: "handler-a@example.test" },
  ]);
  const ids = new Map();
  const previousSnapshots = assignClaimIds(previous.snapshots, ids);
  const currentSnapshots = assignClaimIds(current.snapshots, ids);
  const previousManifest = manifest("previous", "2026-08-24T08:00:00.000Z", {
    normalized_claim_count: 3,
    completeness_state: "complete",
  });
  const currentManifest = manifest("current", "2026-08-25T08:00:00.000Z", {
    normalized_claim_count: 2,
    completeness_state: "complete",
    comparable_to_previous: true,
  });
  const changes = buildObservedChanges(
    previousManifest,
    previousSnapshots,
    currentManifest,
    currentSnapshots,
  );
  assert.deepEqual(
    changes.map((change) => change.change_type),
    ["missing_from_extract"],
  );
});

test("provenance distinguishes source timestamp, source date, between extracts, and derived transition", () => {
  const previousNormalized = normalize([
    {
      claimNo: "C-1",
      status: "Registered",
      handler: "handler-a@example.test",
      movementDate: "2026-08-20",
    },
  ]);
  const currentNormalized = normalize([
    {
      claimNo: "C-1",
      status: "Registered",
      handler: "handler-a@example.test",
      movementDate: "2026-08-21",
      sourceEventAt: "2026-08-21T13:12:00+02:00",
    },
  ]);
  const ids = new Map();
  const previousSnapshots = assignClaimIds(previousNormalized.snapshots, ids);
  const currentSnapshots = assignClaimIds(currentNormalized.snapshots, ids);
  const previousManifest = manifest("previous", "2026-08-24T08:00:00.000Z", {
    normalized_claim_count: 1,
    completeness_state: "complete",
  });
  const currentManifest = manifest("current", "2026-08-25T08:00:00.000Z", {
    normalized_claim_count: 1,
    completeness_state: "complete",
    comparable_to_previous: true,
  });
  const movement = buildObservedChanges(
    previousManifest,
    previousSnapshots,
    currentManifest,
    currentSnapshots,
  ).find((change) => change.change_type === "movement_changed");
  assert.equal(movement.provenance, "source_explicit");
  assert.equal(movement.timestamp_precision, "exact_timestamp");
  assert.equal(movement.source_event_at, "2026-08-21T11:12:00.000Z");
  const derived = buildObservedChanges(
    previousManifest,
    assignClaimIds(
      normalize([
        {
          claimNo: "C-2",
          status: "Registered",
          handler: "handler-a@example.test",
        },
      ]).snapshots,
      new Map(),
    ),
    currentManifest,
    assignClaimIds(
      normalize([
        {
          claimNo: "C-2",
          status: "Closed Paid",
          handler: "handler-a@example.test",
        },
      ]).snapshots,
      new Map(),
    ),
  ).find((change) => change.change_type === "terminal_transition_observed");
  assert.equal(derived.provenance, "system_derived");
  assert.equal(derived.timestamp_precision, "between_extracts");
});
