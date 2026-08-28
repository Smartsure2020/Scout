import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260828120000_scout_notes_foundation.sql",
  ),
  "utf8",
);
const backend = fs.readFileSync(path.join(root, "scout backend.js"), "utf8");
const claimsUi = fs.readFileSync(
  path.join(root, "scout-smartsure", "claims", "index.html"),
  "utf8",
);

test("notes migration implements the existing one-note-per-claim service contract", () => {
  assert.match(
    migration,
    /create table if not exists public\.scout_notes \(\s*claim_no text primary key,\s*note text not null default ''\s*,\s*saved_by text,\s*saved_at timestamptz/s,
  );
  assert.match(
    migration,
    /alter table public\.scout_notes enable row level security/,
  );
  assert.match(
    migration,
    /revoke all on table public\.scout_notes from anon, authenticated/,
  );
  assert.doesNotMatch(migration, /policy/i);
  assert.doesNotMatch(migration, /references public\.scout_claims/i);
});

test("notes API remains claim-authorized and uses only the contract columns", () => {
  assert.match(backend, /canAccessClaimNote\(env, claimNo, currentUser\)/);
  assert.match(backend, /scout_notes\?claim_no=eq\./);
  assert.match(backend, /select=note,saved_by,saved_at/);
  assert.match(backend, /scout_notes\?on_conflict=claim_no/);
  assert.match(backend, /saved_by: currentUser\.name \|\| currentUser\.email/);
  assert.match(backend, /saved_at: new Date\(\)\.toISOString\(\)/);
  assert.match(
    backend,
    /const \{ note, idempotencyKey \} = await request\.json\(\)/,
  );
  assert.match(backend, /notificationId: noteNotificationId\(idempotencyKey\)/);
  assert.match(
    backend,
    /"\/scout_notifications",\s*"POST",\s*record,\s*true,\s*"resolution=ignore-duplicates,return=representation"/,
  );
  assert.match(claimsUi, /noteIdempotencyKey/);
  assert.match(
    claimsUi,
    /JSON\.stringify\(\{ note: noteValue, idempotencyKey \}\)/,
  );
});
