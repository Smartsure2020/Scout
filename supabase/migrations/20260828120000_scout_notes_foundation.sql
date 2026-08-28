-- Scout P0 notes foundation.
-- The backend already exposes GET/PUT /notes/:claimNo and writes this exact
-- service-role contract. This migration is additive and is intentionally not
-- applied here; production application requires a separately reviewed SQL
-- Editor change.

create table if not exists public.scout_notes (
  claim_no text primary key,
  note text not null default '',
  saved_by text,
  saved_at timestamptz
);

alter table public.scout_notes enable row level security;

-- Notes are accessed only through the authorization-checked service-role API.
revoke all on table public.scout_notes from anon, authenticated;

comment on table public.scout_notes is
  'Per-claim Scout notes; one current note per claim number, service-role API only.';
