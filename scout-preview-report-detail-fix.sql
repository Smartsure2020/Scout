-- Preview-only corrective fixture for the September 2026 monthly report.
-- This is intentionally data-only: no grants, policies, credentials, or
-- production objects are changed.
begin;

with target as (
  select id
  from public.scout_report_runs
  where domain = 'claims'
    and report_type = 'monthly'
    and (period_start at time zone 'Africa/Johannesburg')::date = date '2026-09-01'
), source as (
  select
    rc.claim_id,
    rc.status_snapshot,
    rc.calendar_age_snapshot,
    rc.outstanding_snapshot,
    rc.estimate_snapshot,
    rc.paid_snapshot,
    rc.handler_snapshot,
    rc.handler_email_snapshot
  from public.scout_report_run_claims rc
  join target t on t.id = rc.report_run_id
), populations as (
  select
    coalesce(jsonb_agg(claim_id::text order by claim_id), '[]'::jsonb) as all_ids,
    coalesce(jsonb_agg(claim_id::text order by claim_id) filter (
      where status_snapshot not in ('Closed Paid', 'Payment Released')
    ), '[]'::jsonb) as active_ids,
    coalesce(jsonb_agg(claim_id::text order by claim_id) filter (
      where calendar_age_snapshot >= 14
    ), '[]'::jsonb) as breach_ids,
    coalesce(jsonb_agg(claim_id::text order by claim_id) filter (
      where calendar_age_snapshot >= 30
    ), '[]'::jsonb) as stale_ids,
    coalesce(jsonb_agg(claim_id::text order by claim_id) filter (
      where coalesce(estimate_snapshot, 0) = 0
        and status_snapshot ilike '%payment%'
    ), '[]'::jsonb) as zero_estimate_ids,
    count(*) filter (
      where status_snapshot not in ('Closed Paid', 'Payment Released')
    )::int as active_count,
    count(*) filter (where status_snapshot in ('Closed Paid', 'Payment Released'))::int as closed_count,
    count(*) filter (where calendar_age_snapshot >= 14)::int as breach_count,
    coalesce(sum(outstanding_snapshot) filter (
      where status_snapshot not in ('Closed Paid', 'Payment Released')
    ), 0)::numeric as outstanding_total,
    coalesce(sum(estimate_snapshot) filter (
      where status_snapshot not in ('Closed Paid', 'Payment Released')
    ), 0)::numeric as estimate_total,
    coalesce(sum(paid_snapshot) filter (
      where status_snapshot not in ('Closed Paid', 'Payment Released')
    ), 0)::numeric as paid_total
  from source
), metric_rows as (
  select id, value, claim_ids, precision
  from populations p
  cross join lateral (values
    ('opening_inventory', to_jsonb(p.active_count), p.active_ids, 'snapshot_exact'),
    ('closing_inventory', to_jsonb(p.active_count), p.active_ids, 'snapshot_exact'),
    ('new_claims_registered', to_jsonb(0), '[]'::jsonb, 'observed_period'),
    ('new_claims_first_observed', to_jsonb(0), '[]'::jsonb, 'observed_period'),
    ('claims_closed', to_jsonb(p.closed_count), p.all_ids, 'observed_period'),
    ('claims_closed_exact', to_jsonb(0), '[]'::jsonb, 'unavailable'),
    ('claims_closed_observed', to_jsonb(p.closed_count), p.all_ids, 'observed_period'),
    ('net_inventory_movement', to_jsonb(0), p.all_ids, 'snapshot_exact'),
    ('open_claims_60_plus', to_jsonb(0), '[]'::jsonb, 'snapshot_exact'),
    ('open_claims_91_plus', to_jsonb(0), '[]'::jsonb, 'snapshot_exact'),
    ('sla_compliance', to_jsonb(case when p.active_count = 0 then 0 else round((p.active_count - p.breach_count)::numeric / p.active_count, 4) end), p.active_ids, 'snapshot_exact'),
    ('sla_breaches', to_jsonb(p.breach_count), p.breach_ids, 'snapshot_exact'),
    ('sla_summary', jsonb_build_object('compliant', p.active_count - p.breach_count, 'unmapped', 0), p.active_ids, 'snapshot_exact'),
    ('no_movement_over_14', to_jsonb(p.breach_count), p.breach_ids, 'snapshot_exact'),
    ('no_movement_over_30', to_jsonb(jsonb_array_length(p.stale_ids)), p.stale_ids, 'snapshot_exact'),
    ('ready_to_close', to_jsonb(0), '[]'::jsonb, 'snapshot_exact'),
    ('zero_estimate_payment_request', to_jsonb(jsonb_array_length(p.zero_estimate_ids)), p.zero_estimate_ids, 'snapshot_exact'),
    ('operational_health', jsonb_build_object('assessor_overdue', 0, 'investigator_overdue', 0, 'broker_overdue', 0, 'high_value_mandate_attention', 0, 'legal_recovery', 0, 'nfo_ombudsman', 0, 'fraud', 0, 'repudiation_expired', 0), p.active_ids, 'snapshot_exact'),
    ('financial_open_outstanding', to_jsonb(p.outstanding_total), p.active_ids, 'snapshot_exact'),
    ('financial_estimate_total', to_jsonb(p.estimate_total), p.active_ids, 'snapshot_exact'),
    ('financial_paid_total', to_jsonb(p.paid_total), p.active_ids, 'snapshot_exact'),
    ('assignment_activity', to_jsonb(0), '[]'::jsonb, 'observed_period'),
    ('ageing_distribution', jsonb_build_object('0-30', p.active_count, '31-60', 0, '61-90', 0, '91+', 0, 'unknown', 0), p.active_ids, 'snapshot_exact'),
    ('handler_performance', jsonb_build_object('handlers', '[]'::jsonb, 'manager_held_other', jsonb_build_object('count', 0), 'unassigned_unresolved', jsonb_build_object('count', 0)), p.active_ids, 'snapshot_exact')
  ) as m(id, value, claim_ids, precision)
), metrics as (
  select jsonb_object_agg(
    id,
    jsonb_build_object(
      'id', id,
      'value', value,
      'definition', id,
      'metric_definition_version', 'synthetic-qa-v1',
      'precision', precision,
      'availability', 'available',
      'claim_population', jsonb_build_object(
        'count', jsonb_array_length(claim_ids),
        'claim_ids', claim_ids
      ),
      'coverage_warnings', '[]'::jsonb,
      'evidence', jsonb_build_object('source', 'synthetic-qa')
    )
  ) as value
  from metric_rows
)
update public.scout_report_runs r
set metrics_snapshot = jsonb_build_object(
  'domain', 'claims',
  'report_type', 'monthly',
  'report_schema_version', 'synthetic-qa-v1',
  'metric_definition_version', 'synthetic-qa-v1',
  'claims_rule_version', 'synthetic-qa-v1',
  'quality_rule_version', 'synthetic-qa-v1',
  'quality_configuration', jsonb_build_object('version', 'synthetic-qa-v1'),
  'period_start', '2026-09-01T00:00:00+02:00',
  'period_end', '2026-10-01T00:00:00+02:00',
  'period_start_local_date', '2026-09-01',
  'period_end_local_date', '2026-10-01',
  'timezone', 'Africa/Johannesburg',
  'scope', jsonb_build_object('kind', 'team'),
  'coverage_status', 'usable_with_warnings',
  'coverage', jsonb_build_object(
    'accepted_extract_count', 1,
    'warning_quality_extract_count', 1,
    'historical_capability_start_date', '2026-09-01',
    'warnings', jsonb_build_array('synthetic_fixture')
  ),
  'metrics', (select value from metrics),
  'comparisons', '{}'::jsonb,
  'activity', jsonb_build_object('changes_considered', 0, 'disappearance_is_not_closure', true)
)
where r.id = (select id from target);

