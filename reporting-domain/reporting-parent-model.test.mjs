// MS2 reporting read-model regressions: logical parent inventory over EXISTING
// (pre-write-path) snapshots, financial fail-closed, and C-metric
// unavailability. Critically, the multi-row parent here is persisted the OLD
// way (identity_matchable=false, differing per-row claim_ids, identity_key
// null) - proving the read-model fix works before any future write-path data
// exists, purely by grouping on source_claim_number.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportSnapshot,
  deriveParentLifecycleEvents,
  reportingPeriod,
} from "./reporting-metrics.mjs";

const users = [
  {
    id: "handler-1",
    email: "handler.one@example.test",
    display_name: "Handler One",
    role: "handler",
    active: true,
  },
];

function manifest(id, effectiveDate) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: `${id}-checksum`,
    effective_date: effectiveDate,
    received_at: `${effectiveDate}T12:00:00.000Z`,
    status: "accepted",
    historical_persisted: true,
    claim_count: 3,
    accepted_claim_count: 3,
    quality_summary: {
      completeness_state: "complete",
      comparable_to_previous: true,
      warnings: [],
    },
    previous_extract_id: null,
    correction_of_extract_id: null,
  };
}

function snapshot(overrides = {}) {
  const base = {
    extract_id: "closing",
    claim_id: "canonical-uuid",
    identity_key: "cardinal_claims:SOLO-1",
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: "row-0",
    source_row_index: 0,
    source_claim_number: "SOLO-1",
    handler_source: "Handler One",
    handler_email: "handler.one@example.test",
    resolved_scout_user_id: "handler-1",
    handler_resolution: "resolved",
    status_raw: "Registered",
    status_normalized: "registered",
    terminal: false,
    open: true,
    registered_date: "2026-08-01",
    dol_date: "2026-07-20",
    movement_date: "2026-08-20",
    repudiation_date: null,
    source_event_at: null,
    outstanding: 1000,
    estimate: 1500,
    paid: 0,
    mandate: 0,
    insurer: "Insurer",
    peril: "Fire",
    peril_type: "Property",
    insured: "Insured SOLO-1",
    description: "Fixture",
    comments: null,
    calendar_age: 20,
    working_age: 15,
    age_band: "0-30",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: [],
  };
  return { ...base, ...overrides };
}

// A closing extract with one single-row parent (SOLO-1) and one legitimate
// multi-section parent (MULTI-1) stored the OLD ambiguous way.
function closingSnapshots() {
  return [
    snapshot(),
    snapshot({
      claim_id: "ambiguous-a",
      identity_key: null,
      identity_matchable: false,
      identity_confidence: "ambiguous",
      source_row_identity: "row-1",
      source_row_index: 1,
      source_claim_number: "MULTI-1",
      insured: "Insured MULTI-1",
      outstanding: 500,
      estimate: 400,
      paid: 100,
      data_quality_flags: ["parent_identity_conflict"].slice(0, 0), // no conflict: same invariants
    }),
    snapshot({
      claim_id: "ambiguous-b",
      identity_key: null,
      identity_matchable: false,
      identity_confidence: "ambiguous",
      source_row_identity: "row-2",
      source_row_index: 2,
      source_claim_number: "MULTI-1",
      insured: "Insured MULTI-1",
      outstanding: 700,
      estimate: 400,
      paid: 250,
    }),
  ];
}

function evidence() {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  return {
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      ["opening", [snapshot({ extract_id: "opening" })]],
      ["closing", closingSnapshots()],
    ]),
    changes: [],
    activeUsers: users,
  };
}

function report() {
  return buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...evidence(),
  });
}

test("multi-row parent counts once in closing inventory (not excluded, not per-row)", () => {
  const snap = report();
  // SOLO-1 + MULTI-1 = 2 logical parents (3 source rows).
  assert.equal(snap.metrics.closing_inventory.value, 2);
  const ids = snap.metrics.closing_inventory.claim_population.claim_ids;
  assert.equal(ids.length, 2);
  // The old-ambiguous multi-row parent is represented by its logical parent
  // key, never a child UUID.
  assert.ok(ids.includes("cardinal_claims:MULTI-1"));
  assert.ok(!ids.includes("ambiguous-a"));
  assert.ok(!ids.includes("ambiguous-b"));
});

