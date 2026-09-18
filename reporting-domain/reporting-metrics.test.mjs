import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportSnapshot,
  metricPopulationForSnapshot,
  previousReportingPeriod,
  reportingPeriod,
  selectAuthoritativeManifests,
  selectBoundaryExtract,
} from "./reporting-metrics.mjs";

const users = [
  {
    id: "handler-1",
    email: "handler.one@example.test",
    display_name: "Handler One",
    role: "handler",
    active: true,
  },
  {
    id: "handler-2",
    email: "handler.two@example.test",
    display_name: "Handler Two",
    role: "handler",
    active: true,
  },
  {
    id: "manager-1",
    email: "manager@example.test",
    display_name: "Claims Manager",
    role: "manager",
    active: true,
  },
];

function manifest(id, effectiveDate, count, options = {}) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: `${id}-checksum`,
    effective_date: effectiveDate,
    received_at: options.receivedAt || `${effectiveDate}T12:00:00.000Z`,
    status: options.status || "accepted",
    historical_persisted: options.historicalPersisted ?? true,
    claim_count: count,
    accepted_claim_count: count,
    quality_summary: {
      completeness_state: options.incomplete ? "incomplete" : "complete",
      comparable_to_previous: true,
      warnings: options.warnings || [],
      unmapped_status_count: options.unmappedStatusCount || 0,
      unknown_handler_count: options.unknownHandlerCount || 0,
      identity_ambiguity_count: 0,
    },
    previous_extract_id: options.previousExtractId || null,
    correction_of_extract_id: options.correctionOfExtractId || null,
  };
}

function snapshot(
  claimId,
  extractId,
  {
    status = "Registered",
    open = true,
    terminal = false,
    handlerId = "handler-1",
    handlerEmail = "handler.one@example.test",
    handlerSource = "Handler One",
    registeredDate = "2026-08-01",
    calendarAge = 20,
    workingAge = 15,
    movementDate = "2026-08-20",
    outstanding = 1000,
    estimate = 1500,
    paid = 0,
    mandate = 0,
    quality = [],
  } = {},
) {
  return {
    extract_id: extractId,
    claim_id: claimId,
    identity_key: `cardinal_claims:${claimId}`,
    identity_matchable: true,
    identity_confidence: "source_scoped",
    source_row_identity: `row-${claimId}`,
    source_claim_number: claimId,
    handler_source: handlerSource,
    handler_email: handlerEmail,
    resolved_scout_user_id: handlerId,
    handler_resolution: handlerId ? "resolved" : "unassigned",
    status_raw: status,
    status_normalized: status.toLowerCase(),
    terminal,
    open,
    registered_date: registeredDate,
    dol_date: "2026-07-20",
    movement_date: movementDate,
    repudiation_date: null,
    source_event_at: null,
    outstanding,
    estimate,
    paid,
    mandate,
    insurer: "Insurer",
    peril: "Fire",
    peril_type: "Property",
    insured: `Insured ${claimId}`,
    description: "Fixture claim",
    comments: null,
    calendar_age: calendarAge,
    working_age: workingAge,
    age_band:
      calendarAge === null
        ? null
        : calendarAge <= 30
          ? "0-30"
          : calendarAge <= 60
            ? "31-60"
            : calendarAge <= 90
              ? "61-90"
              : "91+",
    rule_version: "claims-operations-rules-v1",
    priority_flags: [],
    operational_flags: [],
    data_quality_flags: quality,
  };
}

function evidence(manifests, snapshotsByExtract, changes = []) {
  return { manifests, snapshotsByExtract, changes, activeUsers: users };
}