with target as (
  select id
  from public.scout_report_runs
  where domain = 'claims'
    and report_type = 'monthly'
    and (period_start at time zone 'Africa/Johannesburg')::date = date '2026-09-01'
)
update public.scout_report_run_claims rc
set metric_ids = array_remove(array[
  'closing_inventory',
  case when rc.calendar_age_snapshot >= 14 then 'sla_breaches' end,
  case when rc.calendar_age_snapshot >= 14 then 'no_movement_over_14' end,
  case when rc.calendar_age_snapshot >= 30 then 'no_movement_over_30' end,
  case when coalesce(rc.estimate_snapshot, 0) = 0 and rc.status_snapshot ilike '%payment%' then 'zero_estimate_payment_request' end,
  'operational_health',
  'financial_open_outstanding',
  'financial_estimate_total',
  'handler_performance'
]::text[], null)
where rc.report_run_id = (select id from target);

with target as (
  select id
  from public.scout_report_runs
  where domain = 'claims'
    and report_type = 'monthly'
    and (period_start at time zone 'Africa/Johannesburg')::date = date '2026-09-01'
)
update public.scout_report_action_items snapshot
set attention_item_id_snapshot = action.attention_item_id
from public.scout_management_actions action
where snapshot.report_run_id = (select id from target)
  and action.id = snapshot.action_id
  and action.attention_item_id is not null;

commit;