test("financial metrics fail closed (value null) when a multi-row parent is in scope", () => {
  const snap = report();
  for (const id of [
    "financial_open_outstanding",
    "financial_estimate_total",
    "financial_paid_total",
  ]) {
    const metric = snap.metrics[id];
    assert.equal(metric.availability, "unavailable");
    assert.equal(metric.value, null);
    assert.equal(metric.details.reason, "financial_aggregation_unresolved");
    assert.ok(metric.details.unresolved_claim_numbers.includes("MULTI-1"));
    // Diagnostic subtotal only - never published as the value.
    assert.equal(typeof metric.details.known_single_row_subtotal, "number");
  }
  // SOLO-1 outstanding is the single-row subtotal diagnostic.
  assert.equal(
    snap.metrics.financial_open_outstanding.details.known_single_row_subtotal,
    1000,
  );
});

test("C-metrics become wholly unavailable when a multi-row parent is unresolved", () => {
  const snap = report();
  for (const id of [
    "sla_compliance",
    "sla_breaches",
    "no_movement_over_14",
    "no_movement_over_30",
    "ready_to_close",
    "zero_estimate_payment_request",
    "operational_health",
    "handler_performance",
    "assignment_activity",
  ]) {
    assert.equal(
      snap.metrics[id].availability,
      "unavailable",
      `${id} should be unavailable`,
    );
    assert.equal(snap.metrics[id].value, null);
    assert.equal(
      snap.metrics[id].details.excluded_parent_count,
      1,
      `${id} excluded_parent_count`,
    );
  }
});

test("report claim row for a multi-row parent: parent key set, claim_id null, financials null", () => {
  const snap = report();
  const row = snap.claim_rows.find(
    (claim) => claim.parent_identity_key === "cardinal_claims:MULTI-1",
  );
  assert.ok(row, "multi-row parent row present");
  assert.equal(row.claim_id, null); // no canonical UUID; never a child UUID
  assert.equal(row.source_claim_number, "MULTI-1");
  assert.equal(row.outstanding_snapshot, null);
  assert.equal(row.estimate_snapshot, null);
  assert.equal(row.paid_snapshot, null);
  assert.equal(row.relevant_flags.row_count, 2);
});

test("future canonical multi-row parent: shared claim_id UUID, row_count>1, financials still null", () => {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  // Two section rows written the FUTURE way: same shared canonical parent UUID.
  const futureRows = [
    snapshot({
      claim_id: "parent-uuid",
      identity_key: "cardinal_claims:FUT-1",
      identity_matchable: true,
      identity_confidence: "source_scoped",
      source_row_identity: "row-0",
      source_row_index: 0,
      source_claim_number: "FUT-1",
      insured: "Insured FUT-1",
      outstanding: 500,
    }),
    snapshot({
      claim_id: "parent-uuid",
      identity_key: "cardinal_claims:FUT-1",
      identity_matchable: true,
      identity_confidence: "source_scoped",
      source_row_identity: "row-1",
      source_row_index: 1,
      source_claim_number: "FUT-1",
      insured: "Insured FUT-1",
      outstanding: 700,
    }),
  ];
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      ["opening", [snapshot({ extract_id: "opening" })]],
      ["closing", [snapshot(), ...futureRows]],
    ]),
    changes: [],
    activeUsers: users,
  });
  // Counted once as a logical parent, keyed by its canonical UUID.
  assert.equal(snap.metrics.closing_inventory.value, 2);
  assert.ok(
    snap.metrics.closing_inventory.claim_population.claim_ids.includes(
      "parent-uuid",
    ),
  );
  const row = snap.claim_rows.find(
    (claim) => claim.parent_identity_key === "cardinal_claims:FUT-1",
  );
  assert.ok(row);
  assert.equal(row.claim_id, "parent-uuid"); // shared canonical UUID, not a child
  assert.equal(row.relevant_flags.row_count, 2);
  // Financial aggregation still unproven for multi-row parents -> NULL.
  assert.equal(row.outstanding_snapshot, null);
  assert.equal(row.estimate_snapshot, null);
  assert.equal(row.paid_snapshot, null);
});

