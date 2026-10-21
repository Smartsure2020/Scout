-- Run against a disposable PostgreSQL database after the reporting history,
-- reporting runs, and report engine generation guard migrations are applied.
-- Every fixture is rolled back after the assertions.
begin;

do $$
declare
  v3_id uuid;
  v2_id uuid;
  v4_id uuid;
  historical_id uuid;
  report_row public.scout_report_runs%rowtype;
begin
  insert into public.scout_report_runs (
    report_type, period_start, period_end, scope_key, coverage_status,
    metric_definition_version, claims_rule_version, quality_rule_version,
    report_schema_version
  ) values (
    'weekly', '2026-10-12', '2026-10-17', 'guard-test-v3', 'complete',
    'claims-reporting-metrics-v3', 'claims-rule-v3', 'quality-rule-v3',
    'scout-report-v3'
  ) returning id into v3_id;

  -- A rollback Worker must not replace a v3 draft with its v2 payload.
  begin
    update public.scout_report_runs
    set metric_definition_version = 'claims-reporting-metrics-v2',
        report_schema_version = 'scout-report-v2',
        metrics_snapshot = '{"oldWorker":true}'::jsonb
    where id = v3_id;
    raise exception 'Expected v3 downgrade rejection';
  exception when others then
    if sqlerrm = 'Expected v3 downgrade rejection' or
       sqlerrm not like 'A v3 draft cannot be overwritten%' then
      raise;
    end if;
  end;

  select * into strict report_row from public.scout_report_runs where id = v3_id;
  if report_row.metric_definition_version <> 'claims-reporting-metrics-v3' or
     report_row.metrics_snapshot <> '{}'::jsonb then
    raise exception 'Rejected rollback changed the v3 draft';
  end if;

  -- Current engine writes remain valid.
  update public.scout_report_runs
  set metrics_snapshot = '{"sameVersion":true}'::jsonb,
      regeneration_count = regeneration_count + 1
  where id = v3_id;
  select * into strict report_row from public.scout_report_runs where id = v3_id;
  if report_row.metrics_snapshot <> '{"sameVersion":true}'::jsonb or
     report_row.regeneration_count <> 1 then
    raise exception 'Same-version regeneration was not persisted';
  end if;

  -- An older Worker cannot finalise a v3 draft without its engine identity.
  begin
    update public.scout_report_runs
    set status = 'finalised', finalised_at = now()
    where id = v3_id;
    raise exception 'Expected incompatible finalise rejection';
  exception when others then
    if sqlerrm = 'Expected incompatible finalise rejection' or
       sqlerrm not like 'A v3 draft requires a compatible report engine%' then
      raise;
    end if;
  end;
  update public.scout_report_runs
  set status = 'finalised', finalised_at = now(),
      finalised_engine_version = 'claims-report-engine-v3'
  where id = v3_id;

  -- The known v2-to-v3 transition is allowed by the database. The API still
  -- requires its explicit allowCompatibleUpgrade flag for this operation.
  insert into public.scout_report_runs (
    report_type, period_start, period_end, scope_key, coverage_status,
    metric_definition_version, claims_rule_version, quality_rule_version,
    report_schema_version
  ) values (
    'weekly', '2026-10-05', '2026-10-10', 'guard-test-upgrade', 'complete',
    'claims-reporting-metrics-v2', 'claims-rule-v2', 'quality-rule-v2',
    'scout-report-v2'
  ) returning id into v2_id;
  update public.scout_report_runs
  set metric_definition_version = 'claims-reporting-metrics-v3',
      report_schema_version = 'scout-report-v3'
  where id = v2_id;
  select * into strict report_row from public.scout_report_runs where id = v2_id;
  if report_row.report_schema_version <> 'scout-report-v3' then
    raise exception 'Known compatible upgrade did not persist';
  end if;

  -- The application requires explicit permission for the v4-to-v5 draft
  -- upgrade; once granted, the database permits that forward transition and
  -- requires v5 engine attestation at finalisation.
  insert into public.scout_report_runs (
    report_type, period_start, period_end, scope_key, coverage_status,
    metric_definition_version, claims_rule_version, quality_rule_version,
    report_schema_version
  ) values (
    'weekly', '2026-10-19', '2026-10-24', 'guard-test-v5-upgrade', 'complete',
    'claims-reporting-metrics-v4', 'claims-operations-rules-v1', 'quality-rule-v2',
    'scout-report-v4'
  ) returning id into v4_id;
  update public.scout_report_runs
  set metric_definition_version = 'claims-reporting-metrics-v5',
      report_schema_version = 'scout-report-v5',
      claims_rule_version = 'claims-operations-rules-v2'
  where id = v4_id;
  begin
    update public.scout_report_runs
    set status = 'finalised', finalised_at = now(),
        finalised_engine_version = 'claims-report-engine-v4'
    where id = v4_id;
    raise exception 'Expected v5 finalise attestation rejection';
  exception when others then
    if sqlerrm = 'Expected v5 finalise attestation rejection' or
       sqlerrm not like 'A v5 draft requires the v5 report engine%' then
      raise;
    end if;
  end;
  update public.scout_report_runs
  set status = 'finalised', finalised_at = now(),
      finalised_engine_version = 'claims-report-engine-v5'
  where id = v4_id;

  -- Existing v2 finalised reports remain readable with no new engine field.
  insert into public.scout_report_runs (
    report_type, period_start, period_end, scope_key, coverage_status,
    metric_definition_version, claims_rule_version, quality_rule_version,
    report_schema_version, status, finalised_at, metrics_snapshot
  ) values (
    'weekly', '2026-09-28', '2026-10-03', 'guard-test-history', 'complete',
    'claims-reporting-metrics-v2', 'claims-rule-v2', 'quality-rule-v2',
    'scout-report-v2', 'finalised', now(), '{"historical":true}'::jsonb
  ) returning id into historical_id;
  select * into strict report_row
  from public.scout_report_runs where id = historical_id;
  if report_row.status <> 'finalised' or
     report_row.finalised_engine_version is not null or
     report_row.metrics_snapshot <> '{"historical":true}'::jsonb then
    raise exception 'Historical finalised v2 report was not readable';
  end if;

  raise notice 'PASS: downgrade, same-version, compatible upgrades through v5, finalise, historical v2';
end;
$$;

rollback;
