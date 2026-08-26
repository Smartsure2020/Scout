-- Scout Phase 2: immutable extract snapshots and provenance-aware history.
--
-- This migration is additive. It does not alter, rename, or delete the live
-- scout_claims/scout_extracts operational tables. Apply only after reviewing
-- the target Supabase project and its Data API grants. The application writes
-- these tables with the service-role backend path; they are not browser APIs.

create table if not exists public.scout_history_extracts (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_file_name text,
  source_checksum text not null,
  checksum_algorithm text not null default 'sha-256'
    check (checksum_algorithm = 'sha-256'),
  checksum_basis text not null default 'claims-json-payload',
  effective_at timestamptz,
  effective_date date,
  effective_precision text not null default 'unknown'
    check (effective_precision in ('exact_timestamp', 'source_date', 'unknown')),
  received_at timestamptz not null default now(),
  uploaded_by_email text,
  uploaded_by_user_id text,
  time_zone text not null default 'Africa/Johannesburg',
  schema_version text not null,
  claim_count integer not null default 0 check (claim_count >= 0),
  accepted_claim_count integer not null default 0 check (accepted_claim_count >= 0),
  rejected_claim_count integer not null default 0 check (rejected_claim_count >= 0),
  quality_summary jsonb not null default '{}'::jsonb,
  previous_extract_id uuid references public.scout_history_extracts(id) on delete restrict,
  correction_of_extract_id uuid references public.scout_history_extracts(id) on delete restrict,
  source_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'processing'
    check (status in ('processing', 'accepted', 'accepted_with_warnings', 'rejected', 'partial_failure')),
  historical_persisted boolean not null default false,
  current_state_updated boolean not null default false,
  created_at timestamptz not null default now(),
  unique (source_system, source_checksum)
);

