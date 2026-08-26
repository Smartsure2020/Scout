import test from "node:test";
import assert from "node:assert/strict";
import {
  canArchiveReport,
  canFinaliseReport,
  canRegenerateReport,
  reportActionAllowed,
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
