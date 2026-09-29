// Unit tests for the pure parent-claim domain primitives (MS2).
import test from "node:test";
import assert from "node:assert/strict";
import {
  parentIdentityKey,
  consensusValue,
  detectParentIdentityConflict,
  rollUpParentState,
  groupSnapshotsByParent,
  diffParentPresence,
  DEFAULT_SOURCE_SYSTEM,
} from "./claim-parent.mjs";

// Valid status strings from claims-rules.mjs taxonomy.
const TERMINAL = "Closed Paid";
const OPEN_MAPPED = "Registered";
const UNMAPPED = "Totally Made Up Status";

function row(overrides = {}) {
  return {
    source_claim_number: "SAS0015-00008261",
    source_row_index: 0,
    status_raw: OPEN_MAPPED,
    insured: "ABC Ltd",
    registered_date: "2026-01-02",
    dol_date: "2026-01-01",
    insurer: "Sasria",
    ...overrides,
  };
}

test("parentIdentityKey builds source_system:claimNumber and ignores row shape", () => {
  assert.equal(
    parentIdentityKey({ source_claim_number: "SAS0015-00008261" }),
    `${DEFAULT_SOURCE_SYSTEM}:SAS0015-00008261`,
  );
  assert.equal(
    parentIdentityKey({ claimNo: "  TOT0046-00006728 " }),
    `${DEFAULT_SOURCE_SYSTEM}:TOT0046-00006728`,
  );
  assert.equal(
    parentIdentityKey({
      source_claim_number: "X1",
      source_system: "other_system",
    }),
    "other_system:X1",
  );
});

test("parentIdentityKey returns null for a missing claim number (no fake key)", () => {
  assert.equal(parentIdentityKey({ source_claim_number: "" }), null);
  assert.equal(parentIdentityKey({}), null);
  assert.equal(parentIdentityKey(null), null);
});

test("consensusValue distinguishes agree / partial / disagree / all_missing", () => {
  const agree = consensusValue(
    [{ insured: "ABC Ltd" }, { insured: "abc ltd" }],
    "insured",
  );
  assert.equal(agree.status, "agree");
  assert.equal(agree.value, "ABC Ltd"); // original representation preserved

  const partial = consensusValue(
    [{ insured: "ABC Ltd" }, { insured: "" }],
    "insured",
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.value, "ABC Ltd");

  const disagree = consensusValue(
    [{ insured: "ABC Ltd" }, { insured: "XYZ Ltd" }],
    "insured",
  );
  assert.equal(disagree.status, "disagree");
  assert.equal(disagree.value, null); // never an arbitrary pick

  const allMissing = consensusValue(
    [{ insured: "" }, { insured: null }],
    "insured",
  );
  assert.equal(allMissing.status, "all_missing");
  assert.equal(allMissing.value, null);
});

test("detectParentIdentityConflict: missing vs populated is incomplete, not conflict", () => {
  const rows = [
    row({ insured: "ABC Ltd" }),
    row({ insured: "" }),
    row({ insured: "ABC Ltd" }),
  ];
  const result = detectParentIdentityConflict(rows);
  assert.equal(result.identity_quality, "valid");
  assert.deepEqual(result.incomplete_fields, ["insured"]);
});

test("detectParentIdentityConflict: two distinct insureds conflict", () => {
  const rows = [row({ insured: "ABC Ltd" }), row({ insured: "XYZ Ltd" })];
  assert.equal(detectParentIdentityConflict(rows).identity_quality, "conflict");
});

test("detectParentIdentityConflict ignores section-varying fields", () => {
  const rows = [
    row({ status_raw: OPEN_MAPPED, outstanding: 10, paid: 1, peril: "Fire" }),
    row({ status_raw: TERMINAL, outstanding: 999, paid: 500, peril: "Theft" }),
  ];
  assert.equal(detectParentIdentityConflict(rows).identity_quality, "valid");
});

test("rollUpParentState: all terminal -> terminal/resolved", () => {
  const state = rollUpParentState([
    row({ status_raw: TERMINAL }),
    row({ status_raw: TERMINAL }),
  ]);
  assert.equal(state.lifecycle_state, "terminal");
  assert.equal(state.state_resolution, "resolved");
});

test("rollUpParentState: open + terminal -> open/resolved + mixed (never terminal)", () => {
  const state = rollUpParentState([
    row({ status_raw: OPEN_MAPPED }),
    row({ status_raw: TERMINAL }),
  ]);
  assert.equal(state.lifecycle_state, "open");
  assert.equal(state.state_resolution, "resolved");
  assert.ok(state.flags.includes("parent_status_mixed"));
});

test("rollUpParentState: open + unmapped -> open + incomplete", () => {
  const state = rollUpParentState([
    row({ status_raw: OPEN_MAPPED }),
    row({ status_raw: UNMAPPED }),
  ]);
  assert.equal(state.lifecycle_state, "open");
  assert.equal(state.state_resolution, "resolved");
  assert.ok(state.flags.includes("parent_status_incomplete"));
});

test("rollUpParentState: terminal + unmapped -> open (never falsely terminal) + mixed", () => {
  const state = rollUpParentState([
    row({ status_raw: TERMINAL }),
    row({ status_raw: UNMAPPED }),
  ]);
  assert.equal(state.lifecycle_state, "open");
  assert.ok(state.flags.includes("parent_status_mixed"));
});