test("single-row-only portfolio keeps financial metrics available and numeric", () => {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      ["opening", [snapshot({ extract_id: "opening" })]],
      ["closing", [snapshot()]],
    ]),
    changes: [],
    activeUsers: users,
  });
  assert.equal(snap.metrics.closing_inventory.value, 1);
  assert.equal(
    snap.metrics.financial_open_outstanding.availability,
    "available",
  );
  assert.equal(snap.metrics.financial_open_outstanding.value, 1000);
  assert.equal(snap.metrics.sla_compliance.availability, "available");
});

// --- MS2-DIFF-REMEDIATION-1: stable canonical parent UUID / closure domain / baseline ---

// Old ambiguous section row: identity_matchable false, per-row CHILD claim_id,
// null identity_key, shared source_claim_number. This is pre-MS2 lineage.
function ambRow(extractId, childId, index, overrides = {}) {
  return snapshot({
    extract_id: extractId,
    claim_id: childId,
    identity_key: null,
    identity_matchable: false,
    identity_confidence: "ambiguous",
    source_row_identity: `row-${childId}`,
    source_row_index: index,
    source_claim_number: "AMB-1",
    insured: "Insured AMB-1",
    ...overrides,
  });
}

test("old ambiguous parent at cardinality 1 in closing keeps parent_identity_key + NULL claim_id (never promotes a child UUID)", () => {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      // opening: two child rows; closing: only one child row remains (2 -> 1).
      [
        "opening",
        [ambRow("opening", "child-a", 0), ambRow("opening", "child-b", 1)],
      ],
      ["closing", [ambRow("closing", "child-a", 0)]],
    ]),
    changes: [],
    activeUsers: users,
  });
  const ids = snap.metrics.closing_inventory.claim_population.claim_ids;
  // Counted once, under the stable parent key - NOT the surviving child UUID.
  assert.deepEqual(ids, ["cardinal_claims:AMB-1"]);
  assert.ok(!ids.includes("child-a"));
  const rows = snap.claim_rows.filter(
    (row) => row.parent_identity_key === "cardinal_claims:AMB-1",
  );
  assert.equal(rows.length, 1, "no duplicate report population rows");
  assert.equal(rows[0].claim_id, null); // never a child UUID
});

test("old ambiguous closure: source-explicit child UUID + derived parent terminal count once", () => {
  const opening = manifest("opening", "2026-08-24"); // baseline (before period)
  const closing = manifest("closing", "2026-08-27");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      // Open in the baseline, terminal in the closing extract (derived
      // open -> terminal), stored the OLD way with child UUIDs.
      [
        "opening",
        [ambRow("opening", "child-a", 0), ambRow("opening", "child-b", 1)],
      ],
      [
        "closing",
        [
          ambRow("closing", "child-a", 0, {
            status_raw: "Closed Paid",
            status_normalized: "closed paid",
            terminal: true,
            open: false,
          }),
          ambRow("closing", "child-b", 1, {
            status_raw: "Closed Paid",
            status_normalized: "closed paid",
            terminal: true,
            open: false,
          }),
        ],
      ],
    ]),
    changes: [
      {
        // Source-explicit closure keyed by a CHILD UUID (old lineage).
        claim_id: "child-a",
        change_type: "closure_event",
        provenance: "source_explicit",
        source_event_at: "2026-08-27T09:00:00.000Z",
        observed_at: "2026-08-27T10:00:00.000Z",
      },
    ],
    activeUsers: users,
  });
  // Exact (child-a normalized to the parent) and observed (derived parent
  // terminal) are the SAME logical parent -> counted once, not twice.
  assert.equal(snap.metrics.claims_closed.value, 1);
  assert.equal(snap.metrics.claims_closed.precision, "mixed");
  assert.equal(snap.metrics.claims_closed_exact.value, 1);
  assert.equal(snap.metrics.claims_closed_observed.value, 1);
  assert.deepEqual(snap.metrics.claims_closed.claim_population.claim_ids, [
    "cardinal_claims:AMB-1",
  ]);
});