function week1Evidence() {
  const opening = manifest("extract-opening", "2026-08-21", 3);
  const closing = manifest("extract-closing", "2026-08-26", 5, {
    previousExtractId: opening.id,
    warnings: ["row_quality_warnings"],
    unknownHandlerCount: 1,
    unmappedStatusCount: 1,
  });
  const openingRows = [
    snapshot("A", opening.id, {
      status: "Awaiting Assessor Report",
      calendarAge: 20,
      workingAge: 5,
      movementDate: "2026-08-20",
    }),
    snapshot("B", opening.id, {
      calendarAge: 65,
      workingAge: 45,
      registeredDate: "2026-06-20",
    }),
    snapshot("C", opening.id, {
      calendarAge: 90,
      workingAge: 65,
      registeredDate: "2026-06-01",
    }),
  ];
  const closingRows = [
    snapshot("A", closing.id, {
      status: "Awaiting Assessor Report",
      handlerId: "handler-2",
      handlerEmail: "handler.two@example.test",
      handlerSource: "Handler Two",
      calendarAge: 25,
      workingAge: 8,
      movementDate: "2026-08-20",
      outstanding: 1200,
    }),
    snapshot("B", closing.id, {
      status: "Payment Released",
      open: false,
      terminal: true,
      calendarAge: 70,
      workingAge: 50,
      registeredDate: "2026-06-20",
    }),
    snapshot("C", closing.id, {
      calendarAge: 100,
      workingAge: 70,
      registeredDate: "2026-06-01",
      movementDate: "2026-07-01",
    }),
    snapshot("D", closing.id, {
      registeredDate: "2026-08-25",
      calendarAge: 1,
      workingAge: 1,
      handlerId: "handler-2",
      handlerEmail: "handler.two@example.test",
      handlerSource: "Handler Two",
    }),
    snapshot("E", closing.id, {
      status: "Mystery Status",
      registeredDate: "2026-08-25",
      calendarAge: 1,
      workingAge: 1,
      handlerId: null,
      handlerEmail: null,
      handlerSource: "Unknown Person",
      quality: ["unrecognised_handler", "unmapped_status"],
    }),
  ];
  const changes = [
    {
      claim_id: "D",
      change_type: "first_observed",
      observed_at: "2026-08-26T10:00:00.000Z",
      first_observed_at: "2026-08-26T10:00:00.000Z",
    },
    {
      claim_id: "E",
      change_type: "first_observed",
      observed_at: "2026-08-26T10:00:00.000Z",
      first_observed_at: "2026-08-26T10:00:00.000Z",
    },
    {
      claim_id: "A",
      change_type: "handler_changed",
      observed_at: "2026-08-26T10:00:00.000Z",
      old_value: { email: "handler.one@example.test" },
      new_value: { email: "handler.two@example.test" },
    },
    {
      claim_id: "B",
      change_type: "terminal_transition_observed",
      provenance: "system_derived",
      timestamp_precision: "between_extracts",
      observed_at: "2026-08-26T10:00:00.000Z",
    },
  ];
  return evidence(
    [opening, closing],
    new Map([
      [opening.id, openingRows],
      [closing.id, closingRows],
    ]),
    changes,
  );
}

test("weekly period is Monday inclusive through Saturday exclusive", () => {
  const period = reportingPeriod("weekly", "2026-08-24");
  assert.equal(period.startLocalDate, "2026-08-24");
  assert.equal(period.endLocalDateExclusive, "2026-08-29");
  assert.equal(period.start.toISOString(), "2026-08-23T22:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-08-28T22:00:00.000Z");
});

test("monthly period uses local calendar boundaries and month length", () => {
  const period = reportingPeriod("monthly", "2026-02-15");
  assert.equal(period.startLocalDate, "2026-02-01");
  assert.equal(period.endLocalDateExclusive, "2026-03-01");
  assert.equal(
    previousReportingPeriod("monthly", "2026-03-15").startLocalDate,
    "2026-02-01",
  );
});

test("boundary selection rejects incomplete extracts and chooses corrected lineage", () => {
  const original = manifest("original", "2026-08-26", 2);
  const correction = manifest("correction", "2026-08-26", 2, {
    correctionOfExtractId: original.id,
    receivedAt: "2026-08-26T14:00:00.000Z",
  });
  const incomplete = manifest("incomplete", "2026-08-27", 2, {
    incomplete: true,
  });
  const selected = selectBoundaryExtract(
    [original, correction, incomplete],
    "2026-08-28T00:00:00.000Z",
  );
  assert.equal(selected.manifest.id, correction.id);
  assert.equal(
    selectBoundaryExtract([incomplete], "2026-08-28T00:00:00.000Z").manifest,
    null,
  );
});

