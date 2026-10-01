-- Prepared for review only. Do not apply until the application and migration
-- are approved for release together.
--
-- These nullable columns preserve fields used by Scout's operational views,
-- rules, timelines, and current-state data-quality checks. Existing rows remain
-- valid, and unknown financial values remain NULL rather than becoming zero.

alter table public.scout_claims
  add column if not exists cardinal_age_days integer,
  add column if not exists estimate numeric,
  add column if not exists paid numeric,
  add column if not exists repudiation_date date,
  add column if not exists last_updated date,
  add column if not exists last_updated_source text,
  add column if not exists settled_date date,
  add column if not exists ingestion_quality_flags jsonb;

comment on column public.scout_claims.estimate is
  'Cardinal original estimate; NULL means missing or malformed at ingestion.';
comment on column public.scout_claims.cardinal_age_days is
  'Age supplied by Cardinal, retained separately from Scout-calculated age_days.';
comment on column public.scout_claims.paid is
  'Cardinal paid amount; NULL means missing or malformed at ingestion.';
comment on column public.scout_claims.repudiation_date is
  'Cardinal repudiation notification/letter date, stored with date-only semantics.';
comment on column public.scout_claims.last_updated is
  'Cardinal movement date, stored with date-only semantics.';
comment on column public.scout_claims.last_updated_source is
  'Provenance for last_updated, for example cardinal or unavailable.';
comment on column public.scout_claims.settled_date is
  'Cardinal settled date, stored with date-only semantics.';
comment on column public.scout_claims.ingestion_quality_flags is
  'Source parse warnings retained for current-state data-quality diagnostics.';