test("canonical single-row exact + observed closure still counts once with both evidences", () => {
  const opening = manifest("opening", "2026-08-24");
  const closing = manifest("closing", "2026-08-27");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      ["opening", [snapshot()]], // SOLO-1 open, canonical UUID
      [
        "closing",
        [
          snapshot({
            status_raw: "Closed Paid",
            status_normalized: "closed paid",
            terminal: true,
            open: false,
          }),
        ],
      ],
    ]),
    changes: [
      {
        claim_id: "canonical-uuid",
        change_type: "closure_event",
        provenance: "source_explicit",
        source_event_at: "2026-08-27T09:00:00.000Z",
        observed_at: "2026-08-27T10:00:00.000Z",
      },
    ],
    activeUsers: users,
  });
  assert.equal(snap.metrics.claims_closed.value, 1);
  assert.equal(snap.metrics.claims_closed.precision, "mixed");
  assert.equal(snap.metrics.claims_closed_exact.value, 1);
  assert.equal(snap.metrics.claims_closed_observed.value, 1);
  assert.deepEqual(snap.metrics.claims_closed.claim_population.claim_ids, [
    "canonical-uuid",
  ]);
});

test("first_observed: available with a pre-period baseline", () => {
  const baseline = manifest("baseline", "2026-08-21"); // strictly before period start
  const inPeriodA = manifest("a", "2026-08-26");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [baseline, inPeriodA],
    snapshotsByExtract: new Map([
      ["baseline", [snapshot({ extract_id: "baseline" })]],
      [
        "a",
        [
          snapshot({ extract_id: "a" }),
          snapshot({
            extract_id: "a",
            claim_id: "new-uuid",
            identity_key: "cardinal_claims:NEW-1",
            source_claim_number: "NEW-1",
            registered_date: "2026-06-01",
          }),
        ],
      ],
    ]),
    changes: [],
    activeUsers: users,
  });
  assert.equal(
    snap.metrics.new_claims_first_observed.availability,
    "available",
  );
  assert.deepEqual(
    snap.metrics.new_claims_first_observed.claim_population.claim_ids,
    ["new-uuid"],
  );
});

test("first_observed: unavailable with one in-period extract and no baseline", () => {
  const only = manifest("only", "2026-08-26");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [only],
    snapshotsByExtract: new Map([["only", [snapshot({ extract_id: "only" })]]]),
    changes: [],
    activeUsers: users,
  });
  assert.equal(
    snap.metrics.new_claims_first_observed.availability,
    "unavailable",
  );
});

test("first_observed: unavailable with two in-period extracts but no pre-period baseline (no hidden partial)", () => {
  // Both extracts fall inside the weekly period; there is no authoritative
  // extract before it, so the first in-period population has no predecessor.
  const first = manifest("first", "2026-08-25");
  const second = manifest("second", "2026-08-27");
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [first, second],
    snapshotsByExtract: new Map([
      ["first", [snapshot({ extract_id: "first" })]],
      [
        "second",
        [
          snapshot({ extract_id: "second" }),
          snapshot({
            extract_id: "second",
            claim_id: "new-uuid",
            identity_key: "cardinal_claims:NEW-1",
            source_claim_number: "NEW-1",
          }),
        ],
      ],
    ]),
    changes: [],
    activeUsers: users,
  });
  assert.equal(
    snap.metrics.new_claims_first_observed.availability,
    "unavailable",
  );
  assert.equal(snap.metrics.new_claims_first_observed.value, null);
});

// --- MS2 REMEDIATION ROUND 2: LONGITUDINAL canonical parent identity ---
//
// The pre-MS2 normalizer marked a row matchable whenever its claim number was
// not duplicated IN THAT EXTRACT. A legitimate ambiguous lineage whose
// cardinality changes 2 -> 1 -> 2 therefore presents a MATCHABLE SINGLETON in
// the middle extract, with a real identity_key and a single child UUID. Canonical
// parenthood decided from that one extract would wrongly promote the singleton's
// UUID to logical-parent identity and flip the reporting reference id mid-lineage.
// These regressions prove parenthood is resolved LONGITUDINALLY over the whole
// authoritative lineage, so the stable parent_identity_key wins throughout.