test("reporting filters superseded snapshots and change rows consistently", () => {
  const prior = manifest("prior", "2026-08-21", 1);
  const original14 = manifest("original-14", "2026-08-24", 1, {
    receivedAt: "2026-08-24T08:00:00.000Z",
  });
  const flawed14 = manifest("flawed-14", "2026-08-24", 1, {
    receivedAt: "2026-08-24T09:00:00.000Z",
    correctionOfExtractId: original14.id,
  });
  const corrected14 = manifest("corrected-14", "2026-08-24", 1, {
    receivedAt: "2026-08-24T10:00:00.000Z",
    correctionOfExtractId: flawed14.id,
  });
  const original15 = manifest("original-15", "2026-08-25", 1, {
    receivedAt: "2026-08-25T08:00:00.000Z",
    previousExtractId: corrected14.id,
  });
  const corrected15 = manifest("corrected-15", "2026-08-25", 1, {
    receivedAt: "2026-08-25T09:00:00.000Z",
    previousExtractId: corrected14.id,
    correctionOfExtractId: original15.id,
  });
  const manifests = [
    prior,
    original14,
    flawed14,
    corrected14,
    original15,
    corrected15,
  ];
  const snapshotsByExtract = new Map(
    manifests.map((current) => [current.id, [snapshot("A", current.id)]]),
  );
  const changes = [
    {
      claim_id: "superseded-first",
      change_type: "first_observed",
      source_extract_id: original14.id,
      observed_at: "2026-08-24T11:00:00.000Z",
    },
    {
      claim_id: "superseded-handler",
      change_type: "handler_changed",
      source_extract_id: flawed14.id,
      observed_at: "2026-08-24T11:30:00.000Z",
      old_value: { email: "old@example.test" },
      new_value: { email: "new@example.test" },
    },
    {
      claim_id: "authoritative-first",
      change_type: "first_observed",
      source_extract_id: corrected14.id,
      observed_at: "2026-08-24T12:00:00.000Z",
    },
    {
      claim_id: "superseded-closure",
      change_type: "closure_event",
      source_extract_id: original15.id,
      observed_at: "2026-08-25T11:00:00.000Z",
      provenance: "source_explicit",
      source_event_at: "2026-08-25T10:00:00.000Z",
    },
    {
      claim_id: "authoritative-closure",
      change_type: "closure_event",
      source_extract_id: corrected15.id,
      observed_at: "2026-08-25T12:00:00.000Z",
      provenance: "source_explicit",
      source_event_at: "2026-08-25T11:00:00.000Z",
    },
  ];

  assert.deepEqual(
    selectAuthoritativeManifests(manifests).map((current) => current.id),
    [prior.id, corrected14.id, corrected15.id],
  );
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests,
    snapshotsByExtract,
    changes,
    activeUsers: users,
  });

  assert.equal(report.opening_extract_id, corrected14.id);
  assert.equal(report.closing_extract_id, corrected15.id);
  assert.equal(report.activity.changes_considered, 2);
  assert.deepEqual(
    report.metrics.new_claims_first_observed.claim_population.claim_ids,
    ["authoritative-first"],
  );
  assert.deepEqual(report.metrics.claims_closed.claim_population.claim_ids, [
    "authoritative-closure",
  ]);
  assert.equal(report.metrics.assignment_activity.value, 0);
  assert.equal(
    report.metrics.assignment_activity.coverage_warnings.includes(
      "assignment_history_unavailable",
    ),
    true,
  );
});

test("unpersisted corrections do not become reporting authority", () => {
  const original = manifest("original-14", "2026-08-24", 1);
  const correction = manifest("unpersisted-14", "2026-08-24", 1, {
    correctionOfExtractId: original.id,
    historicalPersisted: false,
    receivedAt: "2026-08-24T14:00:00.000Z",
  });
  const snapshotsByExtract = new Map([
    [original.id, [snapshot("valid", original.id)]],
    [correction.id, [snapshot("invalid", correction.id)]],
  ]);
  const changes = [
    {
      claim_id: "legacy-change",
      change_type: "status_changed",
      observed_at: "2026-08-24T13:00:00.000Z",
    },
    {
      claim_id: "invalid-change",
      change_type: "first_observed",
      source_extract_id: correction.id,
      observed_at: "2026-08-24T14:00:00.000Z",
    },
  ];

  assert.deepEqual(
    selectAuthoritativeManifests([original, correction]).map(
      (current) => current.id,
    ),
    [original.id],
  );
  const selected = selectBoundaryExtract(
    [original, correction],
    "2026-08-25T00:00:00.000Z",
  );
  assert.equal(selected.manifest.id, original.id);

  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [original, correction],
    snapshotsByExtract,
    changes,
    activeUsers: users,
  });
  assert.equal(report.closing_extract_id, original.id);
  assert.equal(report.activity.changes_considered, 1);

  correction.historical_persisted = true;
  assert.deepEqual(
    selectAuthoritativeManifests([original, correction]).map(
      (current) => current.id,
    ),
    [correction.id],
  );
});

