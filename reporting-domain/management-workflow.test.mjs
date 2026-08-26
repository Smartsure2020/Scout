import test from "node:test";
import assert from "node:assert/strict";
import {
  isActionCarryForwardEligible,
  isAttentionCarryForwardEligible,
  isWorkflowItemOverdue,
  normaliseWorkflowRecord,
  validateActionInput,
  validateAttentionInput,
  workflowSnapshot,
} from "./management-workflow.mjs";

const activeOwners = ["manager@scout.example", "handler@scout.example"];

test("attention creation validates required fields and active owners", () => {
  const valid = validateAttentionInput(
    {
      title: "Material development",
      category: "claim_development",
      priority: "high",
      ownerUserId: "manager@scout.example",
      dueDate: "2026-08-28",
    },
    { activeOwnerIds: activeOwners },
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.value.status, "open");

  const invalid = validateAttentionInput(
    {
      category: "not-a-category",
      priority: "urgent",
      ownerUserId: "former@scout.example",
    },
    { activeOwnerIds: activeOwners },
  );
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.title);
  assert.ok(invalid.errors.category);
  assert.ok(invalid.errors.priority);
  assert.ok(invalid.errors.ownerUserId);
});

test("attention lifecycle accepts monitoring and waiting and records resolved state", () => {
  for (const status of ["open", "monitoring", "waiting", "resolved"])
    assert.equal(
      validateAttentionInput({
        title: "A",
        category: "operational",
        priority: "medium",
        status,
      }).ok,
      true,
    );
  assert.equal(isAttentionCarryForwardEligible("monitoring"), true);
  assert.equal(isAttentionCarryForwardEligible("waiting"), true);
  assert.equal(isAttentionCarryForwardEligible("resolved"), false);
});

test("action validation requires action text and supports in-progress, waiting and completed", () => {
  assert.equal(
    validateActionInput({ action: "Call insurer", category: "insurer" }).ok,
    true,
  );
  assert.equal(
    validateActionInput({ action: "Call insurer", status: "in_progress" }).ok,
    true,
  );
  assert.equal(
    validateActionInput({ action: "Call insurer", status: "waiting" }).ok,
    true,
  );
  assert.equal(
    validateActionInput({ action: "Call insurer", status: "completed" }).ok,
    true,
  );
  assert.equal(validateActionInput({ category: "insurer" }).ok, false);
  assert.equal(isActionCarryForwardEligible("completed"), false);
  assert.equal(isActionCarryForwardEligible("waiting"), true);
});

test("report membership snapshots keep lineage and do not delete the live item", () => {
  const live = {
    id: "attention-a",
    claim_id: "claim-a",
    source_claim_number_snapshot: "CLM-001",
    title: "A",
    management_note: "Waiting for insurer",
    category: "insurer_facility",
    priority: "high",
    owner_user_id: "manager@scout.example",
    owner_display_snapshot: "Manager",
    next_action: "Escalate Friday",
    due_date: "2026-08-28",
    status: "waiting",
  };
  const snapshot = workflowSnapshot(live, "attention", "week-2", {
    carriedForwardFromReportId: "week-1",
    displayOrder: 3,
  });
  assert.equal(snapshot.attention_item_id, live.id);
  assert.equal(snapshot.carried_forward_from_report_id, "week-1");
  assert.equal(snapshot.display_order, 3);
  assert.equal(live.status, "waiting");
});

test("draft membership is idempotent and deliberate removal is not recreated by regeneration", () => {
  const memberships = new Map();
  const add = (reportId, itemId) => {
    const key = `${reportId}:${itemId}`;
    if (memberships.has(key)) return false;
    memberships.set(key, { reportId, itemId });
    return true;
  };
  assert.equal(add("week-2", "attention-a"), true);
  assert.equal(add("week-2", "attention-a"), false);
  memberships.delete("week-2:attention-a");
  assert.equal(memberships.has("week-2:attention-a"), false);
});

test("weekly carry-forward uses unresolved live status and excludes resolved records", () => {
  const attentionStatuses = ["open", "monitoring", "waiting", "resolved"];
  const actionStatuses = ["open", "in_progress", "waiting", "completed"];
  assert.deepEqual(attentionStatuses.filter(isAttentionCarryForwardEligible), [
    "open",
    "monitoring",
    "waiting",
  ]);
  assert.deepEqual(actionStatuses.filter(isActionCarryForwardEligible), [
    "open",
    "in_progress",
    "waiting",
  ]);
});

test("overdue is display-only and completed records are never overdue", () => {
  assert.equal(
    isWorkflowItemOverdue(
      { status: "waiting", due_date: "2026-08-20" },
      "2026-08-25",
    ),
    true,
  );
  assert.equal(
    isWorkflowItemOverdue(
      { status: "resolved", due_date: "2026-08-20" },
      "2026-08-25",
    ),
    false,
  );
  assert.equal(
    isWorkflowItemOverdue(
      { status: "completed", due_date: "2026-08-20" },
      "2026-08-25",
    ),
    false,
  );
});

test("Week 1, Week 2 and Week 3 history remains frozen while live workflow advances", () => {
  const attention = {
    id: "attention-a",
    title: "A",
    category: "insurer_facility",
    priority: "high",
    status: "waiting",
    claim_id: "claim-a",
    source_claim_number_snapshot: "CLM-001",
  };
  const action = {
    id: "action-a",
    action: "Escalate insurer",
    category: "insurer",
    status: "waiting",
    claim_id: "claim-a",
    source_claim_number_snapshot: "CLM-001",
  };
  const weekOneAttention = workflowSnapshot(attention, "attention", "week-1");
  const weekOneAction = workflowSnapshot(action, "action", "week-1");
  const weekTwoAttention = workflowSnapshot(attention, "attention", "week-2", {
    carriedForwardFromReportId: "week-1",
  });
  const weekTwoAction = workflowSnapshot(action, "action", "week-2", {
    carriedForwardFromReportId: "week-1",
  });
  attention.status = "resolved";
  action.status = "completed";
  assert.equal(weekOneAttention.status_snapshot, "waiting");
  assert.equal(weekOneAction.status_snapshot, "waiting");
  assert.equal(weekTwoAttention.status_snapshot, "waiting");
  assert.equal(weekTwoAction.status_snapshot, "waiting");
  assert.equal(isAttentionCarryForwardEligible(attention.status), false);
  assert.equal(isActionCarryForwardEligible(action.status), false);
  assert.equal(
    normaliseWorkflowRecord(weekOneAttention, "attention").status,
    "waiting",
  );
});
