-- Extend the generation guard before deploying engine/schema v5. Existing
-- finalised and archived reports remain immutable. Draft upgrades are forward
-- only, and a v4 draft requires explicit application-level permission before
-- it can be regenerated as v5.
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
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v2', 'scout-report-v2') and
       (new.metric_definition_version, new.report_schema_version) not in (
         ('claims-reporting-metrics-v2', 'scout-report-v2'),
         ('claims-reporting-metrics-v3', 'scout-report-v3'),
         ('claims-reporting-metrics-v4', 'scout-report-v4'),
         ('claims-reporting-metrics-v5', 'scout-report-v5')
       ) then
      raise exception 'Report generation is not a recognised compatible upgrade';
    end if;
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v3', 'scout-report-v3') and
       (new.metric_definition_version, new.report_schema_version) not in (
         ('claims-reporting-metrics-v3', 'scout-report-v3'),
         ('claims-reporting-metrics-v4', 'scout-report-v4'),
         ('claims-reporting-metrics-v5', 'scout-report-v5')
       ) then
      raise exception 'A v3 draft cannot be overwritten by an older or unknown report engine';
    end if;
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v4', 'scout-report-v4') and
       (new.metric_definition_version, new.report_schema_version) not in (
         ('claims-reporting-metrics-v4', 'scout-report-v4'),
         ('claims-reporting-metrics-v5', 'scout-report-v5')
       ) then
      raise exception 'A v4 draft cannot be overwritten by an older or unknown report engine';
    end if;
    if (old.metric_definition_version, old.report_schema_version) =
       ('claims-reporting-metrics-v5', 'scout-report-v5') and
       (new.metric_definition_version, new.report_schema_version) is distinct from
       ('claims-reporting-metrics-v5', 'scout-report-v5') then
      raise exception 'A v5 draft cannot be overwritten by an older or unknown report engine';
    end if;
    if (old.metric_definition_version, old.report_schema_version) not in (
         ('claims-reporting-metrics-v2', 'scout-report-v2'),
         ('claims-reporting-metrics-v3', 'scout-report-v3'),
         ('claims-reporting-metrics-v4', 'scout-report-v4'),
         ('claims-reporting-metrics-v5', 'scout-report-v5')
       ) and
       (new.metric_definition_version, new.report_schema_version) is distinct from
       (old.metric_definition_version, old.report_schema_version) then
      raise exception 'Unknown report generation cannot be overwritten';
    end if;
    if new.status = 'draft' and new.finalised_engine_version is not null then
      raise exception 'Draft reports cannot carry a finalisation engine identity';
    end if;
    if new.status = 'finalised' and
       (new.metric_definition_version, new.report_schema_version) =
       ('claims-reporting-metrics-v3', 'scout-report-v3') and
       new.finalised_engine_version is distinct from 'claims-report-engine-v3' then
      raise exception 'A v3 draft requires a compatible report engine to finalise';
    end if;
    if new.status = 'finalised' and
       (new.metric_definition_version, new.report_schema_version) =
       ('claims-reporting-metrics-v4', 'scout-report-v4') and
       new.finalised_engine_version is distinct from 'claims-report-engine-v4' then
      raise exception 'A v4 draft requires the v4 report engine to finalise';
    end if;
    if new.status = 'finalised' and
       (new.metric_definition_version, new.report_schema_version) =
       ('claims-reporting-metrics-v5', 'scout-report-v5') and
       new.finalised_engine_version is distinct from 'claims-report-engine-v5' then
      raise exception 'A v5 draft requires the v5 report engine to finalise';
    end if;
  end if;
  return new;
end;
$$;
