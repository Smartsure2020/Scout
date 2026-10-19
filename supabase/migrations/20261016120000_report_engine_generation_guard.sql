-- Protect report drafts from an older Worker version being rolled back into service.
-- This changes no existing report rows or frozen evidence. Apply before the v3
-- backend version that writes finalised_engine_version.
alter table public.scout_report_runs
  add column if not exists finalised_engine_version text;

create or replace function public.guard_report_engine_generation()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('finalised', 'archived') then
    if new.finalised_engine_version is distinct from old.finalised_engine_version then
      raise exception 'Finalised report engine identity is immutable';
    end if;
    return new;
  end if;

  if old.status = 'draft' then
    -- Explicit known generations and upgrade edge. An unknown pair cannot be
    -- replaced by a different pair until its compatibility is reviewed.
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v3', 'scout-report-v3') and
       (new.metric_definition_version, new.report_schema_version) is distinct from
       ('claims-reporting-metrics-v3', 'scout-report-v3') then
      raise exception 'A v3 report draft cannot be overwritten by an older or unknown report engine';
    end if;
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v2', 'scout-report-v2') and
       (new.metric_definition_version, new.report_schema_version) not in (
         ('claims-reporting-metrics-v2', 'scout-report-v2'),
         ('claims-reporting-metrics-v3', 'scout-report-v3')
       ) then
      raise exception 'Report generation is not a recognised compatible upgrade';
    end if;
    if (old.metric_definition_version, old.report_schema_version) not in (
         ('claims-reporting-metrics-v2', 'scout-report-v2'),
         ('claims-reporting-metrics-v3', 'scout-report-v3')
       ) and
       (new.metric_definition_version, new.report_schema_version) is distinct from
       (old.metric_definition_version, old.report_schema_version) then
      raise exception 'Unknown report generation cannot be overwritten';
    end if;

    if new.status = 'draft' and new.finalised_engine_version is not null then
      raise exception 'Draft reports cannot carry a finalisation engine identity';
    end if;
    if new.status = 'finalised' and
       (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v3', 'scout-report-v3') and
       new.finalised_engine_version is distinct from 'claims-report-engine-v3' then
      raise exception 'A v3 draft requires a compatible report engine to finalise';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists scout_report_run_generation_guard on public.scout_report_runs;
create trigger scout_report_run_generation_guard
before update on public.scout_report_runs
for each row execute function public.guard_report_engine_generation();
