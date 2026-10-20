import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REPORT_ACTION_ITEM_COLUMNS,
  REPORT_ATTENTION_ITEM_COLUMNS,
  workflowMembershipPayload,
  workflowSnapshot,
} from "./management-workflow.mjs";

const root = new URL("../", import.meta.url);
const schema = readFileSync(new URL("supabase/migrations/20260825141850_management_attention_action_plan.sql", root), "utf8");

function columnsFor(table) {
  const match = schema.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
  assert.ok(match, `migration defines ${table}`);
  return new Set(match[1].split(/\r?\n/).map((line) => line.trim().match(/^([a-z][a-z0-9_]*)\s+/i)?.[1]).filter(Boolean));
}

test("workflow payload allowlists are subsets of the actual membership table schemas", () => {
  for (const [table, allowed, type] of [
    ["scout_report_attention_items", REPORT_ATTENTION_ITEM_COLUMNS, "attention"],
    ["scout_report_action_items", REPORT_ACTION_ITEM_COLUMNS, "action"],
  ]) {
    const payload = workflowMembershipPayload(Object.fromEntries(allowed.map((key) => [key, null])), type);
    const schemaColumns = columnsFor(table);
    assert.deepEqual(Object.keys(payload), [...allowed]);
    for (const key of Object.keys(payload)) assert.ok(schemaColumns.has(key), `${table}.${key} exists`);
    assert.equal("broker_snapshot" in payload, false);
    assert.equal("evidence_row_count" in payload, false);
  }
});

test("claim-linked finalisation and carry-forward snapshots stay within allowlists", () => {
  for (const type of ["attention", "action"]) {
    const snapshot = workflowSnapshot({
      id: "item-id", claim_id: "claim-id", source_claim_number_snapshot: "REN0002-1",
      title: "Review", action: "Call", category: type === "attention" ? "operational" : "claim",
      priority: "high", status: "open", handler_snapshot: "Lucky", claim_status_snapshot: "Registered",
      insurer_snapshot: "Cardinal", broker_snapshot: "Bryanston", evidence_row_count: 3,
    }, type, "run-id", { carriedForwardFromReportId: "old-run", displayOrder: 2 });
    const payload = workflowMembershipPayload({ ...snapshot, broker_snapshot: "Bryanston", evidence_row_count: 3 }, type);
    const allowed = type === "attention" ? REPORT_ATTENTION_ITEM_COLUMNS : REPORT_ACTION_ITEM_COLUMNS;
    assert.deepEqual(Object.keys(payload), Object.keys(snapshot));
    assert.ok(Object.keys(payload).every((key) => allowed.includes(key)));
    assert.equal(payload.claim_id, "claim-id");
    assert.equal(payload.carried_forward_from_report_id, "old-run");
  }
});
