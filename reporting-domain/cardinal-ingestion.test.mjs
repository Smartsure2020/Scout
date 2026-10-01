import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  CARDINAL_FIELD_ALIASES,
  KNOWN_CARDINAL_COLUMNS,
  mapCardinalRows,
  parseNullableDate,
  parseNullableNumber,
  validateCardinalColumns,
} from "../scout-smartsure/claims/cardinal-ingestion.mjs";
import {
  buildObservedChanges,
  normalizeHistoricalRows,
} from "./history.mjs";
import {
  buildReportSnapshot,
  extractObservationInstant,
  selectBoundaryExtract,
} from "./reporting-metrics.mjs";
import { resolveScoutHandler } from "./roles.mjs";
import {
  buildCurrentStateClaimRecord,
  historicalManifestRecord,
} from "../scout backend.js";
import {
  csvWorksheetRows,
  xlsxWorksheetRows,
} from "./fixtures/cardinal-parity-fixtures.mjs";

const users = [
  {
    id: "handler-1",
    email: "handler.one@example.test",
    display_name: "Handler One",
    role: "handler",
    active: true,
  },
];

const normalizers = {
  normalizeHandler: (value) => value,
  normalizeStatus: (value) => String(value).trim().toLowerCase(),
};

test("CSV and XLSX worksheet fixtures produce the same canonical Scout claim", () => {
  const fromCsv = mapCardinalRows(csvWorksheetRows, normalizers);
  const fromXlsx = mapCardinalRows(xlsxWorksheetRows, normalizers);
  assert.deepEqual(fromCsv, fromXlsx);
  assert.equal(fromCsv[0].registeredDate, "2026-09-29");
  assert.equal("registered" in fromCsv[0], false);
  assert.equal(fromCsv[0].estimate, 2000);
  assert.equal(fromCsv[0].outstanding, 1234.5);
  assert.equal(fromCsv[0].paid, 0);
});

test("required-column validation uses canonical alias groups and knows every consumed column", () => {
  const aliases = [
    "Claim No",
    "Status",
    "Claim Handler",
    "Age",
    "Insurer",
    ...KNOWN_CARDINAL_COLUMNS,
  ];
  const validation = validateCardinalColumns(aliases);
  assert.deepEqual(validation.missingFields, []);
  assert.deepEqual(validation.unmappedColumns, []);
  assert.deepEqual(CARDINAL_FIELD_ALIASES.claimNo, ["Claim No.", "Claim No"]);
  assert.deepEqual(CARDINAL_FIELD_ALIASES.status, ["Claims Status", "Status"]);
});

test("financial parsing keeps concepts separate and distinguishes zero, missing, and malformed", () => {
  assert.deepEqual(parseNullableNumber("0"), { value: 0, state: "known" });
  assert.deepEqual(parseNullableNumber(""), { value: null, state: "missing" });
  assert.deepEqual(parseNullableNumber("not money"), {
    value: null,
    state: "malformed",
  });
  assert.deepEqual(parseNullableNumber("(R 1,250.75)"), {
    value: -1250.75,
    state: "known",
  });

  const [claim] = mapCardinalRows(
    [
      {
        "Claim No.": "FIN-1",
        "Claims Status": "Registered",
        "Claim Handler": "Handler One",
        Age: "bad age",
        Insurer: "Insurer",
        "Nett Claim": "R 900",
        "Own Damage Original Estimate": "R 1,200.50",
        Paid: "",
        Mandate: "invalid",
      },
    ],
    normalizers,
  );
  assert.equal(claim.outstanding, null, "Nett Claim must not backfill Outstanding");
  assert.equal(claim.nettClaim, 900);
  assert.equal(claim.estimate, 1200.5);
  assert.equal(claim.paid, null);
  assert.equal(claim.mandate, null);
  assert.equal(claim.age, null);
  assert.ok(claim.ingestionQualityFlags.includes("source_parse_failure:age"));
  assert.ok(claim.ingestionQualityFlags.includes("source_parse_failure:mandate"));
});

test("date parsing keeps South African CSV dates in parity with XLSX dates and rejects rollover", () => {
  assert.deepEqual(parseNullableDate("29/09/2026"), {
    value: "2026-09-29",
    state: "known",
  });
  assert.deepEqual(parseNullableDate("31/02/2026"), {
    value: null,
    state: "malformed",
  });
  assert.deepEqual(parseNullableDate(""), { value: null, state: "missing" });
});