// Extract A: two child rows, old ambiguous (matchable:false, null identity_key).
function ambRowA(childId, index) {
  return snapshot({
    extract_id: "ext-a",
    claim_id: childId,
    identity_key: null,
    identity_matchable: false,
    identity_confidence: "ambiguous",
    source_row_identity: `row-${childId}`,
    source_row_index: index,
    source_claim_number: "AMB-1",
    insured: "Insured AMB-1",
  });
}
// Extract B: ONE row that the OLD normalizer marked MATCHABLE (not duplicated in
// B), with a real identity_key and a single child UUID. This is the trap.
function matchableSingletonB(overrides = {}) {
  return snapshot({
    extract_id: "ext-b",
    claim_id: "singleton-uuid",
    identity_key: "cardinal_claims:AMB-1",
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: "row-singleton",
    source_row_index: 0,
    source_claim_number: "AMB-1",
    insured: "Insured AMB-1",
    ...overrides,
  });
}
// Extract C: back to two child rows, old ambiguous again.
function ambRowC(childId, index) {
  return snapshot({
    extract_id: "ext-c",
    claim_id: childId,
    identity_key: null,
    identity_matchable: false,
    identity_confidence: "ambiguous",
    source_row_identity: `row-${childId}`,
    source_row_index: index,
    source_claim_number: "AMB-1",
    insured: "Insured AMB-1",
  });
}
// Extract C rows in a terminal (closed) state - the derived open->terminal parent
// transition that observed-closure depends on.
function ambRowCTerminal(childId, index) {
  return {
    ...ambRowC(childId, index),
    status_raw: "Closed Paid",
    status_normalized: "closed paid",
    terminal: true,
    open: false,
  };
}

test("legacy 2->1->2 lineage: one logical parent across A->B->C, population always cardinal_claims:AMB-1, claim_id NULL, no manufactured lifecycle", () => {
  // A is the pre-period baseline; B and C fall inside the weekly period; C is
  // the closing extract. The matchable singleton at B must NOT become canonical.
  const extA = manifest("ext-a", "2026-08-21"); // baseline (strictly before period)
  const extB = manifest("ext-b", "2026-08-25"); // in period
  const extC = manifest("ext-c", "2026-08-27"); // in period, closing
  const snapshotsByExtract = new Map([
    ["ext-a", [ambRowA("child-a", 0), ambRowA("child-b", 1)]],
    ["ext-b", [matchableSingletonB()]],
    ["ext-c", [ambRowC("child-c", 0), ambRowC("child-d", 1)]],
  ]);
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [extA, extB, extC],
    snapshotsByExtract,
    changes: [],
    activeUsers: users,
  });

  // Closing inventory (extract C, cardinality 2) counts the parent ONCE, under
  // the stable parent key - never the surviving child UUIDs.
  assert.deepEqual(snap.metrics.closing_inventory.claim_population.claim_ids, [
    "cardinal_claims:AMB-1",
  ]);
  // The v2 report population row uses the parent key, claim_id NULL, once.
  const rows = snap.claim_rows.filter(
    (row) => row.parent_identity_key === "cardinal_claims:AMB-1",
  );
  assert.equal(rows.length, 1, "no duplicate population rows");
  assert.equal(rows[0].claim_id, null, "never promotes the singleton child UUID");
  // The singleton's UUID must appear NOWHERE in any metric population.
  for (const [, value] of Object.entries(snap.metrics)) {
    const ids = value?.claim_population?.claim_ids || [];
    assert.ok(
      !ids.includes("singleton-uuid"),
      "singleton child UUID never enters a population",
    );
    assert.ok(!ids.includes("child-a"));
    assert.ok(!ids.includes("child-c"));
  }

  // The parent is open throughout, never disappears, and is not closed - so the
  // 2 -> 1 -> 2 cardinality change manufactures no closure.
  assert.equal(snap.metrics.claims_closed.value, 0);
  assert.equal(snap.activity.disappearance_is_not_closure, true);
});

