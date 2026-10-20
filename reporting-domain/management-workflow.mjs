export const ATTENTION_CATEGORIES = Object.freeze([
  "claim_development",
  "insurer_facility",
  "assessor",
  "investigator",
  "broker_client",
  "payment",
  "mandate_high_value",
  "complaint",
  "legal_nfo",
  "fraud",
  "data_system",
  "operational",
  "other",
]);

export const ATTENTION_PRIORITIES = Object.freeze(["high", "medium", "low"]);
export const ATTENTION_STATUSES = Object.freeze([
  "open",
  "monitoring",
  "waiting",
  "resolved",
]);

export const ACTION_CATEGORIES = Object.freeze([
  "claim",
  "insurer",
  "broker",
  "supplier",
  "payment",
  "system",
  "team",
  "management",
  "other",
]);

export const ACTION_STATUSES = Object.freeze([
  "open",
  "in_progress",
  "waiting",
  "completed",
]);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function ownerValue(ownerUserId, activeOwnerIds = []) {
  if (ownerUserId === null || ownerUserId === undefined || ownerUserId === "")
    return { ok: true, value: null };
  const value = cleanText(ownerUserId);
  return {
    ok: activeOwnerIds.length === 0 || activeOwnerIds.includes(value),
    value,
  };
}

export function validateAttentionInput(input = {}, options = {}) {
  const errors = {};
  const title = cleanText(input.title);
  const category = cleanText(input.category);
  const priority = cleanText(input.priority || "medium");
  const status = cleanText(input.status || "open");
  const owner = ownerValue(
    input.ownerUserId ?? input.owner_user_id,
    options.activeOwnerIds,
  );

  if (!title) errors.title = "A title is required.";
  if (!ATTENTION_CATEGORIES.includes(category))
    errors.category = "Choose a valid attention category.";
  if (!ATTENTION_PRIORITIES.includes(priority))
    errors.priority = "Choose a valid priority.";
  if (!ATTENTION_STATUSES.includes(status))
    errors.status = "Choose a valid attention status.";
  if (!owner.ok) errors.ownerUserId = "Owner must be an active Scout user.";
  if (!validDate(input.dueDate ?? input.due_date))
    errors.dueDate = "Due date must be a valid Johannesburg calendar date.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      title,
      managementNote: cleanText(input.managementNote ?? input.management_note),
      category,
      priority,
      ownerUserId: owner.value,
      nextAction: cleanText(input.nextAction ?? input.next_action),
      dueDate: input.dueDate ?? input.due_date ?? null,
      status,
      resolutionNote: cleanText(input.resolutionNote ?? input.resolution_note),
    },
  };
}

export function validateActionInput(input = {}, options = {}) {
  const errors = {};
  const action = cleanText(input.action);
  const category = cleanText(input.category || "other");
  const status = cleanText(input.status || "open");
  const owner = ownerValue(
    input.ownerUserId ?? input.owner_user_id,
    options.activeOwnerIds,
  );

  if (!action) errors.action = "An action is required.";
  if (!ACTION_CATEGORIES.includes(category))
    errors.category = "Choose a valid action category.";
  if (!ACTION_STATUSES.includes(status))
    errors.status = "Choose a valid action status.";
  if (!owner.ok) errors.ownerUserId = "Owner must be an active Scout user.";
  if (!validDate(input.dueDate ?? input.due_date))
    errors.dueDate = "Due date must be a valid Johannesburg calendar date.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      action,
      category,
      ownerUserId: owner.value,
      dueDate: input.dueDate ?? input.due_date ?? null,
      status,
      resolutionNote: cleanText(input.resolutionNote ?? input.resolution_note),
    },
  };
}

export function isAttentionCarryForwardEligible(status) {
  return ["open", "monitoring", "waiting"].includes(status);
}

export function isActionCarryForwardEligible(status) {
  return ["open", "in_progress", "waiting"].includes(status);
}

export function isWorkflowItemOverdue(item, currentDate) {
  const dueDate = item?.due_date || item?.dueDate || null;
  const status = item?.status || "";
  const completed = status === "resolved" || status === "completed";
  return Boolean(dueDate && currentDate && dueDate < currentDate && !completed);
}