test("history accepts the canonical registeredDate and legacy registered alias without rewriting snapshots", () => {
  const canonical = normalizeHistoricalRows(
    [{ claimNo: "REG-1", status: "Registered", registeredDate: "2026-09-29" }],
    { effectiveDate: "2026-09-30" },
  );
  const legacy = normalizeHistoricalRows(
    [{ claimNo: "REG-2", status: "Registered", registered: "2026-09-28" }],
    { effectiveDate: "2026-09-30" },
  );
  assert.equal(canonical.snapshots[0].registered_date, "2026-09-29");
  assert.equal(legacy.snapshots[0].registered_date, "2026-09-28");
});

test("Cardinal fields without dedicated history columns remain in immutable source evidence", () => {
  const [claim] = mapCardinalRows(csvWorksheetRows, normalizers);
  const normalized = normalizeHistoricalRows([claim], {
    effectiveDate: "2026-09-30",
    activeUsers: users,
  });
  const evidence = normalized.snapshots[0].source_evidence;
  assert.equal(evidence.nettClaim, 1100);
  assert.equal(evidence.sumInsured, 500000);
  assert.deepEqual(evidence.ingestionQualityFlags, []);
});

test("Cardinal Last Updated populates the immutable movement-date column", () => {
  const [claim] = mapCardinalRows(
    [
      {
        "Claim No.": "MOVE-1",
        "Claims Status": "Registered",
        "Claim Handler": "Handler One",
        Age: 1,
        Insurer: "Example Insurer",
        "Last Updated": "30/09/2026",
      },
    ],
    normalizers,
  );
  const normalized = normalizeHistoricalRows([claim], {
    effectiveDate: "2026-10-01",
    activeUsers: users,
  });
  assert.equal(normalized.snapshots[0].movement_date, "2026-09-30");
});

test("frontend parse failures remain visible in historical quality flags", () => {
  const normalized = normalizeHistoricalRows(
    [
      {
        claimNo: "BAD-1",
        status: "Registered",
        outstanding: null,
        ingestionQualityFlags: ["source_parse_failure:outstanding"],
      },
    ],
    { effectiveDate: "2026-09-30" },
  );
  assert.equal(normalized.snapshots[0].outstanding, null);
  assert.ok(
    normalized.snapshots[0].data_quality_flags.includes(
      "source_parse_failure:outstanding",
    ),
  );
});

test("handler resolution is shared, deterministic, and never guesses by first name", () => {
  assert.equal(resolveScoutHandler(users, "One, Handler").status, "resolved");
  assert.equal(
    resolveScoutHandler(
      [
        ...users,
        {
          id: "handler-2",
          email: "handler.two@example.test",
          display_name: "Handler Two",
          role: "handler",
          active: true,
        },
      ],
      "Handler",
    ).status,
    "unrecognised",
  );
});

test("current-state mapping preserves operational dates, values, and source warnings", () => {
  const mapped = buildCurrentStateClaimRecord(
    {
      claimNo: "CUR-1",
      handlerRaw: "One Handler",
      handler: "Handler One",
      registeredDate: "2026-09-29",
      dol: "2026-09-28",
      age: 7,
      cardinalAge: 7,
      workingAge: null,
      outstanding: 0,
      estimate: 500,
      paid: 0,
      repudiationDate: "2026-09-27",
      lastUpdated: "2026-09-30",
      lastUpdatedSource: "cardinal",
      settledDate: "2026-09-30",
      ingestionQualityFlags: ["source_parse_failure:mandate"],
    },
    "2026-09-30",
    users,
  );
  assert.equal(mapped.handlerResolution, "resolved");
  assert.equal(mapped.record.handler_email, "handler.one@example.test");
  assert.equal(mapped.record.registered_date, "2026-09-29");
  assert.equal(mapped.record.dol, "2026-09-28");
  assert.equal(mapped.record.age_days, 7);
  assert.equal(mapped.record.cardinal_age_days, 7);
  assert.equal(mapped.record.outstanding, 0);
  assert.equal(mapped.record.estimate, 500);
  assert.equal(mapped.record.paid, 0);
  assert.equal(mapped.record.repudiation_date, "2026-09-27");
  assert.equal(mapped.record.last_updated, "2026-09-30");
  assert.equal(mapped.record.last_updated_source, "cardinal");
  assert.equal(mapped.record.settled_date, "2026-09-30");
  assert.deepEqual(mapped.record.ingestion_quality_flags, [
    "source_parse_failure:mandate",
  ]);
  assert.equal("mandate" in mapped.record, false, "history-only fields are not duplicated");
});