test("legacy 2->1->2 lineage: lifecycle derivation manufactures no first_observed / missing / reopened and keeps the stable parent ref", () => {
  const extA = manifest("ext-a", "2026-08-21"); // baseline
  const extB = manifest("ext-b", "2026-08-25");
  const extC = manifest("ext-c", "2026-08-27");
  const snapshotsByExtract = new Map([
    ["ext-a", [ambRowA("child-a", 0), ambRowA("child-b", 1)]],
    ["ext-b", [matchableSingletonB()]],
    ["ext-c", [ambRowC("child-c", 0), ambRowC("child-d", 1)]],
  ]);
  const snap = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [extA, extB, extC],
    snapshotsByExtract,
    changes: [],
    activeUsers: users,
  });
  // first_observed is a complete metric (baseline exists) but the parent was
  // present since the baseline, so it is NOT counted as newly first observed.
  assert.equal(
    snap.metrics.new_claims_first_observed.availability,
    "available",
  );
  const foIds = snap.metrics.new_claims_first_observed.claim_population.claim_ids;
  assert.ok(!foIds.includes("cardinal_claims:AMB-1"));
  assert.ok(!foIds.includes("singleton-uuid"));

  // Inspect the raw lifecycle stream directly: the parent is present in the
  // baseline (A), B and C - so A->B and B->C are both present->present. No
  // first_observed, no missing_from_extract, no reopened may be emitted for the
  // stable parent, and any event that exists must carry the parent key ref, never
  // a child UUID or the singleton UUID.
  const period = reportingPeriod("weekly", "2026-08-24");
  const events = deriveParentLifecycleEvents(
    [extA, extB, extC],
    snapshotsByExtract,
    period,
  );
  const forParent = events.filter(
    (event) => event.parent_identity_key === "cardinal_claims:AMB-1",
  );
  assert.equal(
    forParent.filter((event) => event.type === "first_observed").length,
    0,
    "no manufactured first_observed",
  );
  assert.equal(
    forParent.filter((event) => event.type === "missing_from_extract").length,
    0,
    "no manufactured missing_from_extract",
  );
  assert.equal(
    forParent.filter((event) => event.type === "reopened").length,
    0,
    "no manufactured reopened",
  );
  for (const event of forParent) {
    assert.equal(
      event.claim_ref,
      "cardinal_claims:AMB-1",
      "lifecycle ref stays in the stable parent domain",
    );
  }
  assert.equal(snap.metrics.claims_closed.value, 0);
  assert.equal(snap.activity.disappearance_is_not_closure, true);
});

test("no reference-id flip at B: PRE-PERIOD ambiguity (not future evidence) keeps the closing singleton at cardinal_claims:AMB-1, and a post-period extract is IGNORED", () => {
  // The ambiguity that defeats the singleton trap comes ENTIRELY from A, the
  // pre-period baseline. B is the in-period closing extract - the matchable
  // singleton the old per-extract logic would promote to singleton-uuid.
  const extA = manifest("ext-a", "2026-08-21"); // baseline, before period
  const extB = manifest("ext-b", "2026-08-27"); // in period, closing boundary
  const extC = manifest("ext-c", "2026-09-07"); // AFTER the weekly period
  const aRows = [ambRowA("child-a", 0), ambRowA("child-b", 1)];
  const bRows = [matchableSingletonB()];
  const cRows = [ambRowC("child-c", 0), ambRowC("child-d", 1)];

  const run = (manifests, byExtract) =>
    buildReportSnapshot({
      reportType: "weekly",
      periodStart: "2026-08-24",
      manifests,
      snapshotsByExtract: byExtract,
      changes: [],
      activeUsers: users,
    });

  // C ABSENT: only the pre-period baseline supplies ambiguity.
  const withoutC = run(
    [extA, extB],
    new Map([
      ["ext-a", aRows],
      ["ext-b", bRows],
    ]),
  );
  // C PRESENT but AFTER the reporting boundary: it must be IGNORED entirely.
  const withC = run(
    [extA, extB, extC],
    new Map([
      ["ext-a", aRows],
      ["ext-b", bRows],
      ["ext-c", cRows],
    ]),
  );

  for (const [label, snap] of [
    ["withoutC", withoutC],
    ["withC", withC],
  ]) {
    assert.equal(snap.closing_extract_id, "ext-b", `${label}: B is closing`);
    // The closing extract is the matchable singleton, yet the reference id is the
    // stable parent key - NOT singleton-uuid - because A (pre-period) is ambiguous.
    assert.deepEqual(
      snap.metrics.closing_inventory.claim_population.claim_ids,
      ["cardinal_claims:AMB-1"],
      `${label}: closing inventory ref`,
    );
    const rows = snap.claim_rows.filter(
      (row) => row.parent_identity_key === "cardinal_claims:AMB-1",
    );
    assert.equal(rows.length, 1, `${label}: single row`);
    assert.equal(rows[0].claim_id, null, `${label}: claim_id NULL`);
    // singleton-uuid never promoted.
    for (const [, value] of Object.entries(snap.metrics)) {
      assert.ok(
        !(value?.claim_population?.claim_ids || []).includes("singleton-uuid"),
        `${label}: singleton UUID never promoted`,
      );
    }
  }

  // The post-period extract changes NOTHING about the report's identity domain.
  assert.deepEqual(
    withC.metrics.closing_inventory.claim_population.claim_ids,
    withoutC.metrics.closing_inventory.claim_population.claim_ids,
  );
  assert.deepEqual(
    withC.claim_rows,
    withoutC.claim_rows,
    "post-period extract does not alter report claim rows",
  );
});

