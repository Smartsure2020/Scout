export const REPORT_STATUSES = Object.freeze([
  "draft",
  "finalised",
  "archived",
]);

export function reportActionAllowed(role, action) {
  if (action === "archive") return role === "admin";
  if (action === "manage_workflow" || action === "view_workflow")
    return ["manager", "admin"].includes(role);
  if (
    [
      "view",
      "generate",
      "regenerate",
      "finalise",
      "drill_through",
      "pdf_export",
    ].includes(action)
  )
    return ["manager", "admin"].includes(role);
  return false;
}

export function canRegenerateReport(status) {
  return status === "draft";
}

export function canFinaliseReport(status) {
  return status === "draft" || status === "finalised";
}

export function canArchiveReport(status) {
  return status === "finalised" || status === "archived";
}

export function reportSnapshotMutable(status) {
  return status === "draft";
}
