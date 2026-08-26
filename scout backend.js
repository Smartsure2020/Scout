// ============================================================
// SMARTSURE SCOUT — CLOUDFLARE WORKER BACKEND
// Deploy as: scout-backend.marketing-854.workers.dev
// Environment variables needed (set in Cloudflare dashboard):
//   SUPABASE_URL      = https://vsuoesiwifktyutmzxhx.supabase.co
//   SUPABASE_ANON    = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
//   SUPABASE_SERVICE = (your full service role key)
//   AZURE_CLIENT_ID  = c148ea21-63f3-4058-aa82-08fbaebf19df
//   AZURE_TENANT_ID  = 0728ffc8-457f-4ae5-8c44-30c3ef0ecd5a
//   TEAMS_WEBHOOK    = (paste the Power Automate URL here)
// ============================================================

import {
  assessExtractQuality,
  buildObservedChanges,
  computeSourceChecksum,
  DEFAULT_SOURCE_SYSTEM,
  HISTORY_SCHEMA_VERSION,
  normalizeHistoricalRows,
  safeHistorySnapshot,
  sourceChecksumPayload,
} from "./reporting-domain/history.mjs";
import {
  buildReportSnapshot,
  extractObservationInstant,
  previousReportingPeriod,
  reportScopeKey,
  reportingPeriod,
  REPORTING_DOMAIN,
  REPORTING_METRIC_VERSION,
  REPORTING_QUALITY_VERSION,
  REPORT_SCHEMA_VERSION,
  selectBoundaryExtract,
} from "./reporting-domain/reporting-metrics.mjs";
import {
  canArchiveReport,
  canFinaliseReport,
  canRegenerateReport,
  reportActionAllowed,
} from "./reporting-domain/report-lifecycle.mjs";
import {
  PDF_RENDERER_VERSION,
  PDF_TEMPLATE_VERSION,
  renderClaimsReportHtml,
  reportPdfFilename,
} from "./reporting-domain/claims-report-pdf.mjs";
import {
  ACTION_STATUSES,
  ATTENTION_STATUSES,
  isActionCarryForwardEligible,
  isAttentionCarryForwardEligible,
  validateActionInput,
  validateAttentionInput,
  workflowSnapshot,
} from "./reporting-domain/management-workflow.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── Supabase helpers ─────────────────────────────────────────
async function supabase(
  env,
  path,
  method = "GET",
  body = null,
  useService = false,
  prefer = null,
) {
  const key = useService ? env.SUPABASE_SERVICE : env.SUPABASE_ANON;
  const res = await fetch(env.SUPABASE_URL + "/rest/v1" + path, {
    method,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: prefer || (method === "POST" ? "return=representation" : ""),
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok && res.status !== 204) {
    const e = await res.text();
    throw new Error("Supabase error " + res.status + ": " + e.slice(0, 200));
  }
  if (res.status === 204) return null;
  return res.json();
}

async function supabaseAll(env, path, useService = true, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await supabase(
      env,
      `${path}${separator}limit=${pageSize}&offset=${offset}`,
      "GET",
      null,
      useService,
    );
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function getHistoryManifestByChecksum(env, sourceSystem, checksum) {
  const rows = await supabase(
    env,
    "/scout_history_extracts?source_system=eq." +
      encodeURIComponent(sourceSystem) +
      "&source_checksum=eq." +
      encodeURIComponent(checksum) +
      "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getHistoryManifestById(env, id) {
  if (!id) return null;
  const rows = await supabase(
    env,
    "/scout_history_extracts?id=eq." +
      encodeURIComponent(id) +
      "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getLatestHistoryManifest(env, sourceSystem) {
  const rows = await supabase(
    env,
    "/scout_history_extracts?source_system=eq." +
      encodeURIComponent(sourceSystem) +
      "&status=in.(accepted,accepted_with_warnings)&order=received_at.desc&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getHistorySnapshots(env, extractId) {
  return supabaseAll(
    env,
    "/scout_history_snapshots?extract_id=eq." +
      encodeURIComponent(extractId) +
      "&select=*",
    true,
  );
}

async function updateHistoryManifest(env, id, patch) {
  await supabase(
    env,
    "/scout_history_extracts?id=eq." + encodeURIComponent(id),
    "PATCH",
    patch,
    true,
    "return=representation",
  );
}

async function getActiveHistoryUsers(env) {
  try {
    return {
      users: await supabaseAll(env, "/scout_users?active=eq.true&select=*"),
      unavailable: false,
    };
  } catch {
    return { users: [], unavailable: true };
  }
}

async function ensureHistoryClaimEntity(env, snapshot) {
  const record = {
    source_system: DEFAULT_SOURCE_SYSTEM,
    source_claim_number: snapshot.source_claim_number,
    identity_key: snapshot.identity_key,
    identity_confidence: snapshot.identity_confidence,
    identity_matchable: snapshot.identity_matchable,
    identity_note: snapshot.identity_matchable
      ? null
      : "Source claim number is ambiguous within this extract",
  };
  if (snapshot.identity_matchable && snapshot.identity_key) {
    const inserted = await supabase(
      env,
      "/scout_history_claims?on_conflict=identity_key",
      "POST",
      record,
      true,
      "resolution=ignore-duplicates,return=representation",
    );
    if (inserted?.[0]?.id) return inserted[0].id;
    const existing = await supabase(
      env,
      "/scout_history_claims?identity_key=eq." +
        encodeURIComponent(snapshot.identity_key) +
        "&select=id&limit=1",
      "GET",
      null,
      true,
    );
    if (existing?.[0]?.id) return existing[0].id;
    throw new Error(
      "Historical claim identity could not be resolved after idempotent insert",
    );
  }
  const inserted = await supabase(
    env,
    "/scout_history_claims",
    "POST",
    record,
    true,
    "return=representation",
  );
  if (!inserted?.[0]?.id)
    throw new Error(
      "Historical ambiguous claim identity insert returned no id",
    );
  return inserted[0].id;
}

async function persistHistoricalEvidence(
  env,
  { manifest, previousManifest, normalized, quality },
) {
  const existingRows = await supabaseAll(
    env,
    "/scout_history_snapshots?extract_id=eq." +
      encodeURIComponent(manifest.id) +
      "&select=source_row_identity,claim_id",
    true,
  );
  const existingByRow = new Map(
    existingRows.map((row) => [row.source_row_identity, row.claim_id]),
  );
  const snapshotRows = [];
  for (const snapshot of normalized.snapshots) {
    const existingClaimId = existingByRow.get(snapshot.source_row_identity);
    const claimId =
      existingClaimId || (await ensureHistoryClaimEntity(env, snapshot));
    snapshot.claim_id = claimId;
    const {
      identity_key: _identityKey,
      identity_confidence: _identityConfidence,
      identity_matchable: _identityMatchable,
      _raw_source: _rawSource,
      _evaluation: _evaluation,
      _row_status: _rowStatus,
      movement_source_value: _movementSourceValue,
      ...row
    } = snapshot;
    snapshotRows.push({
      ...row,
      extract_id: manifest.id,
      identity_key: snapshot.identity_key,
      identity_matchable: snapshot.identity_matchable,
      identity_confidence: snapshot.identity_confidence,
    });
  }
  for (let index = 0; index < snapshotRows.length; index += 200) {
    await supabase(
      env,
      "/scout_history_snapshots",
      "POST",
      snapshotRows.slice(index, index + 200),
      true,
      "resolution=ignore-duplicates,return=representation",
    );
  }

  const currentSnapshots = await getHistorySnapshots(env, manifest.id);
  const previousSnapshots = previousManifest
    ? await getHistorySnapshots(env, previousManifest.id)
    : [];
  const currentManifest = { ...manifest, quality_summary: quality };
  const changes = buildObservedChanges(
    previousManifest,
    previousSnapshots,
    currentManifest,
    currentSnapshots,
  ).map((change) => ({
    ...change,
    dedupe_key: [
      change.source_extract_id,
      change.claim_id,
      change.previous_extract_id || "none",
      change.change_type,
    ].join("|"),
  }));
  for (let index = 0; index < changes.length; index += 200) {
    await supabase(
      env,
      "/scout_history_changes",
      "POST",
      changes.slice(index, index + 200),
      true,
      "resolution=ignore-duplicates,return=representation",
    );
  }
  return {
    snapshotCount: currentSnapshots.length,
    changeCount: changes.length,
  };
}

function exactEffectiveAt(value) {
  if (
    !value ||
    typeof value !== "string" ||
    !/T/.test(value) ||
    !/(Z|[+-]\d{2}:?\d{2})$/.test(value)
  )
    return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function historicalManifestRecord({
  checksum,
  checksumBasis,
  fileName,
  extractDate,
  effectiveAt,
  receivedAt,
  currentUser,
  claims,
  normalized,
  quality,
  previousManifest,
  sourceMetadata,
  correctionOfExtractId,
}) {
  const sourceEffectiveAt = exactEffectiveAt(effectiveAt);
  return {
    source_system: DEFAULT_SOURCE_SYSTEM,
    source_file_name: fileName || "cardinal-extract.xlsx",
    source_checksum: checksum,
    checksum_algorithm: "sha-256",
    checksum_basis: checksumBasis,
    effective_at: sourceEffectiveAt,
    effective_date: extractDate || null,
    effective_precision: sourceEffectiveAt
      ? "exact_timestamp"
      : extractDate
        ? "source_date"
        : "unknown",
    received_at: receivedAt,
    uploaded_by_email: currentUser.email,
    uploaded_by_user_id: currentUser.id || null,
    time_zone: "Africa/Johannesburg",
    schema_version: HISTORY_SCHEMA_VERSION,
    claim_count: claims.length,
    accepted_claim_count: normalized.quality.accepted_claim_count,
    rejected_claim_count: normalized.quality.rejected_claim_count,
    quality_summary: quality,
    previous_extract_id: previousManifest?.id || null,
    correction_of_extract_id:
      correctionOfExtractId ||
      (previousManifest?.effective_date &&
      extractDate &&
      previousManifest.effective_date === extractDate
        ? previousManifest.id
        : null),
    source_metadata: sourceMetadata || {},
    status: quality.hard_rejection ? "rejected" : "processing",
    historical_persisted: false,
    current_state_updated: false,
  };
}

async function preserveHistoricalExtract(
  env,
  {
    claims,
    fileName,
    extractDate,
    effectiveAt,
    sourceChecksum,
    sourceMetadata,
    correctionOfExtractId,
    currentUser,
  },
) {
  const checksumResult = await computeSourceChecksum(
    {
      source_system: DEFAULT_SOURCE_SYSTEM,
      source_file_name: fileName || "cardinal-extract.xlsx",
      extract_date: extractDate || null,
      effective_at: effectiveAt || null,
      source_metadata: sourceMetadata || {},
      claims: sourceChecksumPayload(claims),
    },
    sourceChecksum,
  );
  const existing = await getHistoryManifestByChecksum(
    env,
    DEFAULT_SOURCE_SYSTEM,
    checksumResult.checksum,
  );
  if (
    existing?.status === "accepted" ||
    existing?.status === "accepted_with_warnings"
  ) {
    return {
      kind: "duplicate",
      manifest: existing,
      quality: existing.quality_summary || {},
    };
  }
  if (existing?.status === "rejected") {
    return {
      kind: "rejected",
      manifest: existing,
      quality: existing.quality_summary || {},
    };
  }

  const users = await getActiveHistoryUsers(env);
  const normalized = normalizeHistoricalRows(claims, {
    sourceSystem: DEFAULT_SOURCE_SYSTEM,
    effectiveDate: extractDate || null,
    activeUsers: users.users,
  });
  const previousManifest = existing?.previous_extract_id
    ? await getHistoryManifestById(env, existing.previous_extract_id)
    : await getLatestHistoryManifest(env, DEFAULT_SOURCE_SYSTEM);
  const quality = assessExtractQuality(normalized, {
    previousManifest,
    sourceSystem: DEFAULT_SOURCE_SYSTEM,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    sourceMetadata: sourceMetadata || {},
    maxRowCountDropRatio: Number(env.HISTORY_MAX_ROW_COUNT_DROP_RATIO || 0.5),
  });
  if (effectiveAt && !exactEffectiveAt(effectiveAt)) {
    quality.warnings = [...(quality.warnings || []), "invalid_effective_at"];
    quality.quality_state = quality.hard_rejection ? "rejected" : "warning";
  }
  if (users.unavailable)
    quality.warnings = [...(quality.warnings || []), "user_lookup_unavailable"];
  if (users.unavailable)
    quality.quality_state = quality.hard_rejection ? "rejected" : "warning";
  const receivedAt = new Date().toISOString();
  let manifest = existing;
  if (!manifest) {
    manifest = await supabase(
      env,
      "/scout_history_extracts?on_conflict=source_system,source_checksum",
      "POST",
      historicalManifestRecord({
        checksum: checksumResult.checksum,
        checksumBasis: checksumResult.basis,
        fileName,
        extractDate,
        effectiveAt,
        receivedAt,
        currentUser,
        claims,
        normalized,
        quality,
        previousManifest,
        sourceMetadata,
        correctionOfExtractId,
      }),
      true,
      "resolution=ignore-duplicates,return=representation",
    ).then((rows) => rows?.[0] || null);
    if (!manifest)
      manifest = await getHistoryManifestByChecksum(
        env,
        DEFAULT_SOURCE_SYSTEM,
        checksumResult.checksum,
      );
  }
  if (!manifest)
    throw new Error(
      "Historical extract manifest could not be created or recovered",
    );
  if (quality.hard_rejection) {
    await updateHistoryManifest(env, manifest.id, {
      status: "rejected",
      quality_summary: quality,
    });
    return { kind: "rejected", manifest, quality };
  }
  if (!manifest.historical_persisted) {
    try {
      await persistHistoricalEvidence(env, {
        manifest,
        previousManifest,
        normalized,
        quality,
      });
      await updateHistoryManifest(env, manifest.id, {
        historical_persisted: true,
        quality_summary: quality,
      });
      manifest = {
        ...manifest,
        historical_persisted: true,
        quality_summary: quality,
      };
    } catch (error) {
      try {
        await updateHistoryManifest(env, manifest.id, {
          status: "partial_failure",
          quality_summary: {
            ...quality,
            historical_persistence_error: String(error?.message || error),
          },
        });
      } catch {
        /* preserve the original failure */
      }
      throw new Error(
        "Historical persistence failed: " + (error?.message || error),
      );
    }
  }
  return { kind: "ready", manifest, quality, historicalPersisted: true };
}

async function getAcceptedReportManifests(env) {
  return supabaseAll(
    env,
    "/scout_history_extracts?source_system=eq." +
      encodeURIComponent(DEFAULT_SOURCE_SYSTEM) +
      "&status=in.(accepted,accepted_with_warnings)&select=*&order=received_at.asc",
    true,
  );
}

async function getHistoryChangesForRange(env, start, end) {
  return supabaseAll(
    env,
    "/scout_history_changes?observed_at=gte." +
      encodeURIComponent(start.toISOString()) +
      "&observed_at=lt." +
      encodeURIComponent(end.toISOString()) +
      "&select=*&order=observed_at.asc",
    true,
  );
}

async function getReportRunById(env, id) {
  if (!id) return null;
  const rows = await supabase(
    env,
    "/scout_report_runs?id=eq." + encodeURIComponent(id) + "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getReportRunByKey(
  env,
  { reportType, periodStart, periodEnd, scopeKey },
) {
  const rows = await supabase(
    env,
    "/scout_report_runs?domain=eq." +
      encodeURIComponent(REPORTING_DOMAIN) +
      "&report_type=eq." +
      encodeURIComponent(reportType) +
      "&period_start=eq." +
      encodeURIComponent(periodStart) +
      "&period_end=eq." +
      encodeURIComponent(periodEnd) +
      "&scope_key=eq." +
      encodeURIComponent(scopeKey) +
      "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getReportRunClaims(env, reportRunId) {
  return supabaseAll(
    env,
    "/scout_report_run_claims?report_run_id=eq." +
      encodeURIComponent(reportRunId) +
      "&select=*&order=source_claim_number.asc",
    true,
  );
}

const WORKFLOW_TABLES = Object.freeze([
  "scout_management_attention",
  "scout_management_actions",
  "scout_report_attention_items",
  "scout_report_action_items",
]);

function isWorkflowSchemaError(error) {
  return WORKFLOW_TABLES.some((table) =>
    String(error?.message || error).includes(table),
  );
}

function workflowDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

async function getActiveWorkflowUsers(env) {
  return supabaseAll(
    env,
    "/scout_users?active=eq.true&select=email,display_name,role,active&order=display_name.asc",
    true,
  );
}

async function resolveWorkflowOwner(env, ownerUserId) {
  if (ownerUserId === null || ownerUserId === undefined || ownerUserId === "")
    return { ownerUserId: null, ownerDisplay: null };
  const value = String(ownerUserId).trim().toLowerCase();
  const users = await getActiveWorkflowUsers(env);
  const user = users.find(
    (candidate) => String(candidate.email || "").toLowerCase() === value,
  );
  if (!user) throw new RangeError("Owner must be an active Scout user");
  return {
    ownerUserId: user.email,
    ownerDisplay: user.display_name || user.email,
  };
}

async function resolveWorkflowClaim(env, { claimId, sourceClaimNumber } = {}) {
  const id = uuidValue(claimId);
  const number = String(sourceClaimNumber || "").trim();
  if (!id && !number) return null;
  const filter = id
    ? `/scout_history_claims?id=eq.${encodeURIComponent(id)}&select=*&limit=2`
    : `/scout_history_claims?source_claim_number=eq.${encodeURIComponent(number)}&identity_matchable=eq.true&select=*&limit=2`;
  const rows = await supabase(env, filter, "GET", null, true);
  const claim = rows?.length === 1 ? rows[0] : null;
  if (!claim || claim.identity_matchable === false)
    throw new RangeError(
      "Claim link must resolve to one matchable historical claim",
    );
  return claim;
}

function workflowAttentionPublic(item) {
  if (!item) return null;
  const safe = { ...item };
  return {
    ...safe,
    claim_number:
      safe.source_claim_number_snapshot || safe.claim_number_snapshot || null,
    title: safe.title || safe.title_snapshot || null,
    management_note:
      safe.management_note || safe.management_note_snapshot || null,
    next_action: safe.next_action || safe.next_action_snapshot || null,
    due_date: safe.due_date || safe.due_date_snapshot || null,
    status: safe.status || safe.status_snapshot || null,
    category: safe.category || safe.category_snapshot || null,
    priority: safe.priority || safe.priority_snapshot || null,
    owner_display: safe.owner_display_snapshot || safe.owner_display || null,
    resolution_note:
      safe.resolution_note_snapshot || safe.resolution_note || null,
  };
}

function workflowActionPublic(item) {
  if (!item) return null;
  const safe = { ...item };
  return {
    ...safe,
    claim_number:
      safe.source_claim_number_snapshot || safe.claim_number_snapshot || null,
    action: safe.action || safe.action_snapshot || null,
    due_date: safe.due_date || safe.due_date_snapshot || null,
    status: safe.status || safe.status_snapshot || null,
    category: safe.category || safe.category_snapshot || null,
    owner_display: safe.owner_display_snapshot || safe.owner_display || null,
    resolution_note:
      safe.resolution_note_snapshot || safe.resolution_note || null,
  };
}

async function getManagementAttentionById(env, id) {
  const rows = await supabase(
    env,
    "/scout_management_attention?id=eq." +
      encodeURIComponent(id) +
      "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getManagementActionById(env, id) {
  const rows = await supabase(
    env,
    "/scout_management_actions?id=eq." +
      encodeURIComponent(id) +
      "&select=*&limit=1",
    "GET",
    null,
    true,
  );
  return rows?.[0] || null;
}

async function getReportWorkflowMembership(env, reportId, type) {
  const table =
    type === "attention"
      ? "scout_report_attention_items"
      : "scout_report_action_items";
  return supabaseAll(
    env,
    `/${table}?report_run_id=eq.${encodeURIComponent(reportId)}&select=*&order=display_order.asc,created_at.asc`,
    true,
  );
}

async function getWorkflowClaimContext(env, run, claimId) {
  if (!claimId) return {};
  try {
    const boundary = run?.closing_extract_id
      ? `&extract_id=eq.${encodeURIComponent(run.closing_extract_id)}`
      : "";
    const rows = await supabase(
      env,
      "/scout_history_snapshots?claim_id=eq." +
        encodeURIComponent(claimId) +
        boundary +
        "&select=handler_source,handler_email,status_normalized,insurer&order=source_row_index.desc&limit=1",
      "GET",
      null,
      true,
    );
    const row = rows?.[0];
    if (!row) return {};
    return {
      handler_snapshot: row.handler_source || row.handler_email || null,
      claim_status_snapshot: row.status_normalized || null,
      insurer_snapshot: row.insurer || null,
    };
  } catch {
    return {};
  }
}

async function workflowSnapshotForReport(env, item, type, run, options = {}) {
  const claimContext = await getWorkflowClaimContext(env, run, item.claim_id);
  return {
    ...workflowSnapshot(item, type, run.id, options),
    ...claimContext,
  };
}

async function loadReportWorkflow(env, run) {
  try {
    if (run.status === "finalised" || run.status === "archived") {
      const [attention, actions] = await Promise.all([
        getReportWorkflowMembership(env, run.id, "attention"),
        getReportWorkflowMembership(env, run.id, "action"),
      ]);
      return {
        available: true,
        attention_items: attention.map(workflowAttentionPublic),
        action_items: actions.map(workflowActionPublic),
      };
    }

    const [attentionMembership, actionMembership] = await Promise.all([
      getReportWorkflowMembership(env, run.id, "attention"),
      getReportWorkflowMembership(env, run.id, "action"),
    ]);
    const [attention, actions] = await Promise.all([
      Promise.all(
        attentionMembership.map(async (membership) => {
          const live = await getManagementAttentionById(
            env,
            membership.attention_item_id,
          );
          return live
            ? {
                ...live,
                report_membership_id: membership.id,
                display_order: membership.display_order,
                carried_forward_from_report_id:
                  membership.carried_forward_from_report_id || null,
              }
            : null;
        }),
      ),
      Promise.all(
        actionMembership.map(async (membership) => {
          const live = await getManagementActionById(env, membership.action_id);
          return live
            ? {
                ...live,
                report_membership_id: membership.id,
                display_order: membership.display_order,
                carried_forward_from_report_id:
                  membership.carried_forward_from_report_id || null,
              }
            : null;
        }),
      ),
    ]);
    return {
      available: true,
      attention_items: attention.filter(Boolean).map(workflowAttentionPublic),
      action_items: actions.filter(Boolean).map(workflowActionPublic),
    };
  } catch (error) {
    if (isWorkflowSchemaError(error))
      return { available: false, attention_items: [], action_items: [] };
    throw error;
  }
}

async function publicReportWithWorkflow(env, run) {
  const report = publicReportRun(run);
  if (!report) return null;
  const workflow = await loadReportWorkflow(env, run);
  return { ...report, ...workflow, workflow };
}

async function getExactCarryForwardSource(env, run) {
  const previous = previousReportingPeriod(run.report_type, run.period_start);
  const base =
    "/scout_report_runs?domain=eq." +
    encodeURIComponent(REPORTING_DOMAIN) +
    "&report_type=eq." +
    encodeURIComponent(run.report_type) +
    "&period_start=eq." +
    encodeURIComponent(previous.start.toISOString()) +
    "&period_end=eq." +
    encodeURIComponent(previous.end.toISOString()) +
    "&scope_key=eq." +
    encodeURIComponent(run.scope_key) +
    "&select=*&limit=2";
  const finalised = await supabase(
    env,
    base + "&status=in.(finalised,archived)",
    "GET",
    null,
    true,
  );
  if (finalised?.[0]) return finalised[0];
  const drafts = await supabase(
    env,
    base + "&status=eq.draft",
    "GET",
    null,
    true,
  );
  return drafts?.[0] || null;
}

async function ensureCarryForwardForNewDraft(env, run, currentUser = null) {
  const source = await getExactCarryForwardSource(env, run);
  if (!source)
    return { attentionCount: 0, actionCount: 0, sourceReportId: null };
  const [sourceAttention, sourceActions] = await Promise.all([
    getReportWorkflowMembership(env, source.id, "attention"),
    getReportWorkflowMembership(env, source.id, "action"),
  ]);
  let attentionCount = 0;
  let actionCount = 0;
  for (const row of sourceAttention) {
    const live = await getManagementAttentionById(env, row.attention_item_id);
    if (!live || !isAttentionCarryForwardEligible(live.status)) continue;
    await supabase(
      env,
      "/scout_report_attention_items",
      "POST",
      await workflowSnapshotForReport(env, live, "attention", run, {
        carriedForwardFromReportId: source.id,
        displayOrder: row.display_order,
      }),
      true,
      "resolution=ignore-duplicates,return=minimal",
    );
    attentionCount += 1;
    if (currentUser)
      await audit(
        env,
        currentUser.email,
        currentUser.name,
        "management_attention_carried_forward",
        {
          report_id: run.id,
          source_report_id: source.id,
          attention_item_id: live.id,
        },
      );
  }
  for (const row of sourceActions) {
    const live = await getManagementActionById(env, row.action_id);
    if (!live || !isActionCarryForwardEligible(live.status)) continue;
    await supabase(
      env,
      "/scout_report_action_items",
      "POST",
      await workflowSnapshotForReport(env, live, "action", run, {
        carriedForwardFromReportId: source.id,
        displayOrder: row.display_order,
      }),
      true,
      "resolution=ignore-duplicates,return=minimal",
    );
    actionCount += 1;
    if (currentUser)
      await audit(
        env,
        currentUser.email,
        currentUser.name,
        "management_action_carried_forward",
        {
          report_id: run.id,
          source_report_id: source.id,
          action_id: live.id,
        },
      );
  }
  return { attentionCount, actionCount, sourceReportId: source.id };
}

async function syncReportWorkflowSnapshots(env, runId) {
  const run = await getReportRunById(env, runId);
  if (!run) throw new Error("Report not found before workflow snapshot");
  const [attentionMembership, actionMembership] = await Promise.all([
    getReportWorkflowMembership(env, runId, "attention"),
    getReportWorkflowMembership(env, runId, "action"),
  ]);
  for (const membership of attentionMembership) {
    const live = await getManagementAttentionById(
      env,
      membership.attention_item_id,
    );
    if (!live)
      throw new Error("Attention item disappeared before finalisation");
    await supabase(
      env,
      "/scout_report_attention_items?id=eq." +
        encodeURIComponent(membership.id),
      "PATCH",
      await workflowSnapshotForReport(env, live, "attention", run, {
        carriedForwardFromReportId: membership.carried_forward_from_report_id,
        displayOrder: membership.display_order,
      }),
      true,
      "return=minimal",
    );
  }
  for (const membership of actionMembership) {
    const live = await getManagementActionById(env, membership.action_id);
    if (!live) throw new Error("Action disappeared before finalisation");
    await supabase(
      env,
      "/scout_report_action_items?id=eq." + encodeURIComponent(membership.id),
      "PATCH",
      await workflowSnapshotForReport(env, live, "action", run, {
        carriedForwardFromReportId: membership.carried_forward_from_report_id,
        displayOrder: membership.display_order,
      }),
      true,
      "return=minimal",
    );
  }
  return {
    attentionCount: attentionMembership.length,
    actionCount: actionMembership.length,
  };
}

async function validateWorkflowReport(env, reportId, requireDraft = false) {
  const run = await getReportRunById(env, reportId);
  if (!run) throw new RangeError("Report not found");
  if (requireDraft && run.status !== "draft")
    throw new RangeError(
      "Workflow membership can only change while a report is Draft",
    );
  return run;
}

async function createAttentionRecord(env, body, currentUser) {
  const activeUsers = await getActiveWorkflowUsers(env);
  const validation = validateAttentionInput(body, {
    activeOwnerIds: activeUsers.map((user) => user.email),
  });
  if (!validation.ok)
    throw new RangeError(Object.values(validation.errors).join(" "));
  const owner = await resolveWorkflowOwner(env, validation.value.ownerUserId);
  const claim = await resolveWorkflowClaim(env, {
    claimId: body.claimId ?? body.claim_id,
    sourceClaimNumber: body.sourceClaimNumber ?? body.source_claim_number,
  });
  const originatingReportId =
    body.originatingReportId ?? body.originating_report_id;
  if (originatingReportId)
    await validateWorkflowReport(env, originatingReportId, true);
  const now = new Date().toISOString();
  const record = {
    domain: REPORTING_DOMAIN,
    claim_id: claim?.id || null,
    source_claim_number_snapshot:
      claim?.source_claim_number ||
      (body.sourceClaimNumber ?? body.source_claim_number ?? null),
    title: validation.value.title,
    management_note: validation.value.managementNote || null,
    category: validation.value.category,
    priority: validation.value.priority,
    owner_user_id: owner.ownerUserId,
    owner_display_snapshot: owner.ownerDisplay,
    next_action: validation.value.nextAction || null,
    due_date: workflowDate(validation.value.dueDate),
    status: validation.value.status,
    created_by: currentUser.email,
    updated_by: currentUser.email,
    originating_report_id: originatingReportId || null,
    updated_at: now,
    ...(validation.value.status === "resolved"
      ? {
          resolved_at: now,
          resolved_by: currentUser.email,
          resolution_note: validation.value.resolutionNote || null,
        }
      : {}),
  };
  const rows = await supabase(
    env,
    "/scout_management_attention",
    "POST",
    record,
    true,
    "return=representation",
  );
  return rows?.[0] || null;
}

async function updateAttentionRecord(env, existing, body, currentUser) {
  const activeUsers = await getActiveWorkflowUsers(env);
  const merged = {
    title: body.title ?? existing.title,
    managementNote:
      body.managementNote ?? body.management_note ?? existing.management_note,
    category: body.category ?? existing.category,
    priority: body.priority ?? existing.priority,
    ownerUserId:
      Object.prototype.hasOwnProperty.call(body, "ownerUserId") ||
      Object.prototype.hasOwnProperty.call(body, "owner_user_id")
        ? (body.ownerUserId ?? body.owner_user_id)
        : existing.owner_user_id,
    nextAction: body.nextAction ?? body.next_action ?? existing.next_action,
    dueDate: body.dueDate ?? body.due_date ?? existing.due_date,
    status: body.status ?? existing.status,
    resolutionNote:
      body.resolutionNote ?? body.resolution_note ?? existing.resolution_note,
  };
  const validation = validateAttentionInput(merged, {
    activeOwnerIds: activeUsers.map((user) => user.email),
  });
  if (!validation.ok)
    throw new RangeError(Object.values(validation.errors).join(" "));
  const owner = await resolveWorkflowOwner(env, validation.value.ownerUserId);
  let claim = null;
  if (
    Object.prototype.hasOwnProperty.call(body, "claimId") ||
    Object.prototype.hasOwnProperty.call(body, "claim_id") ||
    Object.prototype.hasOwnProperty.call(body, "sourceClaimNumber") ||
    Object.prototype.hasOwnProperty.call(body, "source_claim_number")
  ) {
    claim = await resolveWorkflowClaim(env, {
      claimId: body.claimId ?? body.claim_id,
      sourceClaimNumber: body.sourceClaimNumber ?? body.source_claim_number,
    });
  }
  const nextStatus = validation.value.status;
  const now = new Date().toISOString();
  const payload = {
    title: validation.value.title,
    management_note: validation.value.managementNote || null,
    category: validation.value.category,
    priority: validation.value.priority,
    owner_user_id: owner.ownerUserId,
    owner_display_snapshot: owner.ownerDisplay,
    next_action: validation.value.nextAction || null,
    due_date: workflowDate(validation.value.dueDate),
    status: nextStatus,
    updated_at: now,
    updated_by: currentUser.email,
  };
  if (
    claim ||
    Object.prototype.hasOwnProperty.call(body, "claimId") ||
    Object.prototype.hasOwnProperty.call(body, "claim_id") ||
    Object.prototype.hasOwnProperty.call(body, "sourceClaimNumber") ||
    Object.prototype.hasOwnProperty.call(body, "source_claim_number")
  ) {
    payload.claim_id = claim?.id || null;
    payload.source_claim_number_snapshot = claim?.source_claim_number || null;
  }
  if (nextStatus === "resolved") {
    payload.resolved_at =
      existing.status === "resolved" ? existing.resolved_at || now : now;
    payload.resolved_by =
      existing.status === "resolved"
        ? existing.resolved_by || currentUser.email
        : currentUser.email;
    payload.resolution_note = validation.value.resolutionNote || null;
  } else {
    payload.resolved_at = null;
    payload.resolved_by = null;
    payload.resolution_note = null;
  }
  const rows = await supabase(
    env,
    "/scout_management_attention?id=eq." + encodeURIComponent(existing.id),
    "PATCH",
    payload,
    true,
    "return=representation",
  );
  return rows?.[0] || (await getManagementAttentionById(env, existing.id));
}

async function createActionRecord(env, body, currentUser) {
  const activeUsers = await getActiveWorkflowUsers(env);
  const validation = validateActionInput(body, {
    activeOwnerIds: activeUsers.map((user) => user.email),
  });
  if (!validation.ok)
    throw new RangeError(Object.values(validation.errors).join(" "));
  const owner = await resolveWorkflowOwner(env, validation.value.ownerUserId);
  const attentionItemId = body.attentionItemId ?? body.attention_item_id;
  const attention = attentionItemId
    ? await getManagementAttentionById(env, attentionItemId)
    : null;
  if (attentionItemId && !attention)
    throw new RangeError("Attention item not found");
  const claim = await resolveWorkflowClaim(env, {
    claimId: body.claimId ?? body.claim_id ?? attention?.claim_id,
    sourceClaimNumber: body.sourceClaimNumber ?? body.source_claim_number,
  });
  const originatingReportId =
    body.originatingReportId ?? body.originating_report_id;
  if (originatingReportId)
    await validateWorkflowReport(env, originatingReportId, true);
  const now = new Date().toISOString();
  const record = {
    domain: REPORTING_DOMAIN,
    action: validation.value.action,
    category: validation.value.category,
    claim_id: claim?.id || attention?.claim_id || null,
    attention_item_id: attention?.id || null,
    owner_user_id: owner.ownerUserId,
    owner_display_snapshot: owner.ownerDisplay,
    due_date: workflowDate(validation.value.dueDate),
    status: validation.value.status,
    created_by: currentUser.email,
    updated_by: currentUser.email,
    originating_report_id: originatingReportId || null,
    updated_at: now,
    ...(validation.value.status === "completed"
      ? {
          completed_at: now,
          completed_by: currentUser.email,
          resolution_note: validation.value.resolutionNote || null,
        }
      : {}),
  };
  if (claim?.source_claim_number)
    record.source_claim_number_snapshot = claim.source_claim_number;
  const rows = await supabase(
    env,
    "/scout_management_actions",
    "POST",
    record,
    true,
    "return=representation",
  );
  return rows?.[0] || null;
}

async function updateActionRecord(env, existing, body, currentUser) {
  const activeUsers = await getActiveWorkflowUsers(env);
  const merged = {
    action: body.action ?? existing.action,
    category: body.category ?? existing.category,
    ownerUserId:
      Object.prototype.hasOwnProperty.call(body, "ownerUserId") ||
      Object.prototype.hasOwnProperty.call(body, "owner_user_id")
        ? (body.ownerUserId ?? body.owner_user_id)
        : existing.owner_user_id,
    dueDate: body.dueDate ?? body.due_date ?? existing.due_date,
    status: body.status ?? existing.status,
    resolutionNote:
      body.resolutionNote ?? body.resolution_note ?? existing.resolution_note,
  };
  const validation = validateActionInput(merged, {
    activeOwnerIds: activeUsers.map((user) => user.email),
  });
  if (!validation.ok)
    throw new RangeError(Object.values(validation.errors).join(" "));
  const owner = await resolveWorkflowOwner(env, validation.value.ownerUserId);
  const attentionItemId = body.attentionItemId ?? body.attention_item_id;
  let attention = null;
  if (attentionItemId) {
    attention = await getManagementAttentionById(env, attentionItemId);
    if (!attention) throw new RangeError("Attention item not found");
  }
  let claim = null;
  if (
    Object.prototype.hasOwnProperty.call(body, "claimId") ||
    Object.prototype.hasOwnProperty.call(body, "claim_id") ||
    Object.prototype.hasOwnProperty.call(body, "sourceClaimNumber") ||
    Object.prototype.hasOwnProperty.call(body, "source_claim_number")
  ) {
    claim = await resolveWorkflowClaim(env, {
      claimId: body.claimId ?? body.claim_id,
      sourceClaimNumber: body.sourceClaimNumber ?? body.source_claim_number,
    });
  }
  const now = new Date().toISOString();
  const payload = {
    action: validation.value.action,
    category: validation.value.category,
    owner_user_id: owner.ownerUserId,
    owner_display_snapshot: owner.ownerDisplay,
    due_date: workflowDate(validation.value.dueDate),
    status: validation.value.status,
    updated_at: now,
    updated_by: currentUser.email,
  };
  if (attentionItemId) {
    payload.attention_item_id = attention.id;
    payload.claim_id = attention.claim_id || null;
  }
  if (
    claim ||
    Object.prototype.hasOwnProperty.call(body, "claimId") ||
    Object.prototype.hasOwnProperty.call(body, "claim_id") ||
    Object.prototype.hasOwnProperty.call(body, "sourceClaimNumber") ||
    Object.prototype.hasOwnProperty.call(body, "source_claim_number")
  ) {
    payload.claim_id = claim?.id || null;
    payload.source_claim_number_snapshot = claim?.source_claim_number || null;
  }
  if (validation.value.status === "completed") {
    payload.completed_at =
      existing.status === "completed" ? existing.completed_at || now : now;
    payload.completed_by =
      existing.status === "completed"
        ? existing.completed_by || currentUser.email
        : currentUser.email;
    payload.resolution_note = validation.value.resolutionNote || null;
  } else {
    payload.completed_at = null;
    payload.completed_by = null;
    payload.resolution_note = null;
  }
  const rows = await supabase(
    env,
    "/scout_management_actions?id=eq." + encodeURIComponent(existing.id),
    "PATCH",
    payload,
    true,
    "return=representation",
  );
  return rows?.[0] || (await getManagementActionById(env, existing.id));
}

async function addReportWorkflowMembership(env, runId, itemId, type) {
  const run = await validateWorkflowReport(env, runId, true);
  const isAttention = type === "attention";
  const table = isAttention
    ? "scout_report_attention_items"
    : "scout_report_action_items";
  const live = isAttention
    ? await getManagementAttentionById(env, itemId)
    : await getManagementActionById(env, itemId);
  if (!live)
    throw new RangeError(
      `${isAttention ? "Attention item" : "Action"} not found`,
    );
  const existing = await supabase(
    env,
    `/${table}?report_run_id=eq.${encodeURIComponent(runId)}&${isAttention ? "attention_item_id" : "action_id"}=eq.${encodeURIComponent(itemId)}&select=id&limit=1`,
    "GET",
    null,
    true,
  );
  if (existing?.[0]) return { run, membership: existing[0], idempotent: true };
  const orderRows = await supabase(
    env,
    `/${table}?report_run_id=eq.${encodeURIComponent(runId)}&select=display_order&order=display_order.desc&limit=1`,
    "GET",
    null,
    true,
  );
  const displayOrder = Number(orderRows?.[0]?.display_order || 0) + 1;
  const row = await supabase(
    env,
    `/${table}`,
    "POST",
    await workflowSnapshotForReport(env, live, type, run, { displayOrder }),
    true,
    "return=representation",
  );
  return { run, membership: row?.[0] || null, idempotent: false };
}

function reportScopeFromRequest(value) {
  const scope = value && typeof value === "object" ? value : {};
  if (scope.kind && scope.kind !== "team")
    throw new RangeError("Phase 3 supports only team Claims reports");
  return {
    kind: "team",
    ...(scope.portfolio_scope
      ? { portfolio_scope: String(scope.portfolio_scope) }
      : {}),
  };
}

function uuidValue(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

function persistedMetricSnapshot(report) {
  const { claim_rows: _claimRows, ...snapshot } = report;
  return snapshot;
}

function reportRunRecord(report, currentUser, scope, existing = null) {
  const now = new Date().toISOString();
  const regenerationCount = existing
    ? Number(existing.regeneration_count || 0) + 1
    : 0;
  return {
    domain: REPORTING_DOMAIN,
    report_type: report.report_type,
    period_start: report.period_start,
    period_end: report.period_end,
    time_zone: report.timezone,
    status: "draft",
    scope_key: reportScopeKey(scope),
    scope,
    coverage_status: report.coverage_status,
    coverage_metadata: {
      ...report.coverage,
      activity: report.activity,
      claim_population_row_count: report.claim_rows.length,
    },
    metric_definition_version: REPORTING_METRIC_VERSION,
    claims_rule_version: report.claims_rule_version,
    quality_rule_version: REPORTING_QUALITY_VERSION,
    report_schema_version: REPORT_SCHEMA_VERSION,
    quality_configuration: report.quality_configuration,
    metrics_snapshot: persistedMetricSnapshot(report),
    opening_extract_id: report.opening_extract_id,
    closing_extract_id: report.closing_extract_id,
    generated_at: now,
    generated_by: currentUser.email,
    generated_by_user_id: currentUser.id || null,
    regeneration_count: regenerationCount,
    last_regenerated_at: existing ? now : null,
    last_regenerated_by: existing ? currentUser.email : null,
    updated_at: now,
  };
}

async function loadReportEvidence(env, { reportType, periodStart, scope }) {
  const period = reportingPeriod(reportType, periodStart);
  const previous = previousReportingPeriod(reportType, periodStart);
  const manifests = await getAcceptedReportManifests(env);
  const currentOpening = selectBoundaryExtract(manifests, period.start, {
    scope,
  });
  const currentClosing = selectBoundaryExtract(manifests, period.end, {
    scope,
  });
  const previousOpening = selectBoundaryExtract(manifests, previous.start, {
    scope,
  });
  const previousClosing = selectBoundaryExtract(manifests, previous.end, {
    scope,
  });
  const selectedIds = new Set(
    [
      currentOpening.manifest,
      currentClosing.manifest,
      previousOpening.manifest,
      previousClosing.manifest,
    ]
      .filter(Boolean)
      .map((manifest) => manifest.id),
  );
  for (const manifest of manifests) {
    const instant = extractObservationInstant(manifest);
    if (
      instant &&
      instant >= previous.start &&
      instant <= period.end &&
      manifest.source_metadata?.portfolio_scope ===
        (scope.portfolio_scope ?? manifest.source_metadata?.portfolio_scope)
    ) {
      selectedIds.add(manifest.id);
    }
  }
  const entries = await Promise.all(
    [...selectedIds].map(async (extractId) => [
      extractId,
      await getHistorySnapshots(env, extractId),
    ]),
  );
  const snapshotsByExtract = new Map(entries);
  const changes = await getHistoryChangesForRange(
    env,
    previous.start,
    period.end,
  );
  const activeUsers = await getActiveHistoryUsers(env);
  const configurationWarnings = activeUsers.unavailable
    ? ["user_lookup_unavailable"]
    : [];
  const shared = {
    manifests,
    snapshotsByExtract,
    changes,
    activeUsers: activeUsers.users,
    scope,
    configurationWarnings,
  };
  const previousReport = buildReportSnapshot({
    reportType,
    periodStart: previous.startLocalDate,
    ...shared,
  });
  const report = buildReportSnapshot({
    reportType,
    periodStart,
    previousSnapshot: previousReport,
    ...shared,
  });
  return { report, previousReport, manifests, snapshotsByExtract };
}

async function persistReportDraft(env, report, currentUser, scope, existing) {
  const record = reportRunRecord(report, currentUser, scope, existing);
  let run;
  if (existing) {
    await supabase(
      env,
      "/scout_report_runs?id=eq." + encodeURIComponent(existing.id),
      "PATCH",
      record,
      true,
      "return=representation",
    );
    run = await getReportRunById(env, existing.id);
    await supabase(
      env,
      "/scout_report_run_claims?report_run_id=eq." +
        encodeURIComponent(existing.id),
      "DELETE",
      null,
      true,
    );
  } else {
    const rows = await supabase(
      env,
      "/scout_report_runs",
      "POST",
      record,
      true,
      "return=representation",
    );
    run = rows?.[0] || null;
  }
  if (!run) throw new Error("Report run could not be persisted");

  const claimRows = report.claim_rows
    .map((claim) => ({
      ...claim,
      claim_id: uuidValue(claim.claim_id),
      report_run_id: run.id,
    }))
    .filter((claim) => claim.claim_id);
  for (let index = 0; index < claimRows.length; index += 200) {
    await supabase(
      env,
      "/scout_report_run_claims",
      "POST",
      claimRows.slice(index, index + 200),
      true,
      "return=minimal",
    );
  }
  return { run, claimPopulationCount: claimRows.length };
}

function publicReportRun(run) {
  if (!run) return null;
  const {
    scope_key: _scopeKey,
    generated_by_user_id: _generatedByUserId,
    finalised_by_user_id: _finalisedByUserId,
    archived_by_user_id: _archivedByUserId,
    ...safe
  } = run;
  return safe;
}

function publicHistoryManifest(manifest) {
  if (!manifest) return null;
  const { source_metadata: _sourceMetadata, ...safe } = manifest;
  return safe;
}

// ── Audit logger ─────────────────────────────────────────────
async function audit(env, userEmail, userName, action, detail = {}) {
  try {
    await supabase(
      env,
      "/scout_audit",
      "POST",
      {
        user_email: userEmail,
        user_name: userName,
        action,
        detail,
      },
      true,
    );
  } catch (e) {
    /* non-blocking */
  }
}

// ── POPIA masking ────────────────────────────────────────────
function maskName(fullName) {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0] + "****";
  const first = parts[0];
  const rest = parts.slice(1).map((p) => p[0] + "****");
  return first + " " + rest.join(" ");
}

function maskClaim(claim, role) {
  if (role === "handler") {
    return {
      ...claim,
      insured_name: claim.insured_masked || maskName(claim.insured_name),
    };
  }
  return claim;
}

// ── Microsoft token verification ─────────────────────────────
async function verifyMsToken(token, env) {
  // Verify via Microsoft Graph — get user info from the token
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error("Invalid Microsoft token");
  const user = await res.json();
  return {
    email: (user.mail || user.userPrincipalName || "").toLowerCase(),
    name: user.displayName || "",
    id: user.id,
  };
}

// ── Get user role from DB ─────────────────────────────────────
async function getUserRole(env, email) {
  const rows = await supabase(
    env,
    "/scout_users?email=eq." +
      encodeURIComponent(email) +
      "&select=role,display_name,active,portal",
    "GET",
    null,
    true,
  );
  if (!rows || rows.length === 0) return null;
  if (!rows[0].active) return null;
  return rows[0];
}

// ── ROUTER ───────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // ── /auth/me — verify MS token, return user+role ──────────
    if (path === "/auth/me" && request.method === "POST") {
      try {
        const { token } = await request.json();
        if (!token) return err("No token provided");

        const msUser = await verifyMsToken(token, env);
        const dbUser = await getUserRole(env, msUser.email);

        if (!dbUser) {
          return err(
            "Access denied — your account is not registered in Scout. Contact your administrator.",
            403,
          );
        }

        await audit(
          env,
          msUser.email,
          msUser.name || dbUser.display_name,
          "login",
          { email: msUser.email },
        );

        return json({
          email: msUser.email,
          name: dbUser.display_name || msUser.name,
          role: dbUser.role,
          portal: dbUser.portal || "claims",
        });
      } catch (e) {
        return err("Authentication failed: " + e.message, 401);
      }
    }

    // ── All routes below require authenticated user ────────────
    const authHeader = request.headers.get("Authorization") || "";
    const msToken = authHeader.replace("Bearer ", "").trim();
    if (!msToken) return err("Unauthorised", 401);

    let currentUser;
    try {
      const msUser = await verifyMsToken(msToken, env);
      const dbUser = await getUserRole(env, msUser.email);
      if (!dbUser) return err("Access denied", 403);
      currentUser = { ...msUser, ...dbUser };
    } catch (e) {
      return err("Unauthorised: " + e.message, 401);
    }

    // ── /claims — get latest extract ─────────────────────────
    if (path === "/claims" && request.method === "GET") {
      try {
        // Get latest extract date
        const extracts = await supabase(
          env,
          "/scout_extracts?select=extract_date&order=extract_date.desc&limit=1",
          "GET",
          null,
          true,
        );
        if (!extracts || extracts.length === 0)
          return json({ claims: [], extractDate: null });

        const latestDate = extracts[0].extract_date;

        // Get claims for that date — handlers only get their own
        let filter =
          "/scout_claims?extract_date=eq." +
          latestDate +
          "&order=priority_score.desc";
        if (currentUser.role === "handler") {
          filter +=
            "&handler_email=eq." + encodeURIComponent(currentUser.email);
        }

        const claims = await supabase(env, filter, "GET", null, true);
        const masked = (claims || []).map((c) =>
          maskClaim(c, currentUser.role),
        );

        await audit(env, currentUser.email, currentUser.name, "view_claims", {
          extract_date: latestDate,
          count: masked.length,
          role: currentUser.role,
        });

        return json({
          claims: masked,
          extractDate: latestDate,
          userRole: currentUser.role,
        });
      } catch (e) {
        return err("Failed to load claims: " + e.message, 500);
      }
    }

    // ── /notes/:claimNo — per-claim notes (GET/PUT) ──────────
    // Requires a Supabase table:
    //   create table scout_notes (
    //     claim_no text primary key,
    //     note text default '',
    //     saved_by text,
    //     saved_at timestamptz
    //   );
    const notesMatch = path.match(/^\/notes\/(.+)$/);
    if (notesMatch) {
      const claimNo = decodeURIComponent(notesMatch[1]);

      if (request.method === "GET") {
        try {
          const rows = await supabase(
            env,
            "/scout_notes?claim_no=eq." +
              encodeURIComponent(claimNo) +
              "&select=note,saved_by,saved_at&limit=1",
            "GET",
            null,
            true,
          );
          const row = rows && rows[0];
          return json({
            note: row?.note || "",
            savedBy: row?.saved_by || null,
            savedAt: row?.saved_at || null,
          });
        } catch (e) {
          return err("Failed to load note: " + e.message, 500);
        }
      }

      if (request.method === "PUT") {
        try {
          const { note } = await request.json();
          const record = {
            claim_no: claimNo,
            note: String(note || "").trim(),
            saved_by: currentUser.name || currentUser.email,
            saved_at: new Date().toISOString(),
          };
          await supabase(
            env,
            "/scout_notes?on_conflict=claim_no",
            "POST",
            record,
            true,
            "resolution=merge-duplicates,return=representation",
          );
          await audit(env, currentUser.email, currentUser.name, "save_note", {
            claim_no: claimNo,
          });
          return json({
            ok: true,
            savedBy: record.saved_by,
            savedAt: record.saved_at,
          });
        } catch (e) {
          return err("Failed to save note: " + e.message, 500);
        }
      }

      return err("Method not allowed", 405);
    }

    // ── /upload — save Cardinal extract ──────────────────────
    if (path === "/upload" && request.method === "POST") {
      if (!["admin", "manager"].includes(currentUser.role)) {
        return err("Only managers and admins can upload extracts", 403);
      }

      let history = null;
      try {
        const {
          claims,
          fileName,
          extractDate,
          effectiveAt,
          sourceChecksum,
          sourceMetadata,
          correctionOfExtractId,
        } = await request.json();
        if (!claims || !claims.length) return err("No claims data provided");

        let historical;
        try {
          historical = await preserveHistoricalExtract(env, {
            claims,
            fileName,
            extractDate: extractDate || null,
            effectiveAt: effectiveAt || null,
            sourceChecksum: sourceChecksum || null,
            sourceMetadata: sourceMetadata || {},
            correctionOfExtractId: correctionOfExtractId || null,
            currentUser,
          });
        } catch (error) {
          await audit(
            env,
            currentUser.email,
            currentUser.name,
            "history_generation_failure",
            {
              file_name: fileName || "cardinal-extract.xlsx",
              error: String(error?.message || error).slice(0, 300),
            },
          );
          return err(
            "Historical persistence failed; current claims were not changed. Retry the upload.",
            503,
          );
        }

        if (historical.kind === "rejected") {
          await audit(
            env,
            currentUser.email,
            currentUser.name,
            "extract_rejected",
            {
              extract_id: historical.manifest?.id || null,
              file_name: fileName || "cardinal-extract.xlsx",
              quality: historical.quality,
            },
          );
          return err("Extract rejected by the historical quality gate", 422);
        }

        if (historical.kind === "duplicate") {
          await audit(
            env,
            currentUser.email,
            currentUser.name,
            "duplicate_extract_ignored",
            {
              extract_id: historical.manifest.id,
              source_file_name: historical.manifest.source_file_name,
              source_checksum: historical.manifest.source_checksum,
            },
          );
          return json({
            success: true,
            duplicate: true,
            historicalStatus: historical.manifest.status,
            extractId: historical.manifest.id,
            claimsStored: historical.manifest.accepted_claim_count,
            extractDate: historical.manifest.effective_date || null,
            unresolvedHandlers: [],
          });
        }

        history = historical;
        const date = extractDate || new Date().toISOString().split("T")[0];

        // Delete existing claims for this date (re-upload)
        await supabase(
          env,
          "/scout_claims?extract_date=eq." + date,
          "DELETE",
          null,
          true,
        );

        // Handler names that couldn't be resolved to an email — these claims
        // will be invisible to that handler's portal login and daily report.
        const unresolvedHandlers = new Set();

        // Insert new claims in batches of 200
        const batchSize = 200;
        for (let i = 0; i < claims.length; i += batchSize) {
          const batch = claims.slice(i, i + batchSize).map((c) => {
            const handlerEmail = resolveEmail(c.handler);
            if (c.handler && !handlerEmail) unresolvedHandlers.add(c.handler);
            return {
              extract_date: date,
              claim_no: c.claimNo || "",
              handler_email: handlerEmail,
              handler_name: c.handler || "",
              insured_name: c.insured || "",
              insured_masked: maskName(c.insured || ""),
              status: c.status || "",
              age_days: c.age || 0,
              peril: c.peril || "",
              peril_type: c.perilType || "",
              insurer: c.insurer || "",
              outstanding: c.outstanding || 0,
              description: c.description || "",
              comments: c.comments || "",
              priority_score: c.priority?.score || 0,
              priority_flags: c.priority?.flags || [],
              recommended_action: c.priority?.action || "",
            };
          });
          await supabase(env, "/scout_claims", "POST", batch, true);
        }

        // Record extract metadata
        await supabase(
          env,
          "/scout_extracts",
          "POST",
          {
            extract_date: date,
            uploaded_by: currentUser.email,
            claim_count: claims.length,
            file_name: fileName || "cardinal-extract.xlsx",
          },
          true,
        );

        const finalHistoricalStatus =
          historical.quality?.quality_state === "warning"
            ? "accepted_with_warnings"
            : "accepted";
        await updateHistoryManifest(env, historical.manifest.id, {
          status: finalHistoricalStatus,
          historical_persisted: true,
          current_state_updated: true,
        });

        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "extract_accepted",
          {
            extract_id: historical.manifest.id,
            source_file_name: fileName || "cardinal-extract.xlsx",
            source_checksum: historical.manifest.source_checksum,
            quality_state: historical.quality?.quality_state || "ok",
            snapshot_count: historical.manifest.accepted_claim_count,
          },
        );

        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "upload_extract",
          {
            extract_date: date,
            claim_count: claims.length,
            file_name: fileName,
            unresolved_handlers: [...unresolvedHandlers],
          },
        );

        return json({
          success: true,
          historicalStatus: finalHistoricalStatus,
          extractId: historical.manifest.id,
          sourceChecksum: historical.manifest.source_checksum,
          qualitySummary: historical.quality,
          claimsStored: claims.length,
          extractDate: date,
          unresolvedHandlers: [...unresolvedHandlers],
        });
      } catch (e) {
        if (history?.manifest?.id) {
          try {
            await updateHistoryManifest(env, history.manifest.id, {
              status: "partial_failure",
              current_state_updated: false,
              quality_summary: {
                ...(history.quality || {}),
                partial_system_failure: String(e?.message || e).slice(0, 300),
              },
            });
          } catch {
            /* retain the original upload error */
          }
          await audit(
            env,
            currentUser.email,
            currentUser.name,
            "partial_system_failure",
            {
              extract_id: history.manifest.id,
              error: String(e?.message || e).slice(0, 300),
            },
          );
          return err(
            "Upload partially failed after historical preservation. Retry the same source.",
            503,
          );
        }
        return err("Upload failed: " + e.message, 500);
      }
    }

    // ── Historical integrity verification (manager/admin only) ──
    if (path === "/history/latest" && request.method === "GET") {
      if (!["manager", "admin"].includes(currentUser.role))
        return err("Not authorised", 403);
      try {
        const manifest = await getLatestHistoryManifest(
          env,
          DEFAULT_SOURCE_SYSTEM,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_history_latest",
          {},
        );
        return json({ extract: publicHistoryManifest(manifest) });
      } catch (e) {
        return err(
          "Failed to load latest historical extract: " + e.message,
          500,
        );
      }
    }

    if (path === "/history/extracts" && request.method === "GET") {
      if (!["manager", "admin"].includes(currentUser.role))
        return err("Not authorised", 403);
      try {
        const manifests = await supabaseAll(
          env,
          "/scout_history_extracts?source_system=eq." +
            encodeURIComponent(DEFAULT_SOURCE_SYSTEM) +
            "&select=id,source_system,source_file_name,source_checksum,effective_at,effective_date,effective_precision,received_at,uploaded_by_email,time_zone,schema_version,claim_count,accepted_claim_count,rejected_claim_count,quality_summary,previous_extract_id,correction_of_extract_id,status,historical_persisted,current_state_updated,created_at&order=received_at.desc",
          true,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_history_extracts",
          { count: manifests.length },
        );
        return json({ extracts: manifests.map(publicHistoryManifest) });
      } catch (e) {
        return err("Failed to load historical extracts: " + e.message, 500);
      }
    }

    const historyExtractMatch = path.match(/^\/history\/extracts\/([^/]+)$/);
    if (historyExtractMatch && request.method === "GET") {
      if (!["manager", "admin"].includes(currentUser.role))
        return err("Not authorised", 403);
      try {
        const manifest = await getHistoryManifestById(
          env,
          decodeURIComponent(historyExtractMatch[1]),
        );
        if (!manifest) return err("Historical extract not found", 404);
        const snapshots = await getHistorySnapshots(env, manifest.id);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_history_extract",
          { extract_id: manifest.id },
        );
        return json({
          extract: publicHistoryManifest(manifest),
          snapshotCount: snapshots.length,
        });
      } catch (e) {
        return err("Failed to load historical extract: " + e.message, 500);
      }
    }

    const historyClaimMatch = path.match(/^\/history\/claims\/([^/]+)$/);
    if (historyClaimMatch && request.method === "GET") {
      if (!["manager", "admin"].includes(currentUser.role))
        return err("Not authorised", 403);
      try {
        const claimId = decodeURIComponent(historyClaimMatch[1]);
        const snapshots = await supabaseAll(
          env,
          "/scout_history_snapshots?claim_id=eq." +
            encodeURIComponent(claimId) +
            "&select=*&order=extract_id.asc",
          true,
        );
        const changes = await supabaseAll(
          env,
          "/scout_history_changes?claim_id=eq." +
            encodeURIComponent(claimId) +
            "&select=*&order=observed_at.asc",
          true,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_history_claim",
          { claim_id: claimId },
        );
        return json({
          snapshots: snapshots.map(safeHistorySnapshot),
          changes,
          precision: "snapshot_and_observed_between_extracts",
        });
      } catch (e) {
        return err("Failed to load claim history: " + e.message, 500);
      }
    }

    // ── Phase 5 management workflow (manager/admin only) ─────
    if (path === "/management-workflow/users" && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view_workflow"))
        return err("Not authorised", 403);
      try {
        const users = await getActiveWorkflowUsers(env);
        return json({
          users: users.map((user) => ({
            id: user.email,
            email: user.email,
            displayName: user.display_name || user.email,
            role: user.role,
          })),
        });
      } catch (e) {
        return err("Failed to load workflow owners: " + e.message, 500);
      }
    }

    if (path === "/management-attention" && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view_workflow"))
        return err("Not authorised", 403);
      try {
        const params = url.searchParams;
        const filters = ["select=*&order=updated_at.desc"];
        const status = params.get("status");
        const claimId = uuidValue(params.get("claimId"));
        const claimNumber = String(params.get("claimNumber") || "").trim();
        if (status && ATTENTION_STATUSES.includes(status))
          filters.push("status=eq." + encodeURIComponent(status));
        if (claimId) filters.push("claim_id=eq." + encodeURIComponent(claimId));
        if (claimNumber)
          filters.push(
            "source_claim_number_snapshot=eq." +
              encodeURIComponent(claimNumber),
          );
        const rows = await supabaseAll(
          env,
          "/scout_management_attention?" + filters.join("&"),
          true,
        );
        return json({ items: rows.map(workflowAttentionPublic) });
      } catch (e) {
        return err("Failed to load management attention: " + e.message, 500);
      }
    }

    if (path === "/management-attention" && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const body = await request.json();
        const item = await createAttentionRecord(env, body, currentUser);
        if (!item) return err("Attention item could not be created", 500);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_attention_created",
          { attention_item_id: item.id, claim_id: item.claim_id || null },
        );
        return json({ item: workflowAttentionPublic(item) }, 201);
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        if (isWorkflowSchemaError(e))
          return err("Phase 5 workflow migration is not available", 503);
        return err("Failed to create management attention: " + e.message, 500);
      }
    }

    const attentionResolveMatch = path.match(
      /^\/management-attention\/([^/]+)\/resolve$/,
    );
    if (attentionResolveMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const id = decodeURIComponent(attentionResolveMatch[1]);
        const existing = await getManagementAttentionById(env, id);
        if (!existing) return err("Attention item not found", 404);
        const body = await request.json().catch(() => ({}));
        const item = await updateAttentionRecord(
          env,
          existing,
          {
            status: "resolved",
            resolutionNote:
              body.resolutionNote ||
              body.resolution_note ||
              existing.resolution_note ||
              "Resolved",
          },
          currentUser,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_attention_resolved",
          { attention_item_id: id },
        );
        return json({ item: workflowAttentionPublic(item) });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to resolve management attention: " + e.message, 500);
      }
    }

    const attentionByIdMatch = path.match(/^\/management-attention\/([^/]+)$/);
    if (attentionByIdMatch && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view_workflow"))
        return err("Not authorised", 403);
      try {
        const item = await getManagementAttentionById(
          env,
          decodeURIComponent(attentionByIdMatch[1]),
        );
        if (!item) return err("Attention item not found", 404);
        return json({ item: workflowAttentionPublic(item) });
      } catch (e) {
        return err("Failed to load management attention: " + e.message, 500);
      }
    }

    if (
      attentionByIdMatch &&
      attentionByIdMatch[1] &&
      request.method === "PATCH"
    ) {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const id = decodeURIComponent(attentionByIdMatch[1]);
        const existing = await getManagementAttentionById(env, id);
        if (!existing) return err("Attention item not found", 404);
        const item = await updateAttentionRecord(
          env,
          existing,
          await request.json(),
          currentUser,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_attention_updated",
          { attention_item_id: id, status: item.status },
        );
        return json({ item: workflowAttentionPublic(item) });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to update management attention: " + e.message, 500);
      }
    }

    if (path === "/management-actions" && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view_workflow"))
        return err("Not authorised", 403);
      try {
        const params = url.searchParams;
        const filters = ["select=*&order=updated_at.desc"];
        const status = params.get("status");
        const claimId = uuidValue(params.get("claimId"));
        if (status && ACTION_STATUSES.includes(status))
          filters.push("status=eq." + encodeURIComponent(status));
        if (claimId) filters.push("claim_id=eq." + encodeURIComponent(claimId));
        const rows = await supabaseAll(
          env,
          "/scout_management_actions?" + filters.join("&"),
          true,
        );
        return json({ items: rows.map(workflowActionPublic) });
      } catch (e) {
        return err("Failed to load management actions: " + e.message, 500);
      }
    }

    if (path === "/management-actions" && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const item = await createActionRecord(
          env,
          await request.json(),
          currentUser,
        );
        if (!item) return err("Action could not be created", 500);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_action_created",
          { action_id: item.id, claim_id: item.claim_id || null },
        );
        return json({ item: workflowActionPublic(item) }, 201);
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        if (isWorkflowSchemaError(e))
          return err("Phase 5 workflow migration is not available", 503);
        return err("Failed to create management action: " + e.message, 500);
      }
    }

    const actionCompleteMatch = path.match(
      /^\/management-actions\/([^/]+)\/complete$/,
    );
    if (actionCompleteMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const id = decodeURIComponent(actionCompleteMatch[1]);
        const existing = await getManagementActionById(env, id);
        if (!existing) return err("Action not found", 404);
        const body = await request.json().catch(() => ({}));
        const item = await updateActionRecord(
          env,
          existing,
          {
            status: "completed",
            resolutionNote:
              body.resolutionNote ||
              body.resolution_note ||
              existing.resolution_note ||
              "Completed",
          },
          currentUser,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_action_completed",
          { action_id: id },
        );
        return json({ item: workflowActionPublic(item) });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to complete management action: " + e.message, 500);
      }
    }

    const actionByIdMatch = path.match(/^\/management-actions\/([^/]+)$/);
    if (actionByIdMatch && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view_workflow"))
        return err("Not authorised", 403);
      try {
        const item = await getManagementActionById(
          env,
          decodeURIComponent(actionByIdMatch[1]),
        );
        if (!item) return err("Action not found", 404);
        return json({ item: workflowActionPublic(item) });
      } catch (e) {
        return err("Failed to load management action: " + e.message, 500);
      }
    }

    if (actionByIdMatch && actionByIdMatch[1] && request.method === "PATCH") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const id = decodeURIComponent(actionByIdMatch[1]);
        const existing = await getManagementActionById(env, id);
        if (!existing) return err("Action not found", 404);
        const item = await updateActionRecord(
          env,
          existing,
          await request.json(),
          currentUser,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_action_updated",
          { action_id: id, status: item.status },
        );
        return json({ item: workflowActionPublic(item) });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to update management action: " + e.message, 500);
      }
    }

    const reportAttentionAddMatch = path.match(
      /^\/reports\/([^/]+)\/attention$/,
    );
    if (reportAttentionAddMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportAttentionAddMatch[1]);
        const body = await request.json();
        const itemId = body.attentionId ?? body.attention_item_id;
        if (!itemId) return err("attentionId is required", 422);
        const result = await addReportWorkflowMembership(
          env,
          reportId,
          itemId,
          "attention",
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_attention_added_to_report",
          {
            report_id: reportId,
            attention_item_id: itemId,
            idempotent: result.idempotent,
          },
        );
        return json({
          membership: result.membership,
          idempotent: result.idempotent,
        });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to add attention to report: " + e.message, 500);
      }
    }

    const reportAttentionRemoveMatch = path.match(
      /^\/reports\/([^/]+)\/attention\/([^/]+)$/,
    );
    if (reportAttentionRemoveMatch && request.method === "DELETE") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportAttentionRemoveMatch[1]);
        const itemId = decodeURIComponent(reportAttentionRemoveMatch[2]);
        await validateWorkflowReport(env, reportId, true);
        await supabase(
          env,
          `/scout_report_attention_items?report_run_id=eq.${encodeURIComponent(reportId)}&attention_item_id=eq.${encodeURIComponent(itemId)}`,
          "DELETE",
          null,
          true,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_attention_removed_from_report",
          { report_id: reportId, attention_item_id: itemId },
        );
        return json({ removed: true });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to remove attention from report: " + e.message, 500);
      }
    }

    const reportActionAddMatch = path.match(/^\/reports\/([^/]+)\/actions$/);
    if (reportActionAddMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportActionAddMatch[1]);
        const body = await request.json();
        const itemId = body.actionId ?? body.action_id;
        if (!itemId) return err("actionId is required", 422);
        const result = await addReportWorkflowMembership(
          env,
          reportId,
          itemId,
          "action",
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_action_added_to_report",
          {
            report_id: reportId,
            action_id: itemId,
            idempotent: result.idempotent,
          },
        );
        return json({
          membership: result.membership,
          idempotent: result.idempotent,
        });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to add action to report: " + e.message, 500);
      }
    }

    const reportActionRemoveMatch = path.match(
      /^\/reports\/([^/]+)\/actions\/([^/]+)$/,
    );
    if (reportActionRemoveMatch && request.method === "DELETE") {
      if (!reportActionAllowed(currentUser.role, "manage_workflow"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportActionRemoveMatch[1]);
        const itemId = decodeURIComponent(reportActionRemoveMatch[2]);
        await validateWorkflowReport(env, reportId, true);
        await supabase(
          env,
          `/scout_report_action_items?report_run_id=eq.${encodeURIComponent(reportId)}&action_id=eq.${encodeURIComponent(itemId)}`,
          "DELETE",
          null,
          true,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "management_action_removed_from_report",
          { report_id: reportId, action_id: itemId },
        );
        return json({ removed: true });
      } catch (e) {
        if (e instanceof RangeError) return err(e.message, 422);
        return err("Failed to remove action from report: " + e.message, 500);
      }
    }

    // ── Deterministic Claims reports (manager/admin only) ─────
    if (path === "/reports" && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view"))
        return err("Not authorised", 403);
      try {
        const rows = await supabaseAll(
          env,
          "/scout_report_runs?domain=eq." +
            encodeURIComponent(REPORTING_DOMAIN) +
            "&select=id,domain,report_type,period_start,period_end,time_zone,status,scope,coverage_status,coverage_metadata,metric_definition_version,claims_rule_version,quality_rule_version,report_schema_version,opening_extract_id,closing_extract_id,generated_at,generated_by,regeneration_count,created_at,updated_at,finalised_at,finalised_by,archived_at,archived_by&order=period_start.desc",
          true,
        );
        await audit(env, currentUser.email, currentUser.name, "list_reports", {
          count: rows.length,
        });
        return json({ reports: rows.map(publicReportRun) });
      } catch (e) {
        return err("Failed to load reports: " + e.message, 500);
      }
    }

    if (path === "/reports/generate" && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "generate"))
        return err("Not authorised", 403);
      try {
        const body = await request.json();
        const reportType = String(body.reportType || "").toLowerCase();
        if (!["weekly", "monthly"].includes(reportType))
          return err("reportType must be weekly or monthly", 422);
        if (!body.periodStart) return err("periodStart is required", 422);
        const scope = reportScopeFromRequest(body.scope);
        const period = reportingPeriod(reportType, body.periodStart);
        const scopeKey = reportScopeKey(scope);
        const existing = await getReportRunByKey(env, {
          reportType,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          scopeKey,
        });
        if (existing?.status === "finalised")
          return err(
            "Finalised report is immutable; use the existing snapshot",
            409,
          );
        if (existing?.status === "archived")
          return err("Archived report cannot be regenerated", 409);
        const { report } = await loadReportEvidence(env, {
          reportType,
          periodStart: body.periodStart,
          scope,
        });
        const persisted = await persistReportDraft(
          env,
          report,
          currentUser,
          scope,
          existing,
        );
        const carryForward = existing
          ? { attentionCount: 0, actionCount: 0, sourceReportId: null }
          : await ensureCarryForwardForNewDraft(
              env,
              persisted.run,
              currentUser,
            );
        const reportRun = await getReportRunById(env, persisted.run.id);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "generate_report",
          {
            report_id: persisted.run.id,
            report_type: reportType,
            period_start: report.period_start,
            coverage_status: report.coverage_status,
            regenerated: Boolean(existing),
            carry_forward_source_report_id: carryForward.sourceReportId,
            carry_forward_attention_count: carryForward.attentionCount,
            carry_forward_action_count: carryForward.actionCount,
          },
        );
        return json({
          report: await publicReportWithWorkflow(env, reportRun),
          claimPopulationCount: persisted.claimPopulationCount,
          carryForward,
          deterministic: true,
        });
      } catch (e) {
        if (e instanceof RangeError)
          return err("Invalid report request: " + e.message, 422);
        return err("Failed to generate report: " + e.message, 500);
      }
    }

    const reportMetricClaimsMatch = path.match(
      /^\/reports\/([^/]+)\/metrics\/([^/]+)\/claims$/,
    );
    if (reportMetricClaimsMatch && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "drill_through"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportMetricClaimsMatch[1]);
        const metricId = decodeURIComponent(reportMetricClaimsMatch[2]);
        const run = await getReportRunById(env, reportId);
        if (!run) return err("Report not found", 404);
        const rows = await getReportRunClaims(env, reportId);
        const claims = rows.filter(
          (row) =>
            Array.isArray(row.metric_ids) && row.metric_ids.includes(metricId),
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_report_metric_claims",
          { report_id: reportId, metric_id: metricId, count: claims.length },
        );
        return json({
          report: {
            id: run.id,
            status: run.status,
            reportType: run.report_type,
            periodStart: run.period_start,
            periodEnd: run.period_end,
          },
          metricId,
          claims,
          authorization: "current_manager_or_admin_scope",
        });
      } catch (e) {
        return err("Failed to load report claim population: " + e.message, 500);
      }
    }

    const reportRegenerateMatch = path.match(
      /^\/reports\/([^/]+)\/regenerate$/,
    );
    if (reportRegenerateMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "regenerate"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportRegenerateMatch[1]);
        const existing = await getReportRunById(env, reportId);
        if (!existing) return err("Report not found", 404);
        if (!canRegenerateReport(existing.status))
          return err("Only draft reports may be regenerated", 409);
        const scope = reportScopeFromRequest(existing.scope);
        const { report } = await loadReportEvidence(env, {
          reportType: existing.report_type,
          periodStart: existing.period_start,
          scope,
        });
        const persisted = await persistReportDraft(
          env,
          report,
          currentUser,
          scope,
          existing,
        );
        const reportRun = await getReportRunById(env, persisted.run.id);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "regenerate_report",
          {
            report_id: reportId,
            regeneration_count: persisted.run.regeneration_count,
          },
        );
        return json({
          report: await publicReportWithWorkflow(env, reportRun),
          claimPopulationCount: persisted.claimPopulationCount,
          carryForward: {
            attentionCount: 0,
            actionCount: 0,
            sourceReportId: null,
          },
          deterministic: true,
        });
      } catch (e) {
        return err("Failed to regenerate report: " + e.message, 500);
      }
    }

    const reportFinaliseMatch = path.match(/^\/reports\/([^/]+)\/finalise$/);
    if (reportFinaliseMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "finalise"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportFinaliseMatch[1]);
        const existing = await getReportRunById(env, reportId);
        if (!existing) return err("Report not found", 404);
        if (!canFinaliseReport(existing.status))
          return err("Archived report cannot be finalised", 409);
        if (existing.status === "finalised")
          return json({
            report: await publicReportWithWorkflow(env, existing),
            idempotent: true,
          });
        const workflowSnapshot = await syncReportWorkflowSnapshots(
          env,
          reportId,
        );
        const now = new Date().toISOString();
        await supabase(
          env,
          "/scout_report_runs?id=eq." + encodeURIComponent(reportId),
          "PATCH",
          {
            status: "finalised",
            finalised_at: now,
            finalised_by: currentUser.email,
            finalised_by_user_id: currentUser.id || null,
            updated_at: now,
          },
          true,
          "return=representation",
        );
        const finalised = await getReportRunById(env, reportId);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "finalise_report",
          {
            report_id: reportId,
            attention_snapshot_count: workflowSnapshot.attentionCount,
            action_snapshot_count: workflowSnapshot.actionCount,
          },
        );
        return json({ report: await publicReportWithWorkflow(env, finalised) });
      } catch (e) {
        return err("Failed to finalise report: " + e.message, 500);
      }
    }

    const reportPdfMatch = path.match(/^\/reports\/([^/]+)\/pdf$/);
    if (reportPdfMatch && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "pdf_export"))
        return err("Not authorised", 403);
      const reportId = decodeURIComponent(reportPdfMatch[1]);
      let run;
      try {
        run = await getReportRunById(env, reportId);
        if (!run) return err("Report not found", 404);
        if (!["finalised", "archived"].includes(run.status))
          return err(
            "Only Finalised reports can be exported as an official PDF",
            409,
          );
        const snapshot = run.metrics_snapshot || {};
        const coverageStatus = snapshot.coverage_status || run.coverage_status;
        if (coverageStatus === "insufficient")
          return err(
            "Reports with insufficient historical coverage cannot be exported",
            409,
          );
        if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
          await audit(
            env,
            currentUser.email,
            currentUser.name,
            "export_report_pdf_failed",
            {
              report_id: reportId,
              reason: "browser_run_binding_unavailable",
              template_version: PDF_TEMPLATE_VERSION,
              renderer_version: PDF_RENDERER_VERSION,
            },
          );
          return err(
            "PDF export is unavailable until the report renderer is configured",
            503,
          );
        }
        const workflow = await loadReportWorkflow(env, run);
        if (!workflow.available)
          return err("Management workflow snapshots are unavailable", 503);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "export_report_pdf_requested",
          {
            report_id: reportId,
            report_type: run.report_type,
            period_start: run.period_start,
            template_version: PDF_TEMPLATE_VERSION,
            renderer_version: PDF_RENDERER_VERSION,
          },
        );
        const html = renderClaimsReportHtml(run, workflow);
        const rendered = await env.BROWSER.quickAction("pdf", {
          html,
          printBackground: true,
        });
        const pdf =
          rendered instanceof Response ? rendered : new Response(rendered);
        if (!pdf.ok)
          throw new Error(`Browser Run PDF renderer returned ${pdf.status}`);
        const headers = new Headers(pdf.headers);
        const exportedAt = new Date().toISOString();
        headers.set("Content-Type", "application/pdf");
        headers.set(
          "Content-Disposition",
          `attachment; filename="${reportPdfFilename(run)}"`,
        );
        headers.set("Cache-Control", "no-store");
        headers.set("X-Scout-Report-Exported-At", exportedAt);
        headers.set("X-Scout-PDF-Template-Version", PDF_TEMPLATE_VERSION);
        headers.set("X-Scout-PDF-Renderer-Version", PDF_RENDERER_VERSION);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "export_report_pdf_generated",
          {
            report_id: reportId,
            report_type: run.report_type,
            period_start: run.period_start,
            exported_at: exportedAt,
            template_version: PDF_TEMPLATE_VERSION,
            renderer_version: PDF_RENDERER_VERSION,
          },
        );
        return new Response(pdf.body, { status: pdf.status, headers });
      } catch (e) {
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "export_report_pdf_failed",
          {
            report_id: reportId,
            reason: "renderer_error",
            template_version: PDF_TEMPLATE_VERSION,
            renderer_version: PDF_RENDERER_VERSION,
          },
        );
        return err("PDF export could not be completed", 503);
      }
    }

    const reportArchiveMatch = path.match(/^\/reports\/([^/]+)\/archive$/);
    if (reportArchiveMatch && request.method === "POST") {
      if (!reportActionAllowed(currentUser.role, "archive"))
        return err("Admin only", 403);
      try {
        const reportId = decodeURIComponent(reportArchiveMatch[1]);
        const existing = await getReportRunById(env, reportId);
        if (!existing) return err("Report not found", 404);
        if (!canArchiveReport(existing.status))
          return err("Only finalised reports may be archived", 409);
        if (existing.status === "archived")
          return json({
            report: await publicReportWithWorkflow(env, existing),
            idempotent: true,
          });
        const now = new Date().toISOString();
        await supabase(
          env,
          "/scout_report_runs?id=eq." + encodeURIComponent(reportId),
          "PATCH",
          {
            status: "archived",
            archived_at: now,
            archived_by: currentUser.email,
            archived_by_user_id: currentUser.id || null,
            updated_at: now,
          },
          true,
          "return=representation",
        );
        const archived = await getReportRunById(env, reportId);
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "archive_report",
          {
            report_id: reportId,
          },
        );
        return json({ report: await publicReportWithWorkflow(env, archived) });
      } catch (e) {
        return err("Failed to archive report: " + e.message, 500);
      }
    }

    const reportByIdMatch = path.match(/^\/reports\/([^/]+)$/);
    if (reportByIdMatch && request.method === "GET") {
      if (!reportActionAllowed(currentUser.role, "view"))
        return err("Not authorised", 403);
      try {
        const reportId = decodeURIComponent(reportByIdMatch[1]);
        const run = await getReportRunById(env, reportId);
        if (!run) return err("Report not found", 404);
        await audit(env, currentUser.email, currentUser.name, "view_report", {
          report_id: reportId,
        });
        return json({ report: await publicReportWithWorkflow(env, run) });
      } catch (e) {
        return err("Failed to load report: " + e.message, 500);
      }
    }

    // ── /audit — get audit log (admin only) ──────────────────
    if (path === "/audit" && request.method === "GET") {
      if (currentUser.role !== "admin") return err("Admin only", 403);
      try {
        const rows = await supabase(
          env,
          "/scout_audit?select=*&order=created_at.desc&limit=500",
          "GET",
          null,
          true,
        );
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "view_audit_log",
          {},
        );
        return json({ log: rows || [] });
      } catch (e) {
        return err("Failed to load audit log: " + e.message, 500);
      }
    }

    // ── /users — get user list (admin only) ──────────────────
    if (path === "/users" && request.method === "GET") {
      if (currentUser.role !== "admin") return err("Admin only", 403);
      try {
        const rows = await supabase(
          env,
          "/scout_users?select=*&order=role,display_name",
          "GET",
          null,
          true,
        );
        return json({ users: rows || [] });
      } catch (e) {
        return err("Failed to load users: " + e.message, 500);
      }
    }

    // ── /teams — send briefing (manager + admin) ─────────────
    if (path === "/teams" && request.method === "POST") {
      if (!["admin", "manager"].includes(currentUser.role))
        return err("Not authorised", 403);
      try {
        const { message } = await request.json();
        const res = await fetch(env.TEAMS_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
        await audit(
          env,
          currentUser.email,
          currentUser.name,
          "send_teams_briefing",
          {},
        );
        return json({ success: true, status: res.status });
      } catch (e) {
        return err("Teams post failed: " + e.message, 500);
      }
    }

    return err("Not found", 404);
  },
};

