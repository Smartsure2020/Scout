import assert from "node:assert/strict";
import test from "node:test";

import {
  assessExtractQuality,
  buildObservedChanges,
  computeSourceChecksum,
  deduplicateChanges,
  HISTORY_SCHEMA_VERSION,
  HistoryRetryLineageConflictError,
  normalizeHistoricalRows,
  assertCorrectionRetryLineage,
  resolveCorrectionBaseline,
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

test("Boolean Repudiated source evidence never populates a repudiation date", () => {
  const result = normalize([
    {
      claimNo: "REP-BOOLEAN",
      status: "Repudiated",
      repudiated: true,
      handler: "handler-a@example.test",
    },
  ]);

  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0].repudiation_date, null);
  assert.equal("repudiated" in result.snapshots[0].source_evidence, false);
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

test("recognized terminal statuses are not classified as unmapped", () => {
  const result = normalize([
    { claimNo: "DUPLICATED", status: "Duplicated" },
    { claimNo: "REJECTED-1", status: "Rejected" },
    { claimNo: "REJECTED-2", status: "Rejected" },
    { claimNo: "UNKNOWN", status: "New open status" },
  ]);
  const byClaim = new Map(
    result.snapshots.map((snapshot) => [
      snapshot.source_claim_number,
      snapshot,
    ]),
  );
  for (const claim of ["DUPLICATED", "REJECTED-1", "REJECTED-2"]) {
    assert.equal(byClaim.get(claim).terminal, true);
    assert.equal(
      byClaim.get(claim).data_quality_flags.includes("unmapped_status"),
      false,
    );
  }
  assert.equal(
    byClaim.get("UNKNOWN").data_quality_flags.includes("unmapped_status"),
    true,
  );
  assert.equal(result.quality.unmapped_status_count, 1);
});

test("the four corrected taxonomy labels stay mapped through history normalization", () => {
  const statuses = [
    "Awaiting Agreement of Loss \\ Invoice",
    "Awaiting Final Documents",
    "Recovery in Progress",
    "TP insurer awaits Section 2 excess",
  ];
  const result = normalize(
    statuses.map((status, index) => ({
      claimNo: `TAXONOMY-${index}`,
      status,
    })),
  );
  assert.equal(result.quality.unmapped_status_count, 0);
  for (const snapshot of result.snapshots) {
    assert.equal(snapshot.data_quality_flags.includes("unmapped_status"), false);
  }
});

function lineageManifest(id, effectiveDate, overrides = {}) {
  return {
    id,
    source_system: "cardinal_claims",
    status: "accepted",
    historical_persisted: true,
    effective_date: effectiveDate,
    previous_extract_id: null,
    correction_of_extract_id: null,
    ...overrides,
  };
}

test("correction baseline resolves the genuine prior-period extract", () => {
  const prior = lineageManifest("prior", "2026-09-04");
  const original = lineageManifest("original", "2026-09-14", {
    previous_extract_id: prior.id,
  });
  const flawed = lineageManifest("flawed", "2026-09-14", {
    previous_extract_id: original.id,
    correction_of_extract_id: original.id,
  });
  const newer = lineageManifest("newer", "2026-09-15", {
    previous_extract_id: flawed.id,
  });

  const result = resolveCorrectionBaseline({
    manifests: [prior, original, flawed, newer],
    correctionOfExtractId: flawed.id,
    extractDate: "2026-09-14",
  });
  assert.equal(result.targetManifest.id, flawed.id);
  assert.equal(result.previousManifest.id, prior.id);
});

test("correction baseline follows a corrected prior-period head", () => {
  const prior = lineageManifest("prior", "2026-09-04");
  const original = lineageManifest("original", "2026-09-14", {
    previous_extract_id: prior.id,
  });
  const flawed = lineageManifest("flawed", "2026-09-14", {
    previous_extract_id: original.id,
    correction_of_extract_id: original.id,
  });
  const corrected = lineageManifest("corrected", "2026-09-14", {
    previous_extract_id: prior.id,
    correction_of_extract_id: flawed.id,
  });
  const newer = lineageManifest("newer", "2026-09-15", {
    previous_extract_id: flawed.id,
  });

  const result = resolveCorrectionBaseline({
    manifests: [prior, original, flawed, corrected, newer],
    correctionOfExtractId: newer.id,
    extractDate: "2026-09-15",
  });
  assert.equal(result.previousManifest.id, corrected.id);
});

test("correction baseline rejects invalid, superseded, ambiguous, and cyclic lineage", () => {
  const prior = lineageManifest("prior", "2026-09-04");
  const target = lineageManifest("target", "2026-09-14", {
    previous_extract_id: prior.id,
  });
  const cases = [
    {
      manifests: [prior],
      target: "missing",
      date: "2026-09-14",
      message: "not found",
    },
    {
      manifests: [prior, { ...target, status: "processing" }],
      target: target.id,
      date: "2026-09-14",
      message: "not accepted",
    },
    {
      manifests: [prior, { ...target, historical_persisted: false }],
      target: target.id,
      date: "2026-09-14",
      message: "not historically persisted",
    },
    {
      manifests: [prior, target],
      target: target.id,
      date: "2026-09-15",
      message: "effective date",
    },
    {
      manifests: [
        prior,
        target,
        lineageManifest("child", "2026-09-14", {
          previous_extract_id: prior.id,
          correction_of_extract_id: target.id,
        }),
      ],
      target: target.id,
      date: "2026-09-14",
      message: "already superseded",
    },
    {
      manifests: [
        prior,
        target,
        lineageManifest("child-a", "2026-09-14", {
          previous_extract_id: prior.id,
          correction_of_extract_id: target.id,
        }),
        lineageManifest("child-b", "2026-09-14", {
          previous_extract_id: prior.id,
          correction_of_extract_id: target.id,
        }),
      ],
      target: target.id,
      date: "2026-09-14",
      message: "ambiguous",
    },
    {
      manifests: [
        lineageManifest("cycle-target", "2026-09-14", {
          previous_extract_id: "cycle-prior",
        }),
        lineageManifest("cycle-prior", "2026-09-14", {
          previous_extract_id: "cycle-target",
        }),
      ],
      target: "cycle-target",
      date: "2026-09-14",
      message: "cycle",
    },
    {
      manifests: [
        prior,
        target,
        lineageManifest("cross-period-child", "2026-09-15", {
          previous_extract_id: prior.id,
          correction_of_extract_id: target.id,
        }),
      ],
      target: target.id,
      date: "2026-09-14",
      message: "effective date does not match",
    },
    {
      manifests: [
        prior,
        target,
        {
          ...lineageManifest("cross-source-child", "2026-09-14", {
            previous_extract_id: prior.id,
            correction_of_extract_id: target.id,
          }),
          source_system: "other_source",
        },
      ],
      target: target.id,
      date: "2026-09-14",
      message: "source system does not match",
    },
    {
      manifests: [
        prior,
        target,
        lineageManifest(target.id, "2026-09-14", {
          previous_extract_id: prior.id,
          correction_of_extract_id: target.id,
        }),
      ],
      target: target.id,
      date: "2026-09-14",
      message: "self-reference",
    },
    {
      manifests: [
        {
          ...prior,
          correction_of_extract_id: "cycle-b",
        },
        target,
        lineageManifest("cycle-a", "2026-09-04", {
          previous_extract_id: prior.id,
          correction_of_extract_id: prior.id,
        }),
        lineageManifest("cycle-b", "2026-09-04", {
          previous_extract_id: prior.id,
          correction_of_extract_id: "cycle-a",
        }),
      ],
      target: target.id,
      date: "2026-09-14",
      message: "cycle",
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () =>
        resolveCorrectionBaseline({
          manifests: entry.manifests,
          correctionOfExtractId: entry.target,
          extractDate: entry.date,
        }),
      new RegExp(entry.message),
    );
  }
});

test("correction retry lineage must match the resolved predecessor", () => {
  const expectedPrevious = lineageManifest("prior", "2026-09-04");
  const matching = {
    id: "retry",
    source_system: "cardinal_claims",
    effective_date: "2026-09-14",
    correction_of_extract_id: "target",
    previous_extract_id: expectedPrevious.id,
  };
  assert.doesNotThrow(() =>
    assertCorrectionRetryLineage({
      existingManifest: matching,
      correctionOfExtractId: "target",
      extractDate: "2026-09-14",
      previousManifest: expectedPrevious,
    }),
  );

  for (const conflict of [
    { previous_extract_id: "newer" },
    { correction_of_extract_id: "other" },
    { effective_date: "2026-09-15" },
    { source_system: "other_source" },
  ]) {
    assert.throws(
      () =>
        assertCorrectionRetryLineage({
          existingManifest: { ...matching, ...conflict },
          correctionOfExtractId: "target",
          extractDate: "2026-09-14",
          previousManifest: expectedPrevious,
        }),
      (error) =>
        error instanceof HistoryRetryLineageConflictError &&
        error.code === "history_retry_lineage_conflict",
    );
  }
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
