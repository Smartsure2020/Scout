import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const fix = fs.readFileSync(path.join(root, "scout-preview-report-detail-fix.sql"), "utf8");
const seed = fs.readFileSync(path.join(root, "scout-preview-synthetic-seed.sql"), "utf8");

test("preview report-detail correction supplies the persisted report contract", () => {
  assert.match(fix, /metrics_snapshot\s*=\s*jsonb_build_object/i);
  assert.match(fix, /'metrics'/i);
  assert.match(fix, /set metric_ids\s*=\s*array_remove/i);
  assert.match(fix, /attention_item_id_snapshot\s*=\s*action\.attention_item_id/i);
  assert.match(fix, /report_type\s*=\s*'monthly'/i);
  assert.match(fix, /2026-09-01/i);
  assert.doesNotMatch(fix, /grant\s/i);
  assert.doesNotMatch(fix, /service[_ ]role/i);
  assert.doesNotMatch(fix, /vsuoesiwifktyutmzxhx\.supabase\.co/i);
  assert.match(seed, /40000000-0000-0000-0000-000000000002/);
  assert.match(seed, /SCOUT_PREVIEW_TESTER_EMAIL/);
  assert.doesNotMatch(
    seed,
    /[A-Z0-9._%+-]+@(?!synthetic\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
});