test("a later ordinary period remains authoritative after an earlier correction", () => {
  const original14 = manifest("original-14", "2026-09-14", 1);
  const corrected14 = manifest("corrected-14", "2026-09-14", 1, {
    correctionOfExtractId: original14.id,
    previousExtractId: "prior-04",
    receivedAt: "2026-09-14T14:00:00.000Z",
  });
  const ordinary15 = manifest("ordinary-15", "2026-09-15", 1, {
    previousExtractId: original14.id,
  });

  assert.deepEqual(
    selectAuthoritativeManifests([original14, corrected14, ordinary15]).map(
      (current) => current.id,
    ),
    [corrected14.id, ordinary15.id],
  );
  assert.equal(
    selectBoundaryExtract(
      [original14, corrected14, ordinary15],
      "2026-09-16T00:00:00.000Z",
    ).manifest.id,
    ordinary15.id,
  );
});

test("week one state and activity metrics are historical and precision-aware", () => {
  const data = week1Evidence();
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  assert.equal(report.metrics.opening_inventory.value, 3);
  assert.equal(report.metrics.closing_inventory.value, 4);
  assert.equal(report.metrics.net_inventory_movement.value, 1);
  assert.equal(report.metrics.new_claims_registered.value, 2);
  assert.equal(report.metrics.new_claims_first_observed.value, 0);
  assert.equal(report.metrics.claims_closed.value, 1);
  assert.equal(report.metrics.claims_closed.precision, "observed_period");
  assert.equal(report.metrics.claims_closed_exact.availability, "unavailable");
  assert.equal(report.activity.disappearance_is_not_closure, true);
});

test("source-dated closure is exact while disappearance remains non-closure", () => {
  const data = week1Evidence();
  data.changes = [
    {
      claim_id: "B",
      change_type: "closure_event",
      provenance: "source_explicit",
      source_event_at: "2026-08-26T09:00:00.000Z",
      observed_at: "2026-08-26T10:00:00.000Z",
    },
    {
      claim_id: "C",
      change_type: "missing_from_extract",
      provenance: "extract_observed",
      observed_at: "2026-08-26T10:00:00.000Z",
    },
  ];
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  assert.equal(report.metrics.claims_closed.value, 1);
  assert.equal(report.metrics.claims_closed.precision, "source_exact");
  assert.equal(report.metrics.claims_closed_observed.value, 0);
});

test("ageing distribution reconciles to closing open inventory", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...week1Evidence(),
  });
  const distribution = report.metrics.ageing_distribution.value;
  assert.deepEqual(distribution, {
    "0-30": 3,
    "31-60": 0,
    "61-90": 0,
    "91+": 1,
    unknown: 0,
  });
  assert.equal(
    Object.values(distribution).reduce((sum, value) => sum + value, 0),
    report.metrics.closing_inventory.value,
  );
  assert.equal(report.metrics.open_claims_60_plus.value, 1);
  assert.equal(report.metrics.open_claims_91_plus.value, 1);
});

test("60 plus includes the exact 60-day boundary without changing ageing bands", () => {
  const data = week1Evidence();
  const closingRows = data.snapshotsByExtract.get("extract-closing");
  closingRows.find((row) => row.claim_id === "C").calendar_age = 60;
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  assert.equal(report.metrics.open_claims_60_plus.value, 1);
  assert.equal(report.metrics.ageing_distribution.value["31-60"], 1);
  assert.equal(report.metrics.ageing_distribution.value["91+"], 0);
});

test("SLA excludes unmapped statuses from the denominator and handles breaches", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...week1Evidence(),
  });
  const summary = report.metrics.sla_summary.value;
  assert.equal(summary.compliant, 1);
  assert.equal(summary.breached, 2);
  assert.equal(summary.unmapped, 1);
  assert.equal(summary.denominator, 3);
  assert.equal(report.metrics.sla_compliance.value, 1 / 3);
  assert.equal(report.metrics.sla_breaches.value, 2);
  assert.ok(report.coverage.warnings.includes("unmapped_statuses"));
});

