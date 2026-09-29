-- Scout MS2: report-run parent-claim identity.
--
-- Non-destructive, additive DDL only. This migration lets a report claim-
-- population row represent a logical PARENT claim (source_system + normalized
-- claim number) even when no canonical scout_history_claims UUID exists - as is
-- the case for legitimate multi-section claims that were multi-row in every
-- historical extract and therefore only ever received row-level ambiguous
-- claim ids.
--
-- IMPORTANT - this migration performs NO row DML:
--   * no UPDATE / DELETE / INSERT of existing rows;
--   * no trigger disable (scout_report_run_claims_immutable stays active);
--   * no backfill of legacy / finalised / archived report evidence.
-- Existing frozen report rows are left byte-for-byte unchanged.
--
-- Legacy (report_schema_version v1) rows keep their existing claim_id/
-- identity_key semantics and parent_identity_key remains NULL for them
-- permanently. New parent-aware (v2) rows carry parent_identity_key and may
-- have a NULL claim_id when no canonical parent UUID exists.
--
-- Forward-only caution: once a v2 report has persisted a row with a NULL
-- claim_id, this change cannot simply be rolled back by re-adding NOT NULL to
-- claim_id (that would fail on the NULL rows). Dropping parent_identity_key is
-- likewise only safe before any v2 report exists. Rollback of the new index /
-- CHECK alone is always safe.

-- 1. Additive nullable column - metadata-only, no table rewrite, no row DML.
alter table public.scout_report_run_claims
  add column if not exists parent_identity_key text;

-- 2. claim_id becomes optional. The FK to scout_history_claims(id) is kept;
--    NULLs do not violate the foreign key. Metadata-only, no row rewrite.
alter table public.scout_report_run_claims
  alter column claim_id drop not null;

-- 3. The existing UNIQUE (report_run_id, claim_id) is intentionally KEPT and
--    NOT dropped/recreated: PostgreSQL treats NULLs as distinct, so multiple
--    NULL-claim_id parent rows are permitted in one run while duplicate
--    non-null claim_ids remain rejected.

-- 4. Deterministic dedupe for parent-aware rows: one parent per report run.
--    Partial so legacy NULL parent_identity_key rows are excluded.
create unique index if not exists scout_report_run_claims_parent_key_idx
  on public.scout_report_run_claims (report_run_id, parent_identity_key)
  where parent_identity_key is not null;

-- 5. Identity floor: no population row may carry neither identity. Added
--    NOT VALID then VALIDATE so the validation scan (a read, not row DML) does
--    not lock heavily; every legacy row already has a non-null claim_id and
--    therefore satisfies the constraint.
alter table public.scout_report_run_claims
  add constraint scout_report_run_claims_identity_present
  check (
    claim_id is not null
    or nullif(btrim(parent_identity_key), '') is not null
  ) not valid;

alter table public.scout_report_run_claims
  validate constraint scout_report_run_claims_identity_present;

comment on column public.scout_report_run_claims.parent_identity_key is
  'MS2 logical parent identity (source_system:claim_number) for parent-aware (v2) report populations; NULL for legacy v1 rows. Never a child row UUID.';
