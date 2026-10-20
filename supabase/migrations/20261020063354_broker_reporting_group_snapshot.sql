-- Freeze the deterministic management grouping alongside the original Broker
-- source value. This does not backfill or rewrite historical report snapshots.
alter table public.scout_report_run_claims
  add column if not exists broker_reporting_group_snapshot text;