test("a delayed upload is observed on receipt and cannot become a September closing extract", () => {
  const delayed = historicalManifestRecord({
    checksum: "delayed-checksum",
    checksumBasis: "claims-json-payload",
    fileName: "cardinal-30-sep.csv",
    extractDate: "2026-10-01",
    effectiveAt: null,
    receivedAt: "2026-10-01T08:00:00.000Z",
    currentUser: { id: "admin", email: "admin@example.test" },
    claims: [{}],
    normalized: { quality: { accepted_claim_count: 1, rejected_claim_count: 0 } },
    quality: { hard_rejection: false, completeness_state: "complete" },
    previousManifest: null,
    sourceMetadata: {
      effective_date_basis: "upload_received_date",
      portfolio_scope: "claims",
    },
    correctionOfExtractId: null,
  });
  const accepted = {
    ...delayed,
    id: "delayed",
    status: "accepted",
    historical_persisted: true,
  };

  assert.equal(delayed.effective_date, "2026-10-01");
  assert.equal(delayed.effective_precision, "unknown");
  assert.equal(
    extractObservationInstant(accepted).toISOString(),
    "2026-10-01T08:00:00.000Z",
  );
  assert.equal(
    selectBoundaryExtract([accepted], "2026-09-30T22:00:00.000Z", {
      scope: { portfolio_scope: "claims" },
    }).manifest,
    null,
  );
  const afterReceipt = selectBoundaryExtract(
    [accepted],
    "2026-10-01T08:00:00.000Z",
    { scope: { portfolio_scope: "claims" } },
  );
  assert.equal(afterReceipt.manifest.id, "delayed");
  assert.equal(afterReceipt.precision, "observed_period");
});

test("upload-derived effective dates retain received-date provenance without claiming source precision", () => {
  const record = historicalManifestRecord({
    checksum: "checksum",
    checksumBasis: "claims-json-payload",
    fileName: "cardinal.csv",
    extractDate: "2026-09-30",
    effectiveAt: null,
    receivedAt: "2026-09-30T10:00:00.000Z",
    currentUser: { id: "admin", email: "admin@example.test" },
    claims: [{}],
    normalized: { quality: { accepted_claim_count: 1, rejected_claim_count: 0 } },
    quality: { hard_rejection: false },
    previousManifest: null,
    sourceMetadata: { effective_date_basis: "upload_received_date" },
    correctionOfExtractId: null,
  });
  assert.equal(record.effective_date, "2026-09-30");
  assert.equal(record.effective_at, null);
  assert.equal(record.effective_precision, "unknown");
  assert.equal(
    record.source_metadata.effective_date_basis,
    "upload_received_date",
  );
});

function manifest(id, date, count, previousExtractId = null) {
  return {
    id,
    source_system: "cardinal_claims",
    source_metadata: { portfolio_scope: "claims" },
    source_checksum: `${id}-checksum`,
    effective_date: date,
    received_at: `${date}T12:00:00.000Z`,
    status: "accepted",
    historical_persisted: true,
    claim_count: count,
    accepted_claim_count: count,
    quality_summary: {
      completeness_state: "complete",
      comparable_to_previous: true,
      warnings: [],
      unmapped_status_count: 0,
      unknown_handler_count: 0,
      identity_ambiguity_count: 0,
    },
    previous_extract_id: previousExtractId,
    correction_of_extract_id: null,
  };
}

function historical(rows, extractId, effectiveDate) {
  const normalized = normalizeHistoricalRows(mapCardinalRows(rows, normalizers), {
    effectiveDate,
    activeUsers: users,
  });
  return {
    quality: normalized.quality,
    snapshots: normalized.snapshots.map((snapshot) => ({
      ...snapshot,
      extract_id: extractId,
      claim_id: snapshot.source_claim_number,
    })),
  };
}