test("closure on the legacy 2->1->2 lineage: source-explicit child UUID + derived parent terminal count as ONE stable parent, order-independent", () => {
  const extA = manifest("ext-a", "2026-08-21"); // baseline, open
  const extB = manifest("ext-b", "2026-08-25"); // matchable singleton, open
  const extC = manifest("ext-c", "2026-08-27"); // closing, terminal
  const buildFrom = (snapshotsByExtract) =>
    buildReportSnapshot({
      reportType: "weekly",
      periodStart: "2026-08-24",
      manifests: [extA, extB, extC],
      snapshotsByExtract,
      changes: [
        {
          // Source-explicit closure keyed by a CHILD UUID from extract C.
          claim_id: "child-c",
          change_type: "closure_event",
          provenance: "source_explicit",
          source_event_at: "2026-08-27T09:00:00.000Z",
          observed_at: "2026-08-27T10:00:00.000Z",
        },
      ],
      activeUsers: users,
    });
  const terminalC = [
    ambRowCTerminal("child-c", 0),
    ambRowCTerminal("child-d", 1),
  ];
  const forward = new Map([
    ["ext-a", [ambRowA("child-a", 0), ambRowA("child-b", 1)]],
    ["ext-b", [matchableSingletonB()]],
    ["ext-c", terminalC],
  ]);
  // Same three extracts, snapshotsByExtract inserted in REVERSED order: the
  // longitudinal resolution must not depend on Map iteration order.
  const reversed = new Map([
    ["ext-c", terminalC],
    ["ext-b", [matchableSingletonB()]],
    ["ext-a", [ambRowA("child-a", 0), ambRowA("child-b", 1)]],
  ]);

  for (const [label, byExtract] of [
    ["forward", forward],
    ["reversed", reversed],
  ]) {
    const snap = buildFrom(byExtract);
    assert.equal(snap.metrics.claims_closed.value, 1, `${label}: closed once`);
    assert.equal(snap.metrics.claims_closed.precision, "mixed", label);
    assert.equal(snap.metrics.claims_closed_exact.value, 1, `${label}: exact`);
    assert.equal(
      snap.metrics.claims_closed_observed.value,
      1,
      `${label}: observed`,
    );
    // Exactly one stable parent ref in the combined closure population.
    assert.deepEqual(
      snap.metrics.claims_closed.claim_population.claim_ids,
      ["cardinal_claims:AMB-1"],
      `${label}: single stable parent ref`,
    );
  }
});

// --- POSITIVE FUTURE-LEAKAGE REGRESSION: as-of boundary ---
//
// A parent whose history THROUGH the closing boundary is genuinely canonical
// (all matchable, one shared UUID) must resolve to that UUID. An authoritative
// extract AFTER the period that introduces ambiguity must NOT retroactively
// demote it. The report built with the future extract present must be identical
// to the report built without it.