create table if not exists public.scout_history_claims (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_claim_number text not null,
  identity_key text unique,
  identity_confidence text not null
    check (identity_confidence in ('source_scoped', 'ambiguous', 'unresolved')),
  identity_matchable boolean not null default false,
  identity_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.scout_history_snapshots (
  id uuid primary key default gen_random_uuid(),
  extract_id uuid not null references public.scout_history_extracts(id) on delete restrict,
  claim_id uuid not null references public.scout_history_claims(id) on delete restrict,
  identity_key text,
  identity_matchable boolean not null default false,
  identity_confidence text not null default 'unresolved'
    check (identity_confidence in ('source_scoped', 'ambiguous', 'unresolved')),
  source_row_identity text not null,
  source_row_index integer,
  source_claim_number text not null,
  handler_source text,
  handler_email text,
  resolved_scout_user_id text,
  handler_resolution text not null default 'unassigned'
    check (handler_resolution in ('resolved', 'unassigned', 'unrecognised', 'ambiguous')),
  status_raw text,
  status_normalized text not null default '',
  terminal boolean not null default false,
  open boolean not null default true,
  operational_category text not null default 'unmapped',
  registered_date date,
  dol_date date,
  movement_date date,
  repudiation_date date,
  source_event_at timestamptz,
  outstanding numeric,
  estimate numeric,
  paid numeric,
  mandate numeric,
  insurer text,
  peril text,
  peril_type text,
  insured text,
  description text,
  comments text,
  calendar_age integer,
  working_age integer,
  age_band text,
  rule_version text not null,
  priority_score integer not null default 0,
  priority_band text not null default 'P3' check (priority_band in ('P1', 'P2', 'P3')),
  priority_flags jsonb not null default '[]'::jsonb,
  operational_flags jsonb not null default '[]'::jsonb,
  data_quality_flags jsonb not null default '[]'::jsonb,
  source_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (extract_id, source_row_identity)
);

create table if not exists public.scout_history_changes (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.scout_history_claims(id) on delete restrict,
  change_type text not null check (change_type in (
    'first_observed',
    'status_changed',
    'handler_changed',
    'movement_changed',
    'estimate_changed',
    'outstanding_changed',
    'paid_changed',
    'mandate_changed',
    'terminal_transition_observed',
    'reopened',
    'missing_from_extract'
  )),
  source_extract_id uuid not null references public.scout_history_extracts(id) on delete restrict,
  previous_extract_id uuid references public.scout_history_extracts(id) on delete restrict,
  old_value jsonb,
  new_value jsonb,
  source_event_at timestamptz,
  first_observed_at timestamptz,
  observed_after timestamptz,
  observed_at timestamptz not null,
  provenance text not null check (provenance in ('source_explicit', 'extract_observed', 'system_derived')),
  timestamp_precision text not null check (timestamp_precision in (
    'exact_timestamp', 'source_date', 'between_extracts', 'extract_effective_time', 'unknown'
  )),
  derived_by_version text not null,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists scout_history_extracts_effective_idx
  on public.scout_history_extracts (effective_at desc, received_at desc);
create index if not exists scout_history_extracts_received_idx
  on public.scout_history_extracts (received_at desc);
create index if not exists scout_history_extracts_source_date_idx
  on public.scout_history_extracts (source_system, effective_date desc);
create index if not exists scout_history_snapshots_claim_idx
  on public.scout_history_snapshots (claim_id, extract_id desc);
create index if not exists scout_history_snapshots_claim_number_idx
  on public.scout_history_snapshots (source_claim_number, extract_id desc);
create index if not exists scout_history_snapshots_identity_idx
  on public.scout_history_snapshots (identity_key, extract_id desc);
create index if not exists scout_history_snapshots_handler_idx
  on public.scout_history_snapshots (resolved_scout_user_id, extract_id desc);
create index if not exists scout_history_snapshots_status_idx
  on public.scout_history_snapshots (status_normalized, extract_id desc);
create index if not exists scout_history_snapshots_extract_idx
  on public.scout_history_snapshots (extract_id, source_row_index);
create index if not exists scout_history_changes_claim_observed_idx
  on public.scout_history_changes (claim_id, observed_at desc);
create index if not exists scout_history_changes_type_observed_idx
  on public.scout_history_changes (change_type, observed_at desc);
create index if not exists scout_history_changes_extract_idx
  on public.scout_history_changes (source_extract_id, observed_at desc);
create index if not exists scout_history_changes_previous_extract_idx
  on public.scout_history_changes (previous_extract_id, observed_at desc);

-- Historical evidence is not a browser-facing Data API. The backend uses the
-- service role and the application exposes only authorization-checked routes.
alter table public.scout_history_extracts enable row level security;
alter table public.scout_history_claims enable row level security;
alter table public.scout_history_snapshots enable row level security;
alter table public.scout_history_changes enable row level security;

revoke all on table public.scout_history_extracts from anon, authenticated;
revoke all on table public.scout_history_claims from anon, authenticated;
revoke all on table public.scout_history_snapshots from anon, authenticated;
revoke all on table public.scout_history_changes from anon, authenticated;

-- Source evidence and observed changes are append-only. Manifest lifecycle
-- fields remain mutable so a processing upload can become accepted or record a
-- retryable partial failure.
create or replace function public.prevent_scout_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Scout historical evidence is append-only';
end;
$$;

drop trigger if exists scout_history_claims_append_only on public.scout_history_claims;
create trigger scout_history_claims_append_only
before update or delete on public.scout_history_claims
for each row execute function public.prevent_scout_history_mutation();

drop trigger if exists scout_history_snapshots_append_only on public.scout_history_snapshots;
create trigger scout_history_snapshots_append_only
before update or delete on public.scout_history_snapshots
for each row execute function public.prevent_scout_history_mutation();

drop trigger if exists scout_history_changes_append_only on public.scout_history_changes;
create trigger scout_history_changes_append_only
before update or delete on public.scout_history_changes
for each row execute function public.prevent_scout_history_mutation();

comment on table public.scout_history_extracts is
  'Append-only historical extract manifests; lifecycle status may advance, accepted evidence is not replaced.';
comment on table public.scout_history_claims is
  'Stable source-scoped claim identities; ambiguous source rows are explicitly non-matchable.';
comment on table public.scout_history_snapshots is
  'Immutable normalized source evidence, one row per source row per accepted extract.';
comment on table public.scout_history_changes is
  'Append-only provenance-aware changes observed between compatible extracts.';

-- No automatic rollback is included. Dropping historical evidence requires an
-- explicit retention/governance decision and operator review.


