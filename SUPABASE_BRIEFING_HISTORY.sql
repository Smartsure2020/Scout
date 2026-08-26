-- SCOUT automated briefing history.
-- Run in Supabase SQL editor before relying on dashboard delivery history.

create table if not exists public.briefing_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null default 'cron',
  extract_id text,
  extract_date date,
  status text not null default 'started',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  claim_count integer not null default 0,
  delivery_count integer not null default 0
);

create table if not exists public.briefing_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.briefing_runs(id) on delete set null,
  type text not null,
  recipient_name text,
  recipient_email text,
  subject text,
  status text not null,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.digest_log (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  type text not null check (type in ('handler', 'manager', 'anomaly')),
  recipient text,
  subject text not null,
  claims_count integer not null default 0,
  critical_count integer not null default 0,
  html_body text not null,
  sent_ok boolean not null default false
);

create table if not exists public.scout_settings (
  id text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Data-quality support for Cardinal extracts.
-- Safe to run even if these tables were created earlier by another migration.
alter table if exists public.claims
  add column if not exists cardinal_estimate numeric,
  add column if not exists cardinal_age integer,
  add column if not exists calculated_age integer,
  add column if not exists age_discrepancy_days integer,
  add column if not exists data_quality_flags jsonb not null default '[]'::jsonb;

alter table if exists public.claim_extracts
  add column if not exists claim_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists data_quality_report jsonb not null default '{}'::jsonb;

insert into public.scout_settings (id, value)
values (
  'digest',
  jsonb_build_object(
    'send_time', '07:30',
    'handler_emails', '{}'::jsonb,
    'manager_email', 'bev@smartsure2020.co.za',
    'zero_estimate_email', 'bev@smartsure2020.co.za',
    'include_terminal_claims', false
  )
)
on conflict (id) do nothing;

create index if not exists briefing_runs_started_at_idx
  on public.briefing_runs (started_at desc);

create index if not exists briefing_deliveries_run_id_idx
  on public.briefing_deliveries (run_id);

create index if not exists digest_log_generated_at_idx
  on public.digest_log (generated_at desc);

create index if not exists digest_log_type_generated_at_idx
  on public.digest_log (type, generated_at desc);

alter table public.briefing_runs enable row level security;
alter table public.briefing_deliveries enable row level security;
alter table public.digest_log enable row level security;
alter table public.scout_settings enable row level security;

-- The Worker uses the service role key for inserts/selects.
-- Add authenticated read policies only if the dashboard should query Supabase directly.
-- Current Scout dashboard reads history through the Worker endpoint instead.
