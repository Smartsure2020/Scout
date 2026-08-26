-- Scout Phase 3: deterministic report runs and frozen claim populations.
-- Additive only. Phase 2 historical evidence is not altered.

create table if not exists public.scout_report_runs (
  id uuid primary key default gen_random_uuid(),
  domain text not null default 'claims' check (domain = 'claims'),
  report_type text not null check (report_type in ('weekly', 'monthly')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  time_zone text not null default 'Africa/Johannesburg',
  status text not null default 'draft'
    check (status in ('draft', 'finalised', 'archived')),
  scope_key text not null,
  scope jsonb not null default '{}'::jsonb,
  coverage_status text not null
    check (coverage_status in ('complete', 'usable_with_warnings', 'partial', 'insufficient')),
  coverage_metadata jsonb not null default '{}'::jsonb,
  metric_definition_version text not null,
  claims_rule_version text not null,
  quality_rule_version text not null,
  report_schema_version text not null,
  quality_configuration jsonb not null default '{}'::jsonb,
  metrics_snapshot jsonb not null default '{}'::jsonb,
  opening_extract_id uuid references public.scout_history_extracts(id) on delete restrict,
  closing_extract_id uuid references public.scout_history_extracts(id) on delete restrict,
  generated_at timestamptz not null default now(),
  generated_by text,
  generated_by_user_id text,
  regeneration_count integer not null default 0 check (regeneration_count >= 0),
  last_regenerated_at timestamptz,
  last_regenerated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalised_at timestamptz,
  finalised_by text,
  finalised_by_user_id text,
  archived_at timestamptz,
  archived_by text,
  archived_by_user_id text,
  unique (domain, report_type, period_start, period_end, scope_key),
  check (period_end > period_start),
  check (
    (status = 'draft' and finalised_at is null and archived_at is null)
    or (status = 'finalised' and finalised_at is not null and archived_at is null)
    or (status = 'archived' and finalised_at is not null and archived_at is not null)
  )
);

create table if not exists public.scout_report_run_claims (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid not null references public.scout_report_runs(id) on delete restrict,
  claim_id uuid not null references public.scout_history_claims(id) on delete restrict,
  source_system text not null default 'cardinal_claims',
  source_claim_number text,
  identity_key text,
  metric_ids text[] not null default '{}'::text[],
  membership_reasons jsonb not null default '{}'::jsonb,
  handler_snapshot text,
  handler_email_snapshot text,
  resolved_scout_user_id_snapshot text,
  status_snapshot text,
  insurer_snapshot text,
  peril_snapshot text,
  registered_date_snapshot date,
  calendar_age_snapshot integer,
  working_age_snapshot integer,
  outstanding_snapshot numeric,
  estimate_snapshot numeric,
  paid_snapshot numeric,
  relevant_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (report_run_id, claim_id)
);

create index if not exists scout_report_runs_period_idx
  on public.scout_report_runs (domain, report_type, period_start, period_end);
create index if not exists scout_report_runs_status_idx
  on public.scout_report_runs (status, updated_at desc);
create index if not exists scout_report_runs_scope_idx
  on public.scout_report_runs (scope_key, period_start desc);
create index if not exists scout_report_run_claims_run_idx
  on public.scout_report_run_claims (report_run_id, created_at);
create index if not exists scout_report_run_claims_claim_idx
  on public.scout_report_run_claims (claim_id, report_run_id);
create index if not exists scout_report_run_claims_metric_ids_idx
  on public.scout_report_run_claims using gin (metric_ids);

-- Historical report data is only reachable through the authorised backend.
alter table public.scout_report_runs enable row level security;
alter table public.scout_report_run_claims enable row level security;
revoke all on public.scout_report_runs from anon, authenticated;
revoke all on public.scout_report_run_claims from anon, authenticated;

create or replace function public.prevent_finalised_report_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if old.status = 'archived' then
    raise exception 'Archived report runs are immutable';
  end if;

  if old.status = 'finalised' then
    if new.status not in ('finalised', 'archived')
      or new.domain is distinct from old.domain
      or new.report_type is distinct from old.report_type
      or new.period_start is distinct from old.period_start
      or new.period_end is distinct from old.period_end
      or new.time_zone is distinct from old.time_zone
      or new.scope_key is distinct from old.scope_key
      or new.scope is distinct from old.scope
      or new.coverage_status is distinct from old.coverage_status
      or new.coverage_metadata is distinct from old.coverage_metadata
      or new.metric_definition_version is distinct from old.metric_definition_version
      or new.claims_rule_version is distinct from old.claims_rule_version
      or new.quality_rule_version is distinct from old.quality_rule_version
      or new.report_schema_version is distinct from old.report_schema_version
      or new.quality_configuration is distinct from old.quality_configuration
      or new.metrics_snapshot is distinct from old.metrics_snapshot
      or new.opening_extract_id is distinct from old.opening_extract_id
      or new.closing_extract_id is distinct from old.closing_extract_id
      or new.generated_at is distinct from old.generated_at
      or new.generated_by is distinct from old.generated_by
      or new.generated_by_user_id is distinct from old.generated_by_user_id
      or new.finalised_at is distinct from old.finalised_at
      or new.finalised_by is distinct from old.finalised_by
      or new.finalised_by_user_id is distinct from old.finalised_by_user_id
    then
      raise exception 'Finalised report metrics and evidence are immutable';
    end if;
  end if;

  if old.status = 'draft' and new.status = 'archived' then
    raise exception 'Only finalised reports may be archived';
  end if;

  return new;
end;
$$;

create or replace function public.prevent_finalised_report_claim_mutation()
returns trigger
language plpgsql
as $$
declare
  report_run_id uuid;
  report_status text;
begin
  if tg_op = 'DELETE' then
    report_run_id := old.report_run_id;
  else
    report_run_id := new.report_run_id;
  end if;

  select status into report_status
  from public.scout_report_runs
  where id = report_run_id;

  if report_status in ('finalised', 'archived') then
    raise exception 'Claim populations are immutable after report finalisation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists scout_report_runs_immutable on public.scout_report_runs;
create trigger scout_report_runs_immutable
before update on public.scout_report_runs
for each row execute function public.prevent_finalised_report_mutation();

drop trigger if exists scout_report_run_claims_immutable on public.scout_report_run_claims;
create trigger scout_report_run_claims_immutable
before insert or update or delete on public.scout_report_run_claims
for each row execute function public.prevent_finalised_report_claim_mutation();

comment on table public.scout_report_runs is
  'Server-generated claims report runs; finalised snapshots are immutable and archiveable.';
comment on table public.scout_report_run_claims is
  'Normalised frozen claim populations for report drill-through; never replace with live claim state.';