test("movement, Ready to Close, operational, financial, and dynamic handler metrics reuse canonical rules", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...week1Evidence(),
  });
  assert.equal(report.metrics.no_movement_over_30.value, 1);
  assert.equal(report.metrics.ready_to_close.value, 1);
  assert.equal(report.metrics.operational_health.value.assessor_overdue, 1);
  assert.equal(report.metrics.financial_open_outstanding.value, 4200);
  assert.equal(
    report.metrics.payment_requested_events.availability,
    "unavailable",
  );
  const handlers = report.metrics.handler_performance.value.handlers;
  assert.deepEqual(
    handlers.map((handler) => [handler.handler_id, handler.open_claims]),
    [
      ["handler-1", 1],
      ["handler-2", 2],
    ],
  );
  assert.equal(
    report.metrics.handler_performance.value.unassigned_unresolved.count,
    1,
  );
});

test("first observed remains distinct when registration date is unavailable", () => {
  const opening = manifest("old", "2026-08-21", 1);
  const closing = manifest("new", "2026-08-26", 1, {
    previousExtractId: opening.id,
  });
  const rows = new Map([
    [opening.id, [snapshot("A", opening.id, { registeredDate: null })]],
    [closing.id, [snapshot("A", closing.id, { registeredDate: null })]],
  ]);
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    manifests: [opening, closing],
    snapshotsByExtract: rows,
    changes: [
      {
        claim_id: "A",
        change_type: "first_observed",
        observed_at: "2026-08-25T10:00:00.000Z",
      },
    ],
    activeUsers: users,
  });
  assert.equal(
    report.metrics.new_claims_registered.availability,
    "unavailable",
  );
  assert.equal(report.metrics.new_claims_first_observed.value, 1);
  assert.equal(
    report.metrics.new_claims_first_observed.precision,
    "observed_period",
  );
});

test("assignment activity is observed and does not substitute current ownership", () => {
  const data = week1Evidence();
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  assert.equal(report.metrics.assignment_activity.value, 1);
  assert.deepEqual(
    report.metrics.assignment_activity.claim_population.claim_ids,
    ["A"],
  );
  assert.equal(
    report.metrics.handler_performance.value.handlers[0].open_claims,
    1,
  );
});

test("previous-period comparison uses null percentage when previous value is zero", () => {
  const data = week1Evidence();
  const previous = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-17",
    ...data,
  });
  const current = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
    previousSnapshot: {
      metrics: {
        closing_inventory: { value: 0 },
        claims_closed: { value: 0 },
      },
    },
  });
  assert.equal(current.comparisons.closing_inventory.absolute_delta, 4);
  assert.equal(current.comparisons.closing_inventory.percentage_delta, null);
  assert.equal(previous.report_type, "weekly");
});

test("monthly reporting calculates directly over the monthly evidence", () => {
  const opening = manifest("july-close", "2026-07-31", 1);
  const closing = manifest("august-close", "2026-08-31", 2, {
    previousExtractId: opening.id,
  });
  const rows = new Map([
    [
      opening.id,
      [
        snapshot("A", opening.id, {
          calendarAge: 30,
          registeredDate: "2026-07-01",
        }),
      ],
    ],
    [
      closing.id,
      [
        snapshot("A", closing.id, {
          calendarAge: 61,
          registeredDate: "2026-07-01",
        }),
        snapshot("B", closing.id, {
          registeredDate: "2026-08-05",
          calendarAge: 26,
        }),
      ],
    ],
  ]);
  const report = buildReportSnapshot({
    reportType: "monthly",
    periodStart: "2026-08-15",
    manifests: [opening, closing],
    snapshotsByExtract: rows,
    changes: [],
    activeUsers: users,
  });
  assert.equal(report.period_start_local_date, "2026-08-01");
  assert.equal(report.period_end_local_date, "2026-09-01");
  assert.equal(report.metrics.opening_inventory.value, 1);
  assert.equal(report.metrics.closing_inventory.value, 2);
  assert.equal(report.metrics.new_claims_registered.value, 1);
});