test("representative Cardinal fixture reconciles source to canonical to history to report", () => {
  const base = (claimNo, status, age, registeredDate, money = {}) => ({
    "Claim No.": claimNo,
    "Claims Status": status,
    "Claim Handler": money.handler || "Handler One",
    Age: age,
    Insurer: "Example Insurer",
    "Claim Registered": registeredDate,
    Outstanding: money.outstanding ?? "",
    "Original Estimate": money.estimate ?? "",
    Paid: money.paid ?? "",
  });
  const openingRows = [
    base("B", "Awaiting Claim Form", 20, "2026-09-01", { outstanding: 300, estimate: 400, paid: 50 }),
    base("D", "Registered", "", "", {}),
    base("E", "New Cardinal Status", 5, "2026-09-10", { outstanding: 50, estimate: 100, paid: 0 }),
    base("DISAPPEARS", "Registered", 2, "2026-09-25", { outstanding: 25, estimate: 25, paid: 0 }),
  ];
  const closingRows = [
    base("A", "Registered", 1, "2026-09-29", { outstanding: 100, estimate: 200, paid: 0 }),
    base("B", "Awaiting Claim Form", 20, "2026-09-01", { outstanding: 300, estimate: 400, paid: 50 }),
    base("D", "Registered", "", "", {}),
    base("E", "New Cardinal Status", 5, "2026-09-10", { outstanding: 50, estimate: 100, paid: 0 }),
    base("C", "Closed Paid", 10, "2026-09-15", { outstanding: 0, estimate: 100, paid: 100 }),
  ];
  const opening = historical(openingRows, "opening", "2026-09-27");
  const closing = historical(closingRows, "closing", "2026-09-30");
  const openingManifest = manifest("opening", "2026-09-27", opening.snapshots.length);
  const closingManifest = manifest("closing", "2026-09-30", closing.snapshots.length, "opening");
  const changes = buildObservedChanges(
    openingManifest,
    opening.snapshots,
    closingManifest,
    closing.snapshots,
  );
  const report = buildReportSnapshot({
    reportType: "weekly",
    periodStart: "2026-09-28",
    manifests: [openingManifest, closingManifest],
    snapshotsByExtract: new Map([
      ["opening", opening.snapshots],
      ["closing", closing.snapshots],
    ]),
    changes,
    activeUsers: users,
  });

  assert.equal(closingRows.length, 5);
  assert.equal(closing.quality.source_row_count, 5);
  assert.equal(closing.quality.accepted_claim_count, 5);
  assert.equal(
    closing.snapshots.filter((row) => row.open).length +
      closing.snapshots.filter((row) => row.terminal).length,
    5,
  );
  assert.equal(report.metrics.closing_inventory.value, 4);
  const ageing = report.metrics.ageing_distribution.value;
  assert.equal(Object.values(ageing).reduce((sum, value) => sum + value, 0), 4);
  const handlers = report.metrics.handler_performance.value;
  assert.equal(
    handlers.handlers.reduce((sum, row) => sum + row.open_claims, 0) +
      handlers.manager_held_other.count +
      handlers.unassigned_unresolved.count,
    4,
  );
  const sla = report.metrics.sla_summary.value;
  assert.deepEqual(
    {
      compliant: sla.compliant,
      breached: sla.breached,
      unmapped: sla.unmapped,
      unknown: sla.unknown,
      denominator: sla.denominator,
    },
    { compliant: 1, breached: 1, unmapped: 1, unknown: 1, denominator: 2 },
  );
  assert.equal(sla.compliant + sla.breached, sla.denominator);
  assert.equal(report.metrics.financial_open_outstanding.value, 450);
  assert.equal(report.metrics.financial_estimate_total.value, 700);
  assert.equal(report.metrics.financial_paid_total.value, 50);
  assert.equal(report.metrics.new_claims_registered.value, 1);
  assert.ok(
    !report.metrics.new_claims_first_observed.claim_population.claim_ids.includes("A"),
    "registration-new claims must not also count as first-observed",
  );
  assert.equal(report.metrics.claims_closed.value, 0, "disappearance is not closure");
});

test("production claims page routes both CSV and XLSX through the shared mapper", async () => {
  const html = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /accept="\.xlsx,\.csv"/);
  assert.match(html, /XLSX\.read\(e\.target\.result/);
  assert.match(html, /ingestion\.mapCardinalRows\(json/);
  assert.match(html, /src="\.\/cardinal-ingestion\.mjs"/);
  assert.match(html, /src="\.\/current-state-adapter\.mjs"/);
  assert.match(html, /adapter\.currentStateRowToClaim/);
});
