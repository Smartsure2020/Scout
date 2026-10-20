-- Cardinal Broker is a first-class nullable source field. Existing historical
-- rows remain NULL; no values are inferred or backfilled from other fields.
alter table public.scout_claims
  add column if not exists broker text;

alter table public.scout_history_snapshots
  add column if not exists broker text;

alter table public.scout_report_run_claims
  add column if not exists broker_snapshot text;
