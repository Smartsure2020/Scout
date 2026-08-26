-- Scout Phase 5: management attention and action-plan workflow snapshots.
-- Additive only. Live workflow rows may change after a report is finalised;
-- report membership rows freeze the values that belonged to that report.

create table if not exists public.scout_management_attention (
  id uuid primary key default gen_random_uuid(),
  domain text not null default 'claims' check (domain = 'claims'),
  claim_id uuid references public.scout_history_claims(id) on delete restrict,
  source_claim_number_snapshot text,
  title text not null,
  management_note text,
  category text not null check (category in (
    'claim_development', 'insurer_facility', 'assessor', 'investigator',
    'broker_client', 'payment', 'mandate_high_value', 'complaint',
    'legal_nfo', 'fraud', 'data_system', 'operational', 'other'
  )),
  priority text not null default 'medium'
    check (priority in ('high', 'medium', 'low')),
  owner_user_id text,
  owner_display_snapshot text,
  next_action text,
  due_date date,
  status text not null default 'open'
    check (status in ('open', 'monitoring', 'waiting', 'resolved')),
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  originating_report_id uuid references public.scout_report_runs(id) on delete restrict,
  carry_forward_source_id uuid references public.scout_management_attention(id) on delete restrict
);

create table if not exists public.scout_management_actions (
  id uuid primary key default gen_random_uuid(),
  domain text not null default 'claims' check (domain = 'claims'),
  action text not null,
  category text not null check (category in (
    'claim', 'insurer', 'broker', 'supplier', 'payment', 'system',
    'team', 'management', 'other'
  )),
  claim_id uuid references public.scout_history_claims(id) on delete restrict,
  source_claim_number_snapshot text,
  attention_item_id uuid references public.scout_management_attention(id) on delete restrict,
  owner_user_id text,
  owner_display_snapshot text,
  due_date date,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting', 'completed')),
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  completed_at timestamptz,
  completed_by text,
  resolution_note text,
  originating_report_id uuid references public.scout_report_runs(id) on delete restrict,
  carry_forward_source_id uuid references public.scout_management_actions(id) on delete restrict
);

create table if not exists public.scout_report_attention_items (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid not null references public.scout_report_runs(id) on delete restrict,
  attention_item_id uuid not null references public.scout_management_attention(id) on delete restrict,
  claim_id uuid references public.scout_history_claims(id) on delete restrict,
  claim_number_snapshot text,
  title_snapshot text not null,
  management_note_snapshot text,
  category_snapshot text not null,
  priority_snapshot text not null,
  owner_user_id_snapshot text,
  owner_display_snapshot text,
  handler_snapshot text,
  claim_status_snapshot text,
  insurer_snapshot text,
  next_action_snapshot text,
  due_date_snapshot date,
  status_snapshot text not null,
  resolution_note_snapshot text,
  display_order integer not null default 0,
  carried_forward_from_report_id uuid references public.scout_report_runs(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (report_run_id, attention_item_id),
  check (category_snapshot in (
    'claim_development', 'insurer_facility', 'assessor', 'investigator',
    'broker_client', 'payment', 'mandate_high_value', 'complaint',
    'legal_nfo', 'fraud', 'data_system', 'operational', 'other'
  )),
  check (priority_snapshot in ('high', 'medium', 'low')),
  check (status_snapshot in ('open', 'monitoring', 'waiting', 'resolved'))
);

create table if not exists public.scout_report_action_items (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid not null references public.scout_report_runs(id) on delete restrict,
  action_id uuid not null references public.scout_management_actions(id) on delete restrict,
  attention_item_id_snapshot uuid references public.scout_management_attention(id) on delete restrict,
  claim_id uuid references public.scout_history_claims(id) on delete restrict,
  claim_number_snapshot text,
  action_snapshot text not null,
  category_snapshot text not null,
  owner_user_id_snapshot text,
  owner_display_snapshot text,
  handler_snapshot text,
  claim_status_snapshot text,
  insurer_snapshot text,
  due_date_snapshot date,
  status_snapshot text not null,
  resolution_note_snapshot text,
  display_order integer not null default 0,
  carried_forward_from_report_id uuid references public.scout_report_runs(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (report_run_id, action_id),
  check (category_snapshot in (
    'claim', 'insurer', 'broker', 'supplier', 'payment', 'system',
    'team', 'management', 'other'
  )),
  check (status_snapshot in ('open', 'in_progress', 'waiting', 'completed'))
);

create index if not exists scout_management_attention_status_idx
  on public.scout_management_attention (status, due_date, updated_at desc);
create index if not exists scout_management_attention_claim_idx
  on public.scout_management_attention (claim_id, status, updated_at desc);
create index if not exists scout_management_actions_status_idx
  on public.scout_management_actions (status, due_date, updated_at desc);
create index if not exists scout_management_actions_claim_idx
  on public.scout_management_actions (claim_id, status, updated_at desc);
create index if not exists scout_report_attention_items_run_idx
  on public.scout_report_attention_items (report_run_id, display_order, created_at);
create index if not exists scout_report_action_items_run_idx
  on public.scout_report_action_items (report_run_id, display_order, created_at);

-- These tables are reached only through the authorisation-checked backend.
alter table public.scout_management_attention enable row level security;
alter table public.scout_management_actions enable row level security;
alter table public.scout_report_attention_items enable row level security;
alter table public.scout_report_action_items enable row level security;
revoke all on table public.scout_management_attention from anon, authenticated;
revoke all on table public.scout_management_actions from anon, authenticated;
revoke all on table public.scout_report_attention_items from anon, authenticated;
revoke all on table public.scout_report_action_items from anon, authenticated;

create or replace function public.prevent_finalised_report_workflow_mutation()
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
    raise exception 'Management workflow snapshots are immutable after report finalisation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists scout_report_attention_items_immutable on public.scout_report_attention_items;
create trigger scout_report_attention_items_immutable
before insert or update or delete on public.scout_report_attention_items
for each row execute function public.prevent_finalised_report_workflow_mutation();

drop trigger if exists scout_report_action_items_immutable on public.scout_report_action_items;
create trigger scout_report_action_items_immutable
before insert or update or delete on public.scout_report_action_items
for each row execute function public.prevent_finalised_report_workflow_mutation();

comment on table public.scout_management_attention is
  'Live, human-managed management attention items; owner and claim context are snapshotted at mutation time.';
comment on table public.scout_management_actions is
  'Live management actions linked optionally to a claim or attention item.';
comment on table public.scout_report_attention_items is
  'Report-specific management attention membership and frozen values at finalisation.';
comment on table public.scout_report_action_items is
  'Report-specific action-plan membership and frozen values at finalisation.';
