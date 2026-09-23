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
  resolveAuthoritativePriorPeriodManifest,
  resolveCorrectionBaseline,
  resolveLatestAuthoritativeManifest,
  resolveOrdinaryUploadLineage,
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

test("client Section 2 excess is mapped and does not count as unmapped", () => {
  const result = normalize([
    { claimNo: "CLIENT-S2-1", status: "Awaiting client's Section 2 excess" },
    { claimNo: "CLIENT-S2-2", status: "awaiting client's section 2 excess" },
  ]);
  assert.equal(result.quality.unmapped_status_count, 0);
  for (const snapshot of result.snapshots) {
    assert.equal(snapshot.operational_category, "payment");
    assert.equal(
      snapshot.data_quality_flags.includes("unmapped_status"),
      false,
    );
  }
});

test("[none] sentinel is treated as missing status, not unmapped", () => {
  const result = normalize([
    { claimNo: "NONE-1", status: "[none]" },
    { claimNo: "NONE-2", status: " [NONE] " },
  ]);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.quality.unmapped_status_count, 0);
  for (const snapshot of result.snapshots) {
    assert.equal(
      snapshot.data_quality_flags.includes("unmapped_status"),
      false,
    );
    assert.equal(
      snapshot.data_quality_flags.includes("missing_status"),
      true,
    );
    // The claim itself remains accepted (buildSnapshot only rejects rows
    // missing a claim number, not rows missing a status).
    assert.equal(snapshot.terminal, false);
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
    // A previous_extract_id-only cycle between two same-date manifests is no
    // longer an error case: the prior period is resolved by effective_date,
    // never by walking previous_extract_id, so two same-date manifests with
    // no correction_of_extract_id relationship simply mean "no prior period
    // strictly before this date" (previousManifest: null), not a cycle.
    // A stray correction that claims a parent absent from the accepted set
    // is still fail-closed, as an orphan within its own effective date.
    {
      manifests: [
        lineageManifest("real-root", "2026-09-04"),
        lineageManifest("stray", "2026-09-04", {
          correction_of_extract_id: "ghost-id-not-present",
        }),
        target,
      ],
      target: target.id,
      date: "2026-09-14",
      message: "orphan",
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
    // prior -> cycle-b -> cycle-a -> prior forms a correction_of_extract_id
    // cycle with no entry point, so every manifest for 2026-09-04 has a
    // non-null correction_of_extract_id and none qualifies as the root -
    // fail-closed via "no root", an equally precise diagnosis of the cycle.
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
      message: "no root",
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

// ── Effective-period-aware baseline resolution ───────────────────────────
// Reproduces the real production chronology that exposed the bug: a
// backdated correction of an earlier effective period, received AFTER a
// later effective-date extract already exists, must never become that later
// extract's comparison baseline just because it was received more recently.
//
//   A: 2026-09-04 ordinary
//   B: 2026-09-14 original                          previous = A
//   C: 2026-09-14 flawed correction (of B)           previous = A
//   D: 2026-09-15 ordinary                           previous = C
//   E: 2026-09-14 later correction (of C)            previous = A, received AFTER D
//   F: 2026-09-22 ordinary
//   G: 2026-09-15 correction (of D)                  previous = E   [added later]
function realSequenceFixture() {
  const A = lineageManifest("A-2026-09-04", "2026-09-04", {
    received_at: "2026-09-04T08:00:00Z",
  });
  const B = lineageManifest("B-2026-09-14-original", "2026-09-14", {
    previous_extract_id: A.id,
    received_at: "2026-09-14T08:00:00Z",
  });
  const C = lineageManifest("C-2026-09-14-flawed", "2026-09-14", {
    previous_extract_id: A.id,
    correction_of_extract_id: B.id,
    received_at: "2026-09-14T09:00:00Z",
  });
  const D = lineageManifest("D-2026-09-15", "2026-09-15", {
    previous_extract_id: C.id,
    received_at: "2026-09-15T08:00:00Z",
  });
  // E is received AFTER D even though its own effective period (09-14) is
  // earlier than D's (09-15) - this is the exact shape of the production
  // incident (NEW14's taxonomy-correction received on 09-22, after 10f/09-15
  // already existed).
  const E = lineageManifest("E-2026-09-14-later-correction", "2026-09-14", {
    previous_extract_id: A.id,
    correction_of_extract_id: C.id,
    received_at: "2026-09-22T11:00:00Z",
  });
  const F = lineageManifest("F-2026-09-22", "2026-09-22", {
    // Deliberately stored as E, reproducing the pre-fix
    // getLatestHistoryManifest() (received_at-ordered) bug's output. The
    // whole point of resolveCorrectionBaseline() no longer trusting this
    // stored pointer is that a future correction of F must resolve
    // correctly regardless of what's recorded here.
    previous_extract_id: E.id,
    received_at: "2026-09-22T15:00:00Z",
  });
  return { A, B, C, D, E, F };
}

test("ordinary upload baseline selection: a backdated correction received later does not steal the forward predecessor", () => {
  const { A, B, C, D, E, F } = realSequenceFixture();
  const manifests = [A, B, C, D, E, F];

  // What an ordinary upload for F's date (2026-09-22) must resolve to,
  // BEFORE any correction of D exists yet: the effective-period head as of
  // "just before F", which is D (09-15) - not E (09-14, merely the most
  // recently received row).
  const result = resolveAuthoritativePriorPeriodManifest({
    manifests,
    beforeDate: F.effective_date,
  });
  assert.equal(result.id, D.id);
  assert.notEqual(result.id, E.id);
});

test("NEW15-equivalent: correcting the 09-15 extract resolves to the authoritative corrected 09-14 head", () => {
  const { A, B, C, D, E } = realSequenceFixture();
  const manifests = [A, B, C, D, E];

  const result = resolveCorrectionBaseline({
    manifests,
    correctionOfExtractId: D.id,
    extractDate: D.effective_date,
  });
  assert.equal(result.targetManifest.id, D.id);
  assert.equal(result.previousManifest.id, E.id);
});

test("NEW22-equivalent: correcting the 09-22 extract resolves to the corrected 09-15 head, ignoring F's own stale stored pointer", () => {
  const { A, B, C, D, E, F } = realSequenceFixture();
  const G = lineageManifest("G-2026-09-15-correction", "2026-09-15", {
    previous_extract_id: E.id,
    correction_of_extract_id: D.id,
    received_at: "2026-09-23T08:00:00Z",
  });
  const manifests = [A, B, C, D, E, F, G];

  const result = resolveCorrectionBaseline({
    manifests,
    correctionOfExtractId: F.id,
    extractDate: F.effective_date,
  });
  assert.equal(result.targetManifest.id, F.id);
  assert.equal(result.previousManifest.id, G.id);
  assert.notEqual(result.previousManifest.id, E.id);
  assert.notEqual(result.previousManifest.id, D.id);
  assert.notEqual(result.previousManifest.id, C.id);
});

test("resolveAuthoritativePriorPeriodManifest returns null when no prior effective period exists", () => {
  const A = lineageManifest("only", "2026-09-04");
  assert.equal(
    resolveAuthoritativePriorPeriodManifest({
      manifests: [A],
      beforeDate: "2026-09-04",
    }),
    null,
  );
  assert.equal(
    resolveAuthoritativePriorPeriodManifest({
      manifests: [],
      beforeDate: "2026-09-04",
    }),
    null,
  );
});

test("resolveAuthoritativePriorPeriodManifest fails closed on ambiguous, cyclic, and orphaned same-date lineage", () => {
  const cases = [
    {
      name: "ambiguous independent extracts",
      manifests: [
        lineageManifest("root-a", "2026-09-14"),
        lineageManifest("root-b", "2026-09-14"),
      ],
      beforeDate: "2026-09-15",
      message: "ambiguous",
    },
    {
      name: "correction siblings",
      manifests: [
        lineageManifest("root", "2026-09-14"),
        lineageManifest("sibling-a", "2026-09-14", {
          correction_of_extract_id: "root",
        }),
        lineageManifest("sibling-b", "2026-09-14", {
          correction_of_extract_id: "root",
        }),
      ],
      beforeDate: "2026-09-15",
      message: "ambiguous",
    },
    {
      name: "correction_of_extract_id cycle with no entry point",
      manifests: [
        lineageManifest("cycle-a", "2026-09-14", {
          correction_of_extract_id: "cycle-c",
        }),
        lineageManifest("cycle-b", "2026-09-14", {
          correction_of_extract_id: "cycle-a",
        }),
        lineageManifest("cycle-c", "2026-09-14", {
          correction_of_extract_id: "cycle-b",
        }),
      ],
      beforeDate: "2026-09-15",
      message: "no root",
    },
    {
      name: "orphan correction claiming an absent parent",
      manifests: [
        lineageManifest("root", "2026-09-14"),
        lineageManifest("orphan", "2026-09-14", {
          correction_of_extract_id: "ghost-id-not-present",
        }),
      ],
      beforeDate: "2026-09-15",
      message: "orphan",
    },
    {
      // beforeDate is the child's OWN date (excluded by the strict "<"
      // period filter), so the resolver picks the root's date (09-14) as
      // the latest prior period and walks forward from it - discovering
      // the cross-date child as a candidate correction child of root via
      // correctionChildren(), which is what actually raises this error.
      name: "cross-effective-date correction edge",
      manifests: [
        lineageManifest("root", "2026-09-14"),
        lineageManifest("cross-date-child", "2026-09-15", {
          correction_of_extract_id: "root",
        }),
      ],
      beforeDate: "2026-09-15",
      message: "effective date does not match",
    },
  ];
  for (const entry of cases) {
    assert.throws(
      () =>
        resolveAuthoritativePriorPeriodManifest({
          manifests: entry.manifests,
          beforeDate: entry.beforeDate,
        }),
      new RegExp(entry.message),
      entry.name,
    );
  }
});

test("resolveAuthoritativePriorPeriodManifest ignores portfolio scope: preserves the existing quality-warning contract instead of filtering by it", () => {
  // assessExtractQuality() already treats a scope mismatch between an
  // extract and its resolved previousManifest as a "different_portfolio_scope"
  // quality warning, not a reason to pick a different baseline. The
  // effective-date resolver deliberately preserves that contract rather than
  // becoming scope-aware itself.
  const A = lineageManifest("A", "2026-09-04", {
    source_metadata: { portfolio_scope: "claims" },
  });
  const result = resolveAuthoritativePriorPeriodManifest({
    manifests: [A],
    beforeDate: "2026-09-14",
  });
  assert.equal(result.id, A.id);
  const quality = assessExtractQuality(
    { quality: { hard_rejection: false, accepted_claim_count: 5 } },
    {
      previousManifest: result,
      sourceMetadata: { portfolio_scope: "broker" },
    },
  );
  assert.ok(quality.warnings.includes("different_portfolio_scope"));
});

test("resolveLatestAuthoritativeManifest reports the latest authoritative EFFECTIVE period, not the latest received row", () => {
  const { A, B, C, D, E } = realSequenceFixture();
  // Before D exists: E (received later) must not outrank C's effective date.
  assert.equal(
    resolveLatestAuthoritativeManifest({ manifests: [A, B, C] }).id,
    C.id,
  );
  // Once D (2026-09-15) exists, it is the latest effective period even
  // though E (2026-09-14, corrected) was received after it.
  assert.equal(
    resolveLatestAuthoritativeManifest({ manifests: [A, B, C, D, E] }).id,
    D.id,
  );
});

// ── Ordinary (implicit) same-date correction lineage ──────────────────────
// An ordinary upload (no explicit correctionOfExtractId) for a date Scout
// already has an authoritative extract for becomes an implicit correction of
// that same-date head - PR #15's original contract. This must stay separate
// from the genuine prior-period comparison baseline (previousManifest),
// which resolveAuthoritativePriorPeriodManifest() always resolves strictly
// before the upload's date and therefore never same-date.
test("resolveOrdinaryUploadLineage: a same-date re-upload targets the existing head, with the prior period as a separate, earlier baseline", () => {
  const A = lineageManifest("A-2026-09-14", "2026-09-14");
  const B = lineageManifest("B-2026-09-15-original", "2026-09-15", {
    previous_extract_id: A.id,
  });
  // This is the exact upload-time view: B exists, C does not yet.
  const result = resolveOrdinaryUploadLineage({
    manifests: [A, B],
    extractDate: "2026-09-15",
  });
  assert.equal(result.correctionTargetManifest.id, B.id);
  assert.equal(result.previousManifest.id, A.id);
  assert.notEqual(result.previousManifest.id, B.id);
});

test("resolveOrdinaryUploadLineage: no same-date manifest means no implicit correction target", () => {
  const A = lineageManifest("A-2026-09-14", "2026-09-14");
  const result = resolveOrdinaryUploadLineage({
    manifests: [A],
    extractDate: "2026-09-22",
  });
  assert.equal(result.correctionTargetManifest, null);
  assert.equal(result.previousManifest.id, A.id);
});

test("resolveOrdinaryUploadLineage: repeated same-date re-uploads form B -> C -> D with exactly one authoritative head", () => {
  const A = lineageManifest("A-2026-09-14", "2026-09-14");
  const B = lineageManifest("B-2026-09-15-original", "2026-09-15", {
    previous_extract_id: A.id,
  });
  // Upload-time view when C is created: only A and B exist yet.
  const forC = resolveOrdinaryUploadLineage({
    manifests: [A, B],
    extractDate: "2026-09-15",
  });
  assert.equal(forC.correctionTargetManifest.id, B.id);
  assert.equal(forC.previousManifest.id, A.id);

  const C = lineageManifest("C-2026-09-15-reupload", "2026-09-15", {
    previous_extract_id: A.id,
    correction_of_extract_id: forC.correctionTargetManifest.id,
  });
  // Upload-time view when D is created: A, B, C all exist.
  const forD = resolveOrdinaryUploadLineage({
    manifests: [A, B, C],
    extractDate: "2026-09-15",
  });
  assert.equal(
    forD.correctionTargetManifest.id,
    C.id,
    "the current authoritative head is C, not the original B",
  );
  assert.equal(forD.previousManifest.id, A.id);

  const D = lineageManifest("D-2026-09-15-second-reupload", "2026-09-15", {
    previous_extract_id: A.id,
    correction_of_extract_id: forD.correctionTargetManifest.id,
  });
  const allFour = [A, B, C, D];
  // Exactly one authoritative 09-15 head afterward: D.
  assert.equal(
    resolveOrdinaryUploadLineage({ manifests: allFour, extractDate: "2026-09-16" })
      .correctionTargetManifest,
    null,
  );
  assert.equal(
    resolveLatestAuthoritativeManifest({ manifests: allFour }).id,
    D.id,
  );
  // A future ordinary upload for a later date resolves its prior-period
  // baseline to D, the current 09-15 head - not B, not C.
  assert.equal(
    resolveAuthoritativePriorPeriodManifest({
      manifests: allFour,
      beforeDate: "2026-09-22",
    }).id,
    D.id,
  );
});

test("resolveOrdinaryUploadLineage fails closed before any write when the same-date authority is malformed", () => {
  const cases = [
    {
      name: "ambiguous independent extracts",
      manifests: [
        lineageManifest("root-a", "2026-09-15"),
        lineageManifest("root-b", "2026-09-15"),
      ],
      message: "ambiguous",
    },
    {
      name: "orphan correction",
      manifests: [
        lineageManifest("root", "2026-09-15"),
        lineageManifest("orphan", "2026-09-15", {
          correction_of_extract_id: "ghost-id-not-present",
        }),
      ],
      message: "orphan",
    },
    {
      name: "cross-effective-date correction edge",
      manifests: [
        lineageManifest("root", "2026-09-14"),
        lineageManifest("cross-date-child", "2026-09-15", {
          correction_of_extract_id: "root",
        }),
      ],
      message: "effective date does not match",
    },
  ];
  for (const entry of cases) {
    assert.throws(
      () =>
        resolveOrdinaryUploadLineage({
          manifests: entry.manifests,
          extractDate: "2026-09-15",
        }),
      new RegExp(entry.message),
      entry.name,
    );
  }
});

test("change ledger for a same-date corrected re-upload compares against the genuine prior period, not the superseded same-date original", () => {
  // A: 09-14 authoritative, claim X = Registered
  // B: 09-15 original,      claim X = Payment Requested
  // C: 09-15 corrected re-upload (same-date correction of B), claim X = Registered
  //
  // C must NOT be reported as "Payment Requested -> Registered" merely
  // because B was the immediately-preceding same-date version - that status
  // never genuinely changed relative to the true prior period, A.
  const ids = new Map();
  const aNormalized = normalize(
    [{ claimNo: "X-1", status: "Registered", handler: "handler-a@example.test" }],
    "2026-09-14",
  );
  const bNormalized = normalize(
    [{ claimNo: "X-1", status: "Payment Requested", handler: "handler-a@example.test" }],
    "2026-09-15",
  );
  const cNormalized = normalize(
    [{ claimNo: "X-1", status: "Registered", handler: "handler-a@example.test" }],
    "2026-09-15",
  );
  const aSnapshots = assignClaimIds(aNormalized.snapshots, ids);
  const bSnapshots = assignClaimIds(bNormalized.snapshots, ids);
  const cSnapshots = assignClaimIds(cNormalized.snapshots, ids);

  const qualitySummary = { normalized_claim_count: 1, completeness_state: "complete", comparable_to_previous: true };
  const aManifest = manifest("A-2026-09-14", "2026-09-14T08:00:00.000Z", qualitySummary);
  const bManifest = manifest("B-2026-09-15-original", "2026-09-15T08:00:00.000Z", qualitySummary, {
    previous_extract_id: aManifest.id,
    correction_of_extract_id: null,
    historical_persisted: true,
  });
  const cManifest = manifest("C-2026-09-15-reupload", "2026-09-15T09:00:00.000Z", qualitySummary, {
    previous_extract_id: aManifest.id,
    correction_of_extract_id: bManifest.id,
    historical_persisted: true,
  });

  // This is what preserveHistoricalExtract() actually resolves for C at
  // upload time (A and B already accepted+persisted, C not yet created).
  const lineageForC = resolveOrdinaryUploadLineage({
    manifests: [
      { ...aManifest, source_system: "cardinal_claims", status: "accepted", historical_persisted: true },
      { ...bManifest, source_system: "cardinal_claims", status: "accepted" },
    ],
    extractDate: "2026-09-15",
  });
  assert.equal(lineageForC.correctionTargetManifest.id, bManifest.id);
  assert.equal(lineageForC.previousManifest.id, aManifest.id);

  const changesAgainstResolvedBaseline = buildObservedChanges(
    aManifest,
    aSnapshots,
    cManifest,
    cSnapshots,
  );
  assert.equal(
    changesAgainstResolvedBaseline.some(
      (change) => change.change_type === "status_changed",
    ),
    false,
    "no false status change against the genuine prior period",
  );

  // Contrast: comparing against B (the superseded same-date original,
  // exactly what the bug this fix prevents would have done) DOES produce a
  // false status_changed row - demonstrating why the two lineage concepts
  // must not be conflated.
  const changesAgainstSupersededOriginal = buildObservedChanges(
    bManifest,
    bSnapshots,
    cManifest,
    cSnapshots,
  );
  assert.equal(
    changesAgainstSupersededOriginal.some(
      (change) => change.change_type === "status_changed",
    ),
    true,
  );
});

test("computeSourceChecksum: same nominal date with a different payload produces a different checksum", async () => {
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