test("week two compares directly to week one after reopening and closing", () => {
  const weekOne = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...week1Evidence(),
  });
  const opening = manifest("week2-opening", "2026-08-28", 5);
  const closing = manifest("week2-closing", "2026-09-02", 5, {
    previousExtractId: opening.id,
  });
  const openingRows = [
    snapshot("A", opening.id, {
      status: "Awaiting Assessor Report",
      workingAge: 10,
    }),
    snapshot("B", opening.id, {
      status: "Payment Released",
      open: false,
      terminal: true,
      registeredDate: "2026-06-20",
      calendarAge: 70,
    }),
    snapshot("C", opening.id, {
      registeredDate: "2026-06-01",
      calendarAge: 100,
      workingAge: 70,
    }),
    snapshot("D", opening.id, { registeredDate: "2026-08-25", calendarAge: 5 }),
    snapshot("E", opening.id, {
      status: "Mystery Status",
      registeredDate: "2026-08-25",
      quality: ["unmapped_status"],
    }),
  ];
  const closingRows = [
    snapshot("A", closing.id, {
      status: "Awaiting Assessor Report",
      workingAge: 13,
    }),
    snapshot("B", closing.id, {
      status: "Registered",
      registeredDate: "2026-06-20",
      calendarAge: 74,
      workingAge: 52,
    }),
    snapshot("C", closing.id, {
      status: "Payment Released",
      open: false,
      terminal: true,
      registeredDate: "2026-06-01",
      calendarAge: 105,
      workingAge: 73,
    }),
    snapshot("D", closing.id, { registeredDate: "2026-08-25", calendarAge: 9 }),
    snapshot("E", closing.id, {
      status: "Mystery Status",
      registeredDate: "2026-08-25",
      quality: ["unmapped_status"],
    }),
  ];
  const weekTwo = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-31",
    manifests: [opening, closing],
    snapshotsByExtract: new Map([
      [opening.id, openingRows],
      [closing.id, closingRows],
    ]),
    changes: [
      {
        claim_id: "B",
        change_type: "reopened",
        provenance: "system_derived",
        observed_at: "2026-09-01T10:00:00.000Z",
      },
      {
        claim_id: "C",
        change_type: "terminal_transition_observed",
        provenance: "system_derived",
        observed_at: "2026-09-02T10:00:00.000Z",
      },
    ],
    activeUsers: users,
    previousSnapshot: weekOne,
  });
  assert.equal(weekTwo.metrics.opening_inventory.value, 4);
  assert.equal(weekTwo.metrics.closing_inventory.value, 4);
  assert.equal(weekTwo.metrics.net_inventory_movement.value, 0);
  assert.equal(weekTwo.metrics.new_claims_registered.value, 0);
  assert.equal(weekTwo.metrics.claims_closed.value, 1);
  assert.equal(weekTwo.comparisons.closing_inventory.previous, 4);
  assert.equal(weekTwo.comparisons.new_claims_registered.previous, 2);
  assert.equal(weekTwo.comparisons.new_claims_registered.absolute_delta, -2);
});

test("insufficient history never fabricates zero state metrics", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2020-01-06",
    manifests: [],
    snapshotsByExtract: new Map(),
    changes: [],
    activeUsers: users,
  });
  assert.equal(report.coverage_status, "insufficient");
  assert.equal(report.metrics.opening_inventory.value, null);
  assert.equal(report.metrics.closing_inventory.value, null);
  assert.equal(report.metrics.financial_open_outstanding.value, null);
  assert.ok(report.coverage.warnings.includes("no_closing_snapshot"));
});

test("report claim populations are preserved for future drill-through", () => {
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...week1Evidence(),
  });
  const readyIds = metricPopulationForSnapshot(report, "ready_to_close");
  assert.deepEqual(readyIds, ["C"]);
  const row = report.claim_rows.find((claim) => claim.claim_id === "C");
  assert.ok(row.metric_ids.includes("ready_to_close"));
  assert.equal(row.source_claim_number, "C");
});

test("report generation is deterministic for the same historical evidence", () => {
  const data = week1Evidence();
  const first = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  const second = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-08-24",
    ...data,
  });
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.coverage, second.coverage);
  assert.deepEqual(first.claim_rows, second.claim_rows);
});
