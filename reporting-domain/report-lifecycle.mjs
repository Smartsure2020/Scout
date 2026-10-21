export const REPORT_STATUSES = Object.freeze([
  "draft",
  "finalised",
  "archived",
]);

export const REPORT_ENGINE_VERSION = "claims-report-engine-v5";

const REPORT_GENERATIONS = Object.freeze({
  "claims-reporting-metrics-v2|scout-report-v2": Object.freeze({
    compatibleUpgradeTo: ["claims-reporting-metrics-v3|scout-report-v3"],
  }),
  "claims-reporting-metrics-v3|scout-report-v3": Object.freeze({
    compatibleUpgradeTo: ["claims-reporting-metrics-v4|scout-report-v4"],
  }),
  "claims-reporting-metrics-v4|scout-report-v4": Object.freeze({
    compatibleUpgradeTo: ["claims-reporting-metrics-v5|scout-report-v5"],
  }),
  "claims-reporting-metrics-v5|scout-report-v5": Object.freeze({
    compatibleUpgradeTo: [],
  }),
});

function reportGenerationKey(run) {
  return `${run?.metric_definition_version || ""}|${run?.report_schema_version || ""}`;
}

export function reportRegenerationCompatibility(
  existing,
  current,
  allowCompatibleUpgrade = false,
) {
  const existingKey = reportGenerationKey(existing);
  const currentKey = reportGenerationKey(current);
  if (!REPORT_GENERATIONS[existingKey] || !REPORT_GENERATIONS[currentKey])
    return {
      allowed: false,
      message:
        "Report version is not recognised by this report engine; the draft was not changed.",
    };
  if (existingKey === currentKey) return { allowed: true };
  if (REPORT_GENERATIONS[existingKey].compatibleUpgradeTo.includes(currentKey))
    return allowCompatibleUpgrade === true
      ? { allowed: true }
      : {
          allowed: false,
          message:
            "This draft uses an older report generation. Regenerate with allowCompatibleUpgrade=true to upgrade it explicitly.",
        };
  return {
    allowed: false,
    message:
      "This draft was created by a newer or incompatible report engine; it was not changed.",
  };
}

export function reportFinalisationCompatibility(existing, current) {
  const existingKey = reportGenerationKey(existing);
  const currentKey = reportGenerationKey(current);
  return existingKey === currentKey && Boolean(REPORT_GENERATIONS[currentKey])
    ? { allowed: true }
    : {
        allowed: false,
        message:
          "This draft is incompatible with the serving report engine and cannot be finalised.",
      };
}

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
