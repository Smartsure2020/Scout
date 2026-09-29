// Contract regressions for the MS2 report-run parent-identity migration.
// The migration must be additive, non-destructive DDL only: it adds
// parent_identity_key, makes claim_id nullable, keeps the existing claim_id
// unique constraint, adds a partial parent-key unique index and an identity
// CHECK - and performs no row DML, trigger disable, or backfill.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs
  .readFileSync(
    path.join(
      root,
      "supabase/migrations/20260928120000_report_run_parent_identity.sql",
    ),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

// Comments must not mask DML assertions.
const sql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("adds a nullable parent_identity_key column", () => {
  assert.match(
    sql,
    /alter table public\.scout_report_run_claims\s+add column if not exists parent_identity_key text/i,
  );
});

test("drops NOT NULL on claim_id", () => {
  assert.match(sql, /alter column claim_id drop not null/i);
});

test("keeps the existing (report_run_id, claim_id) unique constraint (never dropped)", () => {
  assert.doesNotMatch(sql, /drop constraint/i);
  assert.doesNotMatch(sql, /drop index[^;]*claim/i);
});

test("adds the partial parent-key unique index with the deterministic name", () => {
  assert.match(
    sql,
    /create unique index if not exists scout_report_run_claims_parent_key_idx\s+on public\.scout_report_run_claims \(report_run_id, parent_identity_key\)\s+where parent_identity_key is not null/i,
  );
});

test("adds the identity-floor CHECK (validated)", () => {
  assert.match(
    sql,
    /check \(\s*claim_id is not null\s*or\s*nullif\(btrim\(parent_identity_key\), ''\) is not null\s*\) not valid/i,
  );
  assert.match(
    sql,
    /validate constraint scout_report_run_claims_identity_present/i,
  );
  // A blank/whitespace parent_identity_key must NOT satisfy the identity floor.
  assert.doesNotMatch(
    sql,
    /check \(claim_id is not null or parent_identity_key is not null\)/i,
  );
});

test("performs no row DML, no trigger disable, no backfill", () => {
  assert.doesNotMatch(sql, /\bupdate\s+public\./i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\binsert\s+into\b/i);
  assert.doesNotMatch(sql, /disable trigger/i);
  assert.doesNotMatch(sql, /alter table[^;]*disable/i);
});
