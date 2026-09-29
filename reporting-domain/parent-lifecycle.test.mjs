// MS2 period-wide parent lifecycle derivation. Walks the authoritative extract
// chain (plus the pre-period baseline) and derives parent presence/state events
// from immutable snapshots - not from legacy stored change rows. Proves
// disappearance is never a closure and cardinality baselines are respected.
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveParentLifecycleEvents,
  reportingPeriod,
} from "./reporting-metrics.mjs";

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
    claim_count: 2,
    accepted_claim_count: 2,
    quality_summary: {
      completeness_state: "complete",
      comparable_to_previous: true,
    },
    previous_extract_id: null,
    correction_of_extract_id: null,
  };
}

function row(claimNumber, extractId, statusRaw = "Registered", index = 0) {
  return {
    extract_id: extractId,
    claim_id: `${claimNumber}-${extractId}`,
    identity_key: `cardinal_claims:${claimNumber}`,
    identity_matchable: true,
    source_row_identity: `row-${claimNumber}-${index}`,
    source_row_index: index,
    source_claim_number: claimNumber,
    status_raw: statusRaw,
    status_normalized: statusRaw.toLowerCase(),
    terminal: statusRaw.startsWith("Closed"),
    open: !statusRaw.startsWith("Closed"),
    registered_date: "2026-07-01",
    dol_date: "2026-06-20",
    insured: `Insured ${claimNumber}`,
    insurer: "Insurer",
  };
}

// Monthly August period. Baseline is pre-period; A/B/C/D are in-period.
// Stable claim S is open throughout (must generate no events after baseline).
// Claim K: absent in baseline & A, present-open at B, terminal at C, absent at D.
function scenario() {
  const baseline = manifest("baseline", "2026-07-28");
  const a = manifest("A", "2026-08-03");
  const b = manifest("B", "2026-08-10");
  const c = manifest("C", "2026-08-17");
  const d = manifest("D", "2026-08-24");
  return {
    manifests: [baseline, a, b, c, d],
    snapshotsByExtract: new Map([
      ["baseline", [row("S", "baseline")]],
      ["A", [row("S", "A")]],
      ["B", [row("S", "B"), row("K", "B", "Registered")]],
      ["C", [row("S", "C"), row("K", "C", "Closed Paid")]],
      ["D", [row("S", "D")]],
    ]),
  };
}

test("A/B/C/D: first@B, terminal transition@C, missing@D, and D is not a second closure", () => {
  const { manifests, snapshotsByExtract } = scenario();
  const period = reportingPeriod("monthly", "2026-08-01");
  const events = deriveParentLifecycleEvents(
    manifests,
    snapshotsByExtract,
    period,
  );
  const k = events.filter(
    (event) => event.parent_identity_key === "cardinal_claims:K",
  );
  const types = k.map((event) => event.type);
  assert.deepEqual(
    types.sort(),
    [
      "first_observed",
      "missing_from_extract",
      "terminal_transition_observed",
    ].sort(),
  );
  // Exactly one terminal transition (the C open->terminal), never a second one
  // manufactured from the D disappearance.
  assert.equal(
    k.filter((event) => event.type === "terminal_transition_observed").length,
    1,
  );
  // The stable claim S generates no lifecycle events at all.
  assert.equal(
    events.filter((event) => event.parent_identity_key === "cardinal_claims:S")
      .length,
    0,
  );
});

test("baseline before the period prevents mass false first_observed", () => {
  // S exists in the baseline, so it is NOT first_observed inside the period.
  const { manifests, snapshotsByExtract } = scenario();
  const period = reportingPeriod("monthly", "2026-08-01");
  const events = deriveParentLifecycleEvents(
    manifests,
    snapshotsByExtract,
    period,
  );
  assert.equal(
    events.some(
      (event) =>
        event.parent_identity_key === "cardinal_claims:S" &&
        event.type === "first_observed",
    ),
    false,
  );
});

test("short-lived claim inside the period: first + missing, never closure", () => {
  const a = manifest("A", "2026-08-03");
  const b = manifest("B", "2026-08-10");
  const c = manifest("C", "2026-08-17");
  const manifests = [a, b, c];
  const snapshotsByExtract = new Map([
    ["A", [row("S", "A")]],
    ["B", [row("S", "B"), row("SHORT", "B", "Registered")]],
    ["C", [row("S", "C")]],
  ]);
  const period = reportingPeriod("monthly", "2026-08-01");
  const events = deriveParentLifecycleEvents(
    manifests,
    snapshotsByExtract,
    period,
  ).filter((event) => event.parent_identity_key === "cardinal_claims:SHORT");
  const types = events.map((event) => event.type).sort();
  assert.deepEqual(types, ["first_observed", "missing_from_extract"]);
  assert.equal(
    events.some((event) => event.type === "terminal_transition_observed"),
    false,
  );
});

test("old ambiguous 2->1->2 cardinality: one logical parent, no false first/missing/reopened", () => {
  // Pre-MS2 lineage: identity_matchable false, per-row child UUIDs, shared
  // source_claim_number. Cardinality changes A(2) -> B(1) -> C(2).
  const amb = (extractId, childId, index, statusRaw = "Registered") => ({
    extract_id: extractId,
    claim_id: childId,
    identity_key: null,
    identity_matchable: false,
    source_row_identity: `row-${childId}`,
    source_row_index: index,
    source_claim_number: "AMB-1",
    status_raw: statusRaw,
    status_normalized: statusRaw.toLowerCase(),
    terminal: statusRaw.startsWith("Closed"),
    open: !statusRaw.startsWith("Closed"),
    registered_date: "2026-07-01",
    dol_date: "2026-06-20",
    insured: "Insured AMB-1",
    insurer: "Insurer",
  });
  const a = manifest("A", "2026-08-03");
  const b = manifest("B", "2026-08-10");
  const c = manifest("C", "2026-08-17");
  const snapshotsByExtract = new Map([
    ["A", [amb("A", "child-a", 0), amb("A", "child-b", 1)]],
    ["B", [amb("B", "child-a", 0)]],
    ["C", [amb("C", "child-a", 0), amb("C", "child-b", 1)]],
  ]);
  const period = reportingPeriod("monthly", "2026-08-01");
  const events = deriveParentLifecycleEvents(
    [a, b, c],
    snapshotsByExtract,
    period,
  ).filter((event) => event.parent_identity_key === "cardinal_claims:AMB-1");
  // Presence is continuous across every cardinality change; the reference id is
  // the stable parent key, so no event is manufactured by row-count churn.
  assert.equal(events.length, 0);
});