// ── Handler email map ─────────────────────────────────────────
// Exact-match only (previous behaviour) silently returned "" for any
// spelling/spacing variant the Cardinal extract used — a claim then gets
// stored with handler_email = "" and never shows up for that handler's
// portal login or their daily report, with no error anywhere. Normalising
// case/whitespace and falling back to a first-name match closes that gap.
function resolveEmail(handlerName) {
  if (!handlerName) return "";
  const map = {
    "Sarah Dzumba": "sarah@smartsure2020.co.za",
    "Naledi Moletsane": "naledi@smartsure2020.co.za",
    Lucky: "lucky@smartsure2020.co.za",
    "Juan-Paul Van Der Merwe": "juan-paul@smartsure2020.co.za",
    "Juan-Paul": "juan-paul@smartsure2020.co.za",
    "Beverly De Beer": "bev@smartsure2020.co.za",
    "De Beer Bev": "bev@smartsure2020.co.za",
  };

  const normalise = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const target = normalise(handlerName);

  const normalisedMap = {};
  for (const [name, email] of Object.entries(map))
    normalisedMap[normalise(name)] = email;
  if (normalisedMap[target]) return normalisedMap[target];

  // Fallback: match on first name/token (e.g. "Lucky Mahlangu" -> "lucky")
  const firstToken = target.split(" ")[0];
  for (const [name, email] of Object.entries(normalisedMap)) {
    if (name.split(" ")[0] === firstToken) return email;
  }

  return "";
}