test("rollUpParentState: all unmapped/missing -> open + unresolved", () => {
  const state = rollUpParentState([
    row({ status_raw: UNMAPPED }),
    row({ status_raw: "" }),
  ]);
  assert.equal(state.lifecycle_state, "open");
  assert.equal(state.state_resolution, "unresolved");
  assert.ok(state.flags.includes("parent_status_unresolved"));
});

test("groupSnapshotsByParent: one parent per claim number, rows ordered by index", () => {
  const snapshots = [
    row({ source_claim_number: "A", source_row_index: 2 }),
    row({ source_claim_number: "A", source_row_index: 0 }),
    row({ source_claim_number: "B", source_row_index: 0 }),
    row({ source_claim_number: "", source_row_index: 5 }), // missing -> excluded
  ];
  const parents = groupSnapshotsByParent(snapshots);
  assert.equal(parents.length, 2);
  const a = parents.find((p) => p.source_claim_number === "A");
  assert.equal(a.row_count, 2);
  assert.deepEqual(
    a.rows.map((r) => r.source_row_index),
    [0, 2],
  );
  assert.ok(a.quality_flags.includes("multi_row_claim"));
});

test("groupSnapshotsByParent: conflict flagged but still present", () => {
  const parents = groupSnapshotsByParent([
    row({ source_claim_number: "C", insured: "ABC Ltd" }),
    row({ source_claim_number: "C", insured: "XYZ Ltd" }),
  ]);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].identity_quality, "conflict");
  assert.equal(parents[0].presence, "present");
  assert.ok(parents[0].quality_flags.includes("parent_identity_conflict"));
});

// --- pairwise presence / lifecycle -----------------------------------------

function parentsFrom(...defs) {
  // each def: [claimNumber, count, statusRaw]
  const snapshots = [];
  for (const [claimNumber, count, statusRaw] of defs) {
    for (let index = 0; index < count; index += 1) {
      snapshots.push(
        row({
          source_claim_number: claimNumber,
          source_row_index: index,
          status_raw: statusRaw,
        }),
      );
    }
  }
  return groupSnapshotsByParent(snapshots);
}

for (const [from, to] of [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 1],
]) {
  test(`cardinality ${from}->${to}: same parent, no false first_observed/missing`, () => {
    const previous = parentsFrom(["K", from, OPEN_MAPPED]);
    const current = parentsFrom(["K", to, OPEN_MAPPED]);
    const events = diffParentPresence(previous, current);
    assert.equal(events.filter((e) => e.type === "first_observed").length, 0);
    assert.equal(
      events.filter((e) => e.type === "missing_from_extract").length,
      0,
    );
  });
}

test("diffParentPresence: absent -> present = first_observed", () => {
  const events = diffParentPresence([], parentsFrom(["K", 2, OPEN_MAPPED]));
  assert.deepEqual(events, [
    {
      type: "first_observed",
      parent_identity_key: `${DEFAULT_SOURCE_SYSTEM}:K`,
    },
  ]);
});

test("diffParentPresence: present -> absent = missing_from_extract (not closure)", () => {
  const events = diffParentPresence(parentsFrom(["K", 2, OPEN_MAPPED]), []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "missing_from_extract");
  assert.equal(
    events.filter((e) => e.type === "terminal_transition_observed").length,
    0,
  );
});

test("diffParentPresence: open -> terminal emits terminal_transition_observed", () => {
  const events = diffParentPresence(
    parentsFrom(["K", 1, OPEN_MAPPED]),
    parentsFrom(["K", 1, TERMINAL]),
  );
  assert.ok(events.some((e) => e.type === "terminal_transition_observed"));
});

test("diffParentPresence: terminal -> open emits reopened", () => {
  const events = diffParentPresence(
    parentsFrom(["K", 1, TERMINAL]),
    parentsFrom(["K", 1, OPEN_MAPPED]),
  );
  assert.ok(events.some((e) => e.type === "reopened"));
});

test("diffParentPresence: valid <-> conflict never yields first/missing, gates transitions", () => {
  const valid = groupSnapshotsByParent([
    row({ source_claim_number: "K", insured: "ABC Ltd" }),
  ]);
  const conflict = groupSnapshotsByParent([
    row({ source_claim_number: "K", source_row_index: 0, insured: "ABC Ltd" }),
    row({ source_claim_number: "K", source_row_index: 1, insured: "XYZ Ltd" }),
  ]);
  const forward = diffParentPresence(valid, conflict);
  const backward = diffParentPresence(conflict, valid);
  for (const events of [forward, backward]) {
    assert.equal(events.filter((e) => e.type === "first_observed").length, 0);
    assert.equal(
      events.filter((e) => e.type === "missing_from_extract").length,
      0,
    );
    assert.equal(
      events.filter((e) => e.type === "terminal_transition_observed").length,
      0,
    );
    assert.equal(events.filter((e) => e.type === "reopened").length, 0);
  }
});

test("diffParentPresence: unresolved state gates terminal transition", () => {
  const events = diffParentPresence(
    parentsFrom(["K", 1, OPEN_MAPPED]),
    parentsFrom(["K", 1, UNMAPPED]), // all-unmapped -> unresolved, still open
  );
  assert.equal(
    events.filter((e) => e.type === "terminal_transition_observed").length,
    0,
  );
  assert.equal(events.filter((e) => e.type === "reopened").length, 0);
});