export function workflowSnapshot(item, type, reportId, options = {}) {
  const carried = options.carriedForwardFromReportId || null;
  if (type === "attention") {
    return {
      report_run_id: reportId,
      attention_item_id: item.id,
      claim_id: item.claim_id || null,
      claim_number_snapshot: item.source_claim_number_snapshot || null,
      title_snapshot: item.title,
      management_note_snapshot: item.management_note || null,
      category_snapshot: item.category,
      priority_snapshot: item.priority,
      owner_user_id_snapshot: item.owner_user_id || null,
      owner_display_snapshot: item.owner_display_snapshot || null,
      handler_snapshot:
        item.handler_snapshot || item.claim_handler_snapshot || null,
      claim_status_snapshot:
        item.claim_status_snapshot || item.status_snapshot || null,
      insurer_snapshot:
        item.insurer_snapshot || item.claim_insurer_snapshot || null,
      next_action_snapshot: item.next_action || null,
      due_date_snapshot: item.due_date || null,
      status_snapshot: item.status,
      resolution_note_snapshot: item.resolution_note || null,
      display_order: options.displayOrder || 0,
      carried_forward_from_report_id: carried,
    };
  }
  return {
    report_run_id: reportId,
    action_id: item.id,
    attention_item_id_snapshot: item.attention_item_id || null,
    claim_id: item.claim_id || null,
    claim_number_snapshot: item.source_claim_number_snapshot || null,
    action_snapshot: item.action,
    category_snapshot: item.category,
    owner_user_id_snapshot: item.owner_user_id || null,
    owner_display_snapshot: item.owner_display_snapshot || null,
    handler_snapshot:
      item.handler_snapshot || item.claim_handler_snapshot || null,
    claim_status_snapshot:
      item.claim_status_snapshot || item.status_snapshot || null,
    insurer_snapshot:
      item.insurer_snapshot || item.claim_insurer_snapshot || null,
    due_date_snapshot: item.due_date || null,
    status_snapshot: item.status,
    resolution_note_snapshot: item.resolution_note || null,
    display_order: options.displayOrder || 0,
    carried_forward_from_report_id: carried,
  };
}

// These allowlists mirror the membership-table columns in
// 20260825141850_management_attention_action_plan.sql. Keep DB writes explicit:
// claim context is enrichment, not permission to add arbitrary PostgREST keys.
export const REPORT_ATTENTION_ITEM_COLUMNS = Object.freeze([
  "report_run_id", "attention_item_id", "claim_id", "claim_number_snapshot",
  "title_snapshot", "management_note_snapshot", "category_snapshot",
  "priority_snapshot", "owner_user_id_snapshot", "owner_display_snapshot",
  "handler_snapshot", "claim_status_snapshot", "insurer_snapshot",
  "next_action_snapshot", "due_date_snapshot", "status_snapshot",
  "resolution_note_snapshot", "display_order", "carried_forward_from_report_id",
]);

export const REPORT_ACTION_ITEM_COLUMNS = Object.freeze([
  "report_run_id", "action_id", "attention_item_id_snapshot", "claim_id",
  "claim_number_snapshot", "action_snapshot", "category_snapshot",
  "owner_user_id_snapshot", "owner_display_snapshot", "handler_snapshot",
  "claim_status_snapshot", "insurer_snapshot", "due_date_snapshot",
  "status_snapshot", "resolution_note_snapshot", "display_order",
  "carried_forward_from_report_id",
]);

export function workflowMembershipPayload(snapshot, type) {
  const columns = type === "attention"
    ? REPORT_ATTENTION_ITEM_COLUMNS
    : REPORT_ACTION_ITEM_COLUMNS;
  return Object.fromEntries(columns
    .filter((column) => Object.hasOwn(snapshot || {}, column))
    .map((column) => [column, snapshot[column]]));
}

export function normaliseWorkflowRecord(record, type) {
  if (!record) return null;
  const attention = type === "attention";
  return {
    ...record,
    id: record.id || record[attention ? "attention_item_id" : "action_id"],
    claim_id: record.claim_id || null,
    claim_number:
      record.source_claim_number_snapshot ||
      record.claim_number_snapshot ||
      null,
    title: attention ? record.title_snapshot || record.title : undefined,
    management_note: attention
      ? record.management_note_snapshot || record.management_note
      : undefined,
    action: attention ? undefined : record.action_snapshot || record.action,
    category: record.category_snapshot || record.category,
    priority: attention
      ? record.priority_snapshot || record.priority
      : undefined,
    owner_display:
      record.owner_display_snapshot || record.owner_display || null,
    next_action: attention
      ? record.next_action_snapshot || record.next_action
      : undefined,
    due_date: record.due_date_snapshot || record.due_date || null,
    status: record.status_snapshot || record.status,
    resolution_note:
      record.resolution_note_snapshot || record.resolution_note || null,
    carried_forward_from_report_id:
      record.carried_forward_from_report_id || null,
  };
}