// A genuinely canonical parent row (matchable, shared UUID canon-x).
function canonRow(extractId, overrides = {}) {
  return snapshot({
    extract_id: extractId,
    claim_id: "canon-x",
    identity_key: "cardinal_claims:CANON-1",
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: "row-canon",
    source_row_index: 1,
    source_claim_number: "CANON-1",
    insured: "Insured CANON-1",
    ...overrides,
  });
}
// The SAME parent, but as an old ambiguous multi-row shape - the demotion that a
// FUTURE extract would introduce if it were allowed to leak into resolution.
function canonRowAmbiguousFuture(childId, index) {
  return snapshot({
    extract_id: "cb-c",
    claim_id: childId,
    identity_key: null,
    identity_matchable: false,
    identity_confidence: "ambiguous",
    source_row_identity: `row-${childId}`,
    source_row_index: index,
    source_claim_number: "CANON-1",
    insured: "Insured CANON-1",
  });
}

test("future evidence never rewrites past reporting identity: a canonical parent stays UUID X even when a post-period extract introduces ambiguity", () => {
  const extA = manifest("cb-a", "2026-08-21"); // baseline: CANON-1 absent
  const extB = manifest("cb-b", "2026-08-27"); // closing: CANON-1 present, canonical
  const extC = manifest("cb-c", "2026-09-07"); // AFTER period: introduces ambiguity
  const aRows = [snapshot({ extract_id: "cb-a" })]; // SOLO-1 only
  const bRows = [snapshot({ extract_id: "cb-b" }), canonRow("cb-b")];
  const cRows = [
    snapshot({ extract_id: "cb-c" }),
    canonRowAmbiguousFuture("child-f1", 1),
    canonRowAmbiguousFuture("child-f2", 2),
  ];

  const run = (manifests, byExtract) =>
    buildReportSnapshot({
      reportType: "weekly",
      periodStart: "2026-08-24",
      manifests,
      snapshotsByExtract: byExtract,
      changes: [],
      activeUsers: users,
    });

  const withoutFuture = run(
    [extA, extB],
    new Map([
      ["cb-a", aRows],
      ["cb-b", bRows],
    ]),
  );
  const withFuture = run(
    [extA, extB, extC],
    new Map([
      ["cb-a", aRows],
      ["cb-b", bRows],
      ["cb-c", cRows],
    ]),
  );

  // Baseline sanity: the parent IS genuinely canonical through the closing
  // boundary - resolved to the shared UUID, not the parent key.
  const canonRowOut = withoutFuture.claim_rows.find(
    (row) => row.parent_identity_key === "cardinal_claims:CANON-1",
  );
  assert.ok(canonRowOut, "CANON-1 is in the report");
  assert.equal(canonRowOut.claim_id, "canon-x");
  assert.ok(
    withoutFuture.metrics.closing_inventory.claim_population.claim_ids.includes(
      "canon-x",
    ),
  );
  assert.ok(
    withoutFuture.metrics.new_claims_first_observed.claim_population.claim_ids.includes(
      "canon-x",
    ),
  );

  // The future extract must not change ANY identity-bearing output.
  assert.deepEqual(
    withFuture.metrics.closing_inventory.claim_population.claim_ids,
    withoutFuture.metrics.closing_inventory.claim_population.claim_ids,
    "closing inventory population unchanged",
  );
  assert.deepEqual(
    withFuture.metrics.new_claims_first_observed.claim_population.claim_ids,
    withoutFuture.metrics.new_claims_first_observed.claim_population.claim_ids,
    "first-observed (lifecycle) population unchanged",
  );
  assert.deepEqual(
    withFuture.claim_rows,
    withoutFuture.claim_rows,
    "claim rows (parent_identity_key + claim_id) unchanged",
  );

  // Lifecycle references resolved directly are identical and use canon-x.
  const period = reportingPeriod("weekly", "2026-08-24");
  const refs = (manifests, byExtract) =>
    deriveParentLifecycleEvents(manifests, byExtract, period)
      .filter((event) => event.parent_identity_key === "cardinal_claims:CANON-1")
      .map((event) => event.claim_ref);
  const refsWithout = refs(
    [extA, extB],
    new Map([
      ["cb-a", aRows],
      ["cb-b", bRows],
    ]),
  );
  const refsWith = refs(
    [extA, extB, extC],
    new Map([
      ["cb-a", aRows],
      ["cb-b", bRows],
      ["cb-c", cRows],
    ]),
  );
  assert.deepEqual(refsWithout, ["canon-x"]);
  assert.deepEqual(refsWith, refsWithout, "lifecycle refs unaffected by future");
});
