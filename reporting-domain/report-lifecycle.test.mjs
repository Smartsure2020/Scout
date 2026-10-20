import test from "node:test";
import assert from "node:assert/strict";
import {
  canArchiveReport,
  canFinaliseReport,
  canRegenerateReport,
  reportActionAllowed,
  reportFinalisationCompatibility,
  reportRegenerationCompatibility,
  REPORT_ENGINE_VERSION,
  reportSnapshotMutable,
} from "./report-lifecycle.mjs";

test("report authorization is role-based and manager is not archive authority", () => {
  assert.equal(reportActionAllowed("handler", "view"), false);
  assert.equal(reportActionAllowed("manager", "view"), true);
  assert.equal(reportActionAllowed("manager", "generate"), true);
  assert.equal(reportActionAllowed("manager", "manage_workflow"), true);
  assert.equal(reportActionAllowed("manager", "pdf_export"), true);
  assert.equal(reportActionAllowed("admin", "view_workflow"), true);
  assert.equal(reportActionAllowed("handler", "manage_workflow"), false);
  assert.equal(reportActionAllowed("manager", "archive"), false);
  assert.equal(reportActionAllowed("admin", "archive"), true);
  assert.equal(reportActionAllowed("unknown", "drill_through"), false);
  assert.equal(reportActionAllowed("handler", "pdf_export"), false);
});

test("draft lifecycle allows regeneration and finalisation but not archiving", () => {
  assert.equal(canRegenerateReport("draft"), true);
  assert.equal(canFinaliseReport("draft"), true);
  assert.equal(canArchiveReport("draft"), false);
  assert.equal(reportSnapshotMutable("draft"), true);
});

test("finalised lifecycle is idempotently finalisable but not regenerable", () => {
  assert.equal(canRegenerateReport("finalised"), false);
  assert.equal(canFinaliseReport("finalised"), true);
  assert.equal(canArchiveReport("finalised"), true);
  assert.equal(reportSnapshotMutable("finalised"), false);
});

test("archived lifecycle cannot be regenerated or changed back", () => {
  assert.equal(canRegenerateReport("archived"), false);
  assert.equal(canFinaliseReport("archived"), false);
  assert.equal(canArchiveReport("archived"), true);
  assert.equal(reportSnapshotMutable("archived"), false);
});

const v2 = {
  metric_definition_version: "claims-reporting-metrics-v2",
  report_schema_version: "scout-report-v2",
};
const v3 = {
  metric_definition_version: "claims-reporting-metrics-v3",
  report_schema_version: "scout-report-v3",
};

test("a v2 engine cannot regenerate a v3 draft, while same-version regeneration works", () => {
  assert.equal(reportRegenerationCompatibility(v3, v2).allowed, false);
  assert.match(
    reportRegenerationCompatibility(v3, v2).message,
    /newer or incompatible/,
  );
  assert.equal(reportRegenerationCompatibility(v3, v3).allowed, true);
  assert.equal(reportRegenerationCompatibility(v2, v2).allowed, true);
});

test("a v3 Worker cannot regenerate or finalise a v4 management draft", () => {
  const v4 = { ...v3, metric_definition_version: "claims-reporting-metrics-v4", report_schema_version: "scout-report-v4" };
  assert.equal(reportRegenerationCompatibility(v4, v3, true).allowed, false);
  assert.equal(reportFinalisationCompatibility(v4, v3).allowed, false);
  assert.equal(reportRegenerationCompatibility(v3, v4, false).allowed, false);
  assert.equal(reportRegenerationCompatibility(v3, v4, true).allowed, true);
});

test("v2 to v3 draft upgrade needs explicit permission and unknown pairs fail closed", () => {
  assert.equal(reportRegenerationCompatibility(v2, v3).allowed, false);
  assert.equal(reportRegenerationCompatibility(v2, v3, true).allowed, true);
  assert.equal(
    reportRegenerationCompatibility(
      { ...v3, report_schema_version: "unknown" },
      v3,
      true,
    ).allowed,
    false,
  );
  assert.equal(
    reportRegenerationCompatibility(
      v3,
      { ...v3, metric_definition_version: "unknown" },
      true,
    ).allowed,
    false,
  );
});

test("Finalise requires this serving engine's exact metric/schema pair", () => {
  assert.equal(REPORT_ENGINE_VERSION, "claims-report-engine-v4");
  assert.equal(reportFinalisationCompatibility(v3, v3).allowed, true);
  assert.equal(reportFinalisationCompatibility(v3, { ...v3, report_schema_version: "scout-report-v4", metric_definition_version: "claims-reporting-metrics-v4" }).allowed, false);
  assert.equal(reportFinalisationCompatibility(v2, v3).allowed, false);
  assert.equal(reportFinalisationCompatibility(v3, v2).allowed, false);
});
