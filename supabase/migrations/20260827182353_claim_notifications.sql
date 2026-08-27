-- Scout claim-note notifications.
-- Additive only. This migration is intentionally not applied automatically.
-- The canonical backend uses the service role and enforces recipient identity
-- on every read/update; direct anon/authenticated Data API access is revoked.

create table if not exists public.scout_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id text not null,
  actor_user_id text,
  actor_display_name text not null,
  type text not null check (type = 'claim_note_added'),
  claim_number text not null check (char_length(claim_number) between 1 and 120),
  title text not null,
  message text not null check (char_length(message) between 1 and 280),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists scout_notifications_recipient_idx
  on public.scout_notifications (recipient_user_id, read_at, created_at desc);
create index if not exists scout_notifications_claim_idx
  on public.scout_notifications (claim_number, created_at desc);

alter table public.scout_notifications enable row level security;
revoke all on public.scout_notifications from anon, authenticated;

comment on table public.scout_notifications is
  'Persistent in-app Scout notifications; recipient identity is enforced by the authenticated backend.';
