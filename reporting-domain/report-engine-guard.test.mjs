import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = fs
  .readFileSync(path.join(root, "scout backend.js"), "utf8")
  .replace(/\r\n/g, "\n");
const migration = fs.readFileSync(
  path.join(
    root,
    "supabase/migrations/20261016120000_report_engine_generation_guard.sql",
  ),
  "utf8",
);
const migrationV4 = fs.readFileSync(
  path.join(root, "supabase/migrations/20261020072523_report_engine_v4_generation_guard.sql"),
  "utf8",
);
const migrationV5 = fs.readFileSync(
  path.join(root, "supabase/migrations/20261021090000_report_engine_v5_generation_guard.sql"),
  "utf8",
);

test("both draft write routes reject incompatible generations before evidence or persistence", () => {
  const generate = backend.slice(
    backend.indexOf('if (path === "/reports/generate"'),
    backend.indexOf("const reportMetricClaimsMatch"),
  );
  const regenerate = backend.slice(
    backend.indexOf("if (reportRegenerateMatch"),
    backend.indexOf("const reportFinaliseMatch"),
  );
  for (const route of [generate, regenerate]) {
    assert.ok(route.indexOf("reportRegenerationCompatibility(") >= 0);
    assert.ok(
      route.indexOf("reportRegenerationCompatibility(") <
        route.indexOf("loadReportEvidence("),
    );
    assert.ok(
      route.indexOf(
        "if (!compatibility.allowed) return err(compatibility.message, 409)",
      ) >= 0,
    );
  }
});

test("Finalise rejects incompatible drafts before workflow freeze, while existing finalised runs remain idempotent", () => {
  const finalise = backend.slice(
    backend.indexOf("if (reportFinaliseMatch"),
    backend.indexOf("const reportPdfMatch"),
  );
  assert.ok(
    finalise.indexOf('existing.status === "finalised"') <
      finalise.indexOf("reportFinalisationCompatibility("),
  );
  assert.ok(
    finalise.indexOf("reportFinalisationCompatibility(") <
      finalise.indexOf("syncReportWorkflowSnapshots("),
  );
  assert.match(finalise, /finalised_engine_version: REPORT_ENGINE_VERSION/);
  assert.match(
    finalise,
    /if \(!compatibility.allowed\) return err\(compatibility.message, 409\)/,
  );
  const pdf = backend.slice(
    backend.indexOf("if (reportPdfMatch"),
    backend.indexOf("const reportArchiveMatch"),
  );
  assert.doesNotMatch(
    pdf,
    /reportFinalisationCompatibility|reportRegenerationCompatibility/,
  );
  const byId = backend.slice(
    backend.indexOf("if (reportByIdMatch"),
    backend.indexOf("// ── /audit"),
  );
  assert.doesNotMatch(
    byId,
    /reportFinalisationCompatibility|reportRegenerationCompatibility/,
  );
});

test("database guard blocks old code from downgrading or finalising a v3 draft without attestation", () => {
  assert.match(
    migration,
    /add column if not exists finalised_engine_version text/i,
  );
  assert.match(migration, /'claims-reporting-metrics-v3', 'scout-report-v3'/);
  assert.match(migration, /'claims-reporting-metrics-v2', 'scout-report-v2'/);
  assert.match(
    migration,
    /new\.finalised_engine_version is distinct from 'claims-report-engine-v3'/,
  );
  assert.match(migration, /before update on public\.scout_report_runs/i);
  assert.doesNotMatch(
    migration,
    /\bupdate\s+public\.|\bdelete\s+from\b|\binsert\s+into\b/i,
  );
});

test("v4 database guard preserves v3 and rejects older Worker rewrites of v4 drafts", () => {
  assert.match(migrationV4, /claims-reporting-metrics-v4', 'scout-report-v4'/);
  assert.match(migrationV4, /new\.finalised_engine_version is distinct from 'claims-report-engine-v4'/);
  assert.match(migrationV4, /v4 draft cannot be overwritten by an older or unknown report engine/);
  assert.match(migrationV4, /claims-reporting-metrics-v3', 'scout-report-v3'/);
  assert.doesNotMatch(migrationV4, /\bupdate\s+public\.|\bdelete\s+from\b|\binsert\s+into\b/i);
});

test("v5 database guard allows only forward v4 upgrades and requires v5 finalisation attestation", () => {
  assert.match(migrationV5, /claims-reporting-metrics-v5', 'scout-report-v5'/);
  assert.match(
    migrationV5,
    /new\.finalised_engine_version is distinct from 'claims-report-engine-v5'/,
  );
  assert.match(
    migrationV5,
    /v5 draft cannot be overwritten by an older or unknown report engine/,
  );
  assert.match(
    migrationV5,
    /v4 draft cannot be overwritten by an older or unknown report engine/,
  );
  assert.doesNotMatch(
    migrationV5,
    /\bupdate\s+public\.|\bdelete\s+from\b|\binsert\s+into\b/i,
  );
});
