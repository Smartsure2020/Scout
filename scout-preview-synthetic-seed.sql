-- Synthetic Scout acceptance seed for the isolated scout-ux project.
-- No production rows are read or copied by this script.
-- The approved Azure tester email is supplied at load time and is not stored in this repository.
begin;

-- The preview directory contains only the designated acceptance user.
insert into public.scout_users (
  id, email, display_name, role, active, portal
) values (
  '10000000-0000-0000-0000-000000000001',
  :'SCOUT_PREVIEW_TESTER_EMAIL',
  'Synthetic Acceptance Manager',
  'admin',
  true,
  'both'
)
on conflict (id) do nothing;

-- Two extracts support current-state and historical comparison screens.
insert into public.scout_extracts (
  id, extract_date, uploaded_by, claim_count, file_name
) values
  ('11000000-0000-0000-0000-000000000001', '2026-09-02', 'synthetic-qa', 10, 'synthetic-qa-previous.csv'),
  ('11000000-0000-0000-0000-000000000002', '2026-09-03', 'synthetic-qa', 12, 'synthetic-qa-current.csv')
on conflict (id) do nothing;

insert into public.scout_claims (
  id, extract_date, claim_no, handler_email, handler_name, insured_name,
  insured_masked, status, age_days, peril, peril_type, insurer, outstanding,
  description, dol, registered_date, comments, priority_score, priority_flags,
  recommended_action
) values
  ('20000000-0000-0000-0000-000000000001', '2026-09-03', 'QA-0001', 'alex@synthetic.invalid', 'Alex Handler', 'Synthetic Insured 01', 'S********** 01', 'Awaiting Assessor Report', 22, 'Storm', 'Weather', 'Synthetic Mutual', 28000, 'Synthetic assessor response case.', '2026-08-11', '2026-08-12', 'Synthetic QA context only.', 86, '{"ageing":true,"assessor_overdue":true}', 'Obtain assessor report'),
  ('20000000-0000-0000-0000-000000000002', '2026-09-03', 'QA-0002', 'blair@synthetic.invalid', 'Blair Handler', 'Synthetic Insured 02', 'S********** 02', 'Over Mandate', 8, 'Water damage', 'Escape of water', 'QA General', 225000, 'Synthetic high-value authority case.', '2026-08-25', '2026-08-26', 'Synthetic QA context only.', 98, '{"mandate":true,"high_value":true}', 'Escalate for authority review'),
  ('20000000-0000-0000-0000-000000000003', '2026-09-03', 'QA-0003', 'casey@synthetic.invalid', 'Casey Handler', 'Synthetic Insured 03', 'S********** 03', 'In Progress', 42, 'Vehicle collision', 'Motor', 'Example Assurance', 145000, 'Synthetic high-value claim requiring review.', '2026-07-23', '2026-08-26', 'Synthetic QA context only.', 92, '{"ageing":true,"high_value":true}', 'Review movement and authority'),
  ('20000000-0000-0000-0000-000000000004', '2026-09-03', 'QA-0004', 'devon@synthetic.invalid', 'Devon Handler', 'Synthetic Insured 04', 'S********** 04', 'Awaiting Authorisation', 18, 'Fire', 'Property', 'Synthetic Mutual', 74000, 'Synthetic authorisation case.', '2026-08-16', '2026-08-17', 'Synthetic QA context only.', 80, '{"authorisation":true}', 'Obtain authorisation decision'),
  ('20000000-0000-0000-0000-000000000005', '2026-09-03', 'QA-0005', 'evan@synthetic.invalid', 'Evan Handler', 'Synthetic Insured 05', 'S********** 05', 'Payment - Pending Approval', 22, 'Theft', 'Contents',  'QA General', 0, 'Synthetic zero-estimate payment case.', '2026-08-11', '2026-08-12', 'Synthetic QA context only.', 88, '{"zero_estimate":true,"payment":true}', 'Validate estimate before payment'),
  ('20000000-0000-0000-0000-000000000006', '2026-09-03', 'QA-0006', 'alex@synthetic.invalid', 'Alex Handler', 'Synthetic Insured 06', 'S********** 06', 'Repairs in Progress', 12, 'Water damage', 'Escape of water', 'Example Assurance', 18500, 'Synthetic repair progress case.', '2026-08-23', '2026-08-24', 'Synthetic QA context only.', 55, '{"movement_due":true}', 'Confirm repair progress'),
  ('20000000-0000-0000-0000-000000000007', '2026-09-03', 'QA-0007', 'blair@synthetic.invalid', 'Blair Handler', 'Synthetic Insured 07', 'S********** 07', 'Payment Released', 21, 'Storm', 'Weather', 'Synthetic Mutual', 0, 'Synthetic terminal payment case.', '2026-08-14', '2026-08-15', 'Synthetic QA context only.', 24, '{"terminal":true}', 'Complete closure checks'),
  ('20000000-0000-0000-0000-000000000008', '2026-09-03', 'QA-0008', 'casey@synthetic.invalid', 'Casey Handler', 'Synthetic Insured 08', 'S********** 08', 'Registered', 1, 'Vehicle collision', 'Motor', 'QA General', 9200, 'Synthetic newly registered claim.', '2026-09-02', '2026-09-02', 'Synthetic QA context only.', 30, '{"new_claim":true}', 'Complete initial triage'),
  ('20000000-0000-0000-0000-000000000009', '2026-09-03', 'QA-0009', 'devon@synthetic.invalid', 'Devon Handler', 'Synthetic Insured 09', 'S********** 09', 'Repudiated - Awaiting Closure', 12, 'Fire', 'Property', 'Example Assurance', 0, 'Synthetic repudiation closure case.', '2026-08-22', '2026-08-23', 'Synthetic QA context only.', 64, '{"repudiation":true}', 'Confirm closure documentation'),
  ('20000000-0000-0000-0000-000000000010', '2026-09-03', 'QA-0010', 'evan@synthetic.invalid', 'Evan Handler', 'Synthetic Insured 10', 'S********** 10', 'Closed Paid', 8, 'Theft', 'Contents', 'Synthetic Mutual', 0, 'Synthetic completed claim.', '2026-08-26', '2026-08-27', 'Synthetic QA context only.', 5, '{"terminal":true}', 'No action'),
  ('20000000-0000-0000-0000-000000000011', '2026-09-03', 'QA-0011', 'alex@synthetic.invalid', 'Alex Handler', 'Synthetic Insured 11', 'S********** 11', 'Awaiting Broker Feedback', 15, 'Storm', 'Weather', 'QA General', 32000, 'Synthetic broker feedback case.', '2026-08-19', '2026-08-20', 'Synthetic QA context only.', 71, '{"broker_overdue":true}', 'Obtain broker feedback'),
  ('20000000-0000-0000-0000-000000000012', '2026-09-03', 'QA-0012', 'blair@synthetic.invalid', 'Blair Handler', 'Synthetic Insured 12', 'S********** 12', 'Payment Requested', 10, 'Water damage', 'Escape of water', 'Example Assurance', 18000, 'Synthetic payment-stage case.', '2026-08-24', '2026-08-24', 'Synthetic QA context only.', 68, '{"payment":true,"zero_estimate":true}', 'Validate payment request'),
  ('20000000-0000-0000-0000-000000000013', '2026-09-03', 'QA-0013', 'casey@synthetic.invalid', 'Casey Handler', 'Synthetic Insured 13', 'S********** 13', 'In Progress', 3, 'Fire', 'Property', 'Synthetic Mutual', 12000, 'Synthetic recent claim.', '2026-08-31', '2026-08-31', 'Synthetic QA context only.', 20, '{"new_claim":true}', 'Continue assessment'),
  ('20000000-0000-0000-0000-000000000014', '2026-09-03', 'QA-0014', 'devon@synthetic.invalid', 'Devon Handler', 'Synthetic Insured 14', 'S********** 14', 'Awaiting Claim Form', 16, 'Vehicle collision', 'Motor', 'QA General', 26000, 'Synthetic missing-document case.', '2026-08-18', '2026-08-18', 'Synthetic QA context only.', 76, '{"documents":true}', 'Obtain claim form')
on conflict (id) do nothing;

-- History identities are synthetic and do not contain production claim numbers.
insert into public.scout_history_claims (
  id, source_system, source_claim_number, identity_key, identity_confidence,
  identity_matchable, identity_note
)
select
  ('30000000-0000-0000-0000-' || lpad(gs::text, 12, '0'))::uuid,
  'synthetic-qa',
  'QA-' || lpad(gs::text, 4, '0'),
  'synthetic-qa-' || lpad(gs::text, 4, '0'),
  'source_scoped',
  true,
  'Synthetic acceptance identity'
from generate_series(1, 14) gs
on conflict (id) do nothing;

insert into public.scout_history_extracts (
  id, source_system, source_file_name, source_checksum, checksum_algorithm,
  checksum_basis, effective_at, effective_date, effective_precision, received_at,
  uploaded_by_email, uploaded_by_user_id, time_zone, schema_version, claim_count,
  accepted_claim_count, rejected_claim_count, quality_summary, previous_extract_id,
  source_metadata, status, historical_persisted, current_state_updated
) values
  ('31000000-0000-0000-0000-000000000001', 'synthetic-qa', 'synthetic-qa-previous.csv', 'synthetic-checksum-previous', 'sha-256', 'fixture', '2026-09-02T06:30:00+02:00', '2026-09-02', 'exact_timestamp', '2026-09-02T06:30:00+02:00', 'synthetic-qa', '10000000-0000-0000-0000-000000000001', 'Africa/Johannesburg', 'synthetic-qa-v1', 10, 10, 0, '{"issueCount":0,"warnings":[]}', null, '{"fixture":true}', 'accepted', true, true),
  ('31000000-0000-0000-0000-000000000002', 'synthetic-qa', 'synthetic-qa-current.csv', 'synthetic-checksum-current', 'sha-256', 'fixture', '2026-09-03T06:30:00+02:00', '2026-09-03', 'exact_timestamp', '2026-09-03T06:30:00+02:00', 'synthetic-qa', '10000000-0000-0000-0000-000000000001', 'Africa/Johannesburg', 'synthetic-qa-v1', 14, 14, 0, '{"issueCount":0,"warnings":[]}', '31000000-0000-0000-0000-000000000001', '{"fixture":true}', 'accepted', true, true)
on conflict (id) do nothing;

insert into public.scout_history_snapshots (
  extract_id, claim_id, identity_key, identity_matchable, identity_confidence,
  source_row_identity, source_row_index, source_claim_number, handler_source,
  handler_email, status_raw, status_normalized, terminal, open, operational_category,
  registered_date, dol_date, movement_date, source_event_at, outstanding, estimate,
  paid, mandate, insurer, peril, peril_type, insured, description, comments,
  calendar_age, working_age, age_band, rule_version, priority_score, priority_band,
  priority_flags, operational_flags, data_quality_flags, source_evidence
)
select
  '31000000-0000-0000-0000-000000000002'::uuid,
  hc.id,
  hc.identity_key,
  true,
  hc.identity_confidence,
  hc.identity_key,
  row_number() over (order by hc.source_claim_number)::integer,
  hc.source_claim_number,
  'synthetic-qa',
  c.handler_email,
  c.status,
  c.status,
  c.status in ('Closed Paid', 'Payment Released'),
  c.status not in ('Closed Paid', 'Payment Released'),
  case when c.status in ('Closed Paid', 'Payment Released') then 'terminal' else 'open' end,
  c.registered_date,
  c.dol,
  c.registered_date + greatest(c.age_days - 2, 0),
  '2026-09-03T06:30:00+02:00',
  c.outstanding,
  case when c.outstanding = 0 then 0 else round(c.outstanding * 1.12, 2) end,
  case when c.status in ('Closed Paid', 'Payment Released') then c.outstanding else 0 end,
  case when c.status = 'Over Mandate' then c.outstanding else 0 end,
  c.insurer,
  c.peril,
  c.peril_type,
  c.insured_masked,
  c.description,
  c.comments,
  c.age_days,
  greatest(c.age_days - 2, 0),
  case when c.age_days <= 30 then '0-30' when c.age_days <= 60 then '31-60' else '61-90' end,
  'synthetic-qa-v1',
  c.priority_score,
  case when c.priority_score >= 85 then 'P1' when c.priority_score >= 70 then 'P2' else 'P3' end,
  c.priority_flags,
  jsonb_build_object('synthetic', true),
  '{}'::jsonb,
  jsonb_build_object('source', 'synthetic-qa')
from public.scout_history_claims hc
join public.scout_claims c on c.claim_no = hc.source_claim_number
where hc.source_claim_number <> 'QA-0010'
on conflict do nothing;

insert into public.scout_history_snapshots (
  extract_id, claim_id, identity_key, identity_matchable, identity_confidence,
  source_row_identity, source_row_index, source_claim_number, handler_source,
  handler_email, status_raw, status_normalized, terminal, open, operational_category,
  registered_date, dol_date, movement_date, source_event_at, outstanding, estimate,
  paid, mandate, insurer, peril, peril_type, insured, description, comments,
  calendar_age, working_age, age_band, rule_version, priority_score, priority_band,
  priority_flags, operational_flags, data_quality_flags, source_evidence
)
select
  '31000000-0000-0000-0000-000000000001'::uuid,
  hc.id,
  hc.identity_key,
  true,
  hc.identity_confidence,
  hc.identity_key,
  row_number() over (order by hc.source_claim_number)::integer,
  hc.source_claim_number,
  'synthetic-qa',
  c.handler_email,
  case when c.status = 'In Progress' then 'Awaiting Claim Form' else c.status end,
  case when c.status = 'In Progress' then 'Awaiting Claim Form' else c.status end,
  false,
  true,
  'open',
  c.registered_date - 1,
  c.dol - 1,
  c.registered_date + greatest(c.age_days - 3, 0),
  '2026-09-02T06:30:00+02:00',
  greatest(c.outstanding - 5000, 0),
  greatest(round(c.outstanding * 1.05, 2), 0),
  0,
  0,
  c.insurer,
  c.peril,
  c.peril_type,
  c.insured_masked,
  c.description,
  c.comments,
  greatest(c.age_days - 1, 0),
  greatest(c.age_days - 3, 0),
  case when c.age_days <= 30 then '0-30' when c.age_days <= 60 then '31-60' else '61-90' end,
  'synthetic-qa-v1',
  greatest(c.priority_score - 4, 0),
  case when c.priority_score >= 85 then 'P1' when c.priority_score >= 70 then 'P2' else 'P3' end,
  c.priority_flags,
  jsonb_build_object('synthetic', true),
  '{}'::jsonb,
  jsonb_build_object('source', 'synthetic-qa')
from public.scout_history_claims hc
join public.scout_claims c on c.claim_no = hc.source_claim_number
where c.claim_no in ('QA-0001','QA-0002','QA-0003','QA-0004','QA-0005','QA-0006','QA-0007','QA-0008','QA-0009','QA-0011')
on conflict do nothing;

insert into public.scout_history_changes (
  claim_id, change_type, source_extract_id, previous_extract_id, old_value,
  new_value, source_event_at, first_observed_at, observed_after, observed_at,
  provenance, timestamp_precision, derived_by_version, dedupe_key
)
select
  hc.id,
  case when hc.source_claim_number = 'QA-0002' then 'estimate_changed' else 'status_changed' end,
  '31000000-0000-0000-0000-000000000002'::uuid,
  '31000000-0000-0000-0000-000000000001'::uuid,
  case when hc.source_claim_number = 'QA-0002' then '{"estimate":42000}'::jsonb else '{"status":"Awaiting Claim Form"}'::jsonb end,
  case when hc.source_claim_number = 'QA-0002' then '{"estimate":252000}'::jsonb else '{"status":"Over Mandate"}'::jsonb end,
  '2026-09-03T06:30:00+02:00',
  '2026-09-02T06:30:00+02:00',
  '2026-09-02T06:30:00+02:00',
  '2026-09-03T06:30:00+02:00',
  'extract_observed',
  'extract_effective_time',
  'synthetic-qa-v1',
  'synthetic-qa-' || hc.source_claim_number || '-change'
from public.scout_history_claims hc
where hc.source_claim_number in ('QA-0001', 'QA-0002')
on conflict (dedupe_key) do nothing;

-- Report runs are created in draft state so claim snapshots can be populated
-- before the lifecycle checks allow finalisation and archiving.
insert into public.scout_report_runs (
  id, domain, report_type, period_start, period_end, time_zone, status,
  scope_key, scope, coverage_status, coverage_metadata,
  metric_definition_version, claims_rule_version, quality_rule_version,
  report_schema_version, finalised_at, archived_at
) values
  ('40000000-0000-0000-0000-000000000001', 'claims', 'weekly', '2026-08-24T00:00:00+02:00', '2026-08-30T23:59:59+02:00', 'Africa/Johannesburg', 'draft', 'all', '{}', 'complete', '{"synthetic":true,"warnings":[]}', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', null, null),
  ('40000000-0000-0000-0000-000000000002', 'claims', 'monthly', '2026-09-01T00:00:00+02:00', '2026-09-30T23:59:59+02:00', 'Africa/Johannesburg', 'draft', 'all', '{}', 'usable_with_warnings', '{"synthetic":true,"warnings":["synthetic_fixture"]}', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', null, null),
  ('40000000-0000-0000-0000-000000000003', 'claims', 'weekly', '2026-08-17T00:00:00+02:00', '2026-08-23T23:59:59+02:00', 'Africa/Johannesburg', 'draft', 'all', '{}', 'complete', '{"synthetic":true,"warnings":[]}', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', 'synthetic-qa-v1', null, null)
on conflict (id) do nothing;

insert into public.scout_management_attention (
  id, domain, claim_id, source_claim_number_snapshot, title, management_note,
  category, priority, owner_user_id, owner_display_snapshot, next_action,
  due_date, status, created_by, updated_by, originating_report_id
) values
  ('50000000-0000-0000-0000-000000000001', 'claims', '30000000-0000-0000-0000-000000000002', 'QA-0002', 'Authority review required', 'Synthetic high-value authority case.', 'mandate_high_value', 'high', '10000000-0000-0000-0000-000000000001', 'Synthetic Acceptance Manager', 'Review authority and next decision.', '2026-09-05', 'open', 'synthetic-qa', 'synthetic-qa', '40000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000002', 'claims', '30000000-0000-0000-0000-000000000005', 'QA-0005', 'Estimate validation required', 'Synthetic zero-estimate payment case.', 'payment', 'medium', '10000000-0000-0000-0000-000000000001', 'Synthetic Acceptance Manager', 'Validate estimate before payment.', '2026-09-06', 'monitoring', 'synthetic-qa', 'synthetic-qa', '40000000-0000-0000-0000-000000000002')
on conflict (id) do nothing;

insert into public.scout_management_actions (
  id, domain, action, category, claim_id, source_claim_number_snapshot,
  attention_item_id, owner_user_id, owner_display_snapshot, due_date, status,
  created_by, updated_by, originating_report_id, resolution_note
) values
  ('60000000-0000-0000-0000-000000000001', 'claims', 'Obtain authority decision', 'management', '30000000-0000-0000-0000-000000000002', 'QA-0002', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Synthetic Acceptance Manager', '2026-09-05', 'open', 'synthetic-qa', 'synthetic-qa', '40000000-0000-0000-0000-000000000002', null),
  ('60000000-0000-0000-0000-000000000002', 'claims', 'Validate estimate', 'payment', '30000000-0000-0000-0000-000000000005', 'QA-0005', '50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Synthetic Acceptance Manager', '2026-09-06', 'in_progress', 'synthetic-qa', 'synthetic-qa', '40000000-0000-0000-0000-000000000002', null)
on conflict (id) do nothing;

insert into public.scout_notes (claim_no, note, saved_by, saved_at)
values ('QA-0001', 'Synthetic acceptance note; no production record.', 'synthetic-qa', '2026-09-03T07:00:00+02:00')
on conflict do nothing;

insert into public.scout_notifications (
  id, recipient_user_id, actor_user_id, actor_display_name, type, claim_number,
  title, message, created_at, read_at
) values (
  '70000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Synthetic Acceptance Manager',
  'claim_note_added',
  'QA-0002',
  'Synthetic attention item',
  'Synthetic acceptance notification only.',
  '2026-09-03T07:05:00+02:00',
  null
)
on conflict (id) do nothing;

insert into public.scout_report_run_claims (
  report_run_id, claim_id, source_system, source_claim_number, identity_key,
  membership_reasons, handler_snapshot, handler_email_snapshot,
  status_snapshot, insurer_snapshot, peril_snapshot, registered_date_snapshot,
  calendar_age_snapshot, outstanding_snapshot, estimate_snapshot, relevant_flags
)
select
  '40000000-0000-0000-0000-000000000001'::uuid,
  hc.id,
  'synthetic-qa',
  c.claim_no,
  'synthetic-qa-' || c.claim_no,
  '["synthetic_acceptance"]'::jsonb,
  c.handler_name,
  c.handler_email,
  c.status,
  c.insurer,
  c.peril,
  c.registered_date,
  c.age_days,
  c.outstanding,
  case when c.outstanding = 0 then 0 else round(c.outstanding * 1.12, 2) end,
  c.priority_flags
from public.scout_claims c
join public.scout_history_claims hc on hc.source_claim_number = c.claim_no
on conflict do nothing;

insert into public.scout_report_run_claims (
  report_run_id, claim_id, source_system, source_claim_number, identity_key,
  membership_reasons, handler_snapshot, handler_email_snapshot,
  status_snapshot, insurer_snapshot, peril_snapshot, registered_date_snapshot,
  calendar_age_snapshot, outstanding_snapshot, estimate_snapshot, relevant_flags
)
select
  '40000000-0000-0000-0000-000000000002'::uuid,
  hc.id,
  'synthetic-qa',
  c.claim_no,
  'synthetic-qa-' || c.claim_no,
  '["synthetic_acceptance"]'::jsonb,
  c.handler_name,
  c.handler_email,
  c.status,
  c.insurer,
  c.peril,
  c.registered_date,
  c.age_days,
  c.outstanding,
  case when c.outstanding = 0 then 0 else round(c.outstanding * 1.12, 2) end,
  c.priority_flags
from public.scout_claims c
join public.scout_history_claims hc on hc.source_claim_number = c.claim_no
on conflict do nothing;

insert into public.scout_report_attention_items (
  report_run_id, attention_item_id, claim_id, claim_number_snapshot,
  title_snapshot, management_note_snapshot, category_snapshot, priority_snapshot,
  owner_user_id_snapshot, owner_display_snapshot, handler_snapshot,
  claim_status_snapshot, insurer_snapshot, next_action_snapshot,
  due_date_snapshot, status_snapshot, resolution_note_snapshot, display_order
)
select
  '40000000-0000-0000-0000-000000000002'::uuid,
  a.id,
  a.claim_id,
  a.source_claim_number_snapshot,
  a.title,
  a.management_note,
  a.category,
  a.priority,
  a.owner_user_id,
  a.owner_display_snapshot,
  c.handler_name,
  c.status,
  c.insurer,
  a.next_action,
  a.due_date,
  a.status,
  a.resolution_note,
  row_number() over (order by a.id)::integer
from public.scout_management_attention a
join public.scout_history_claims hc on hc.id = a.claim_id
join public.scout_claims c on c.claim_no = hc.source_claim_number
on conflict do nothing;

insert into public.scout_report_action_items (
  report_run_id, action_id, claim_id, claim_number_snapshot, action_snapshot,
  category_snapshot, owner_user_id_snapshot, owner_display_snapshot,
  handler_snapshot, claim_status_snapshot, insurer_snapshot, due_date_snapshot,
  status_snapshot, resolution_note_snapshot, display_order
)
select
  '40000000-0000-0000-0000-000000000002'::uuid,
  a.id,
  a.claim_id,
  a.source_claim_number_snapshot,
  a.action,
  a.category,
  a.owner_user_id,
  a.owner_display_snapshot,
  c.handler_name,
  c.status,
  c.insurer,
  a.due_date,
  a.status,
  a.resolution_note,
  row_number() over (order by a.id)::integer
from public.scout_management_actions a
join public.scout_history_claims hc on hc.id = a.claim_id
join public.scout_claims c on c.claim_no = hc.source_claim_number
on conflict do nothing;

update public.scout_report_runs
set status = 'finalised', finalised_at = '2026-08-31T08:00:00+02:00'
where id = '40000000-0000-0000-0000-000000000001'::uuid;

update public.scout_report_runs
set status = 'finalised', finalised_at = '2026-08-24T08:00:00+02:00'
where id = '40000000-0000-0000-0000-000000000003'::uuid;

update public.scout_report_runs
set status = 'archived', archived_at = '2026-08-25T08:00:00+02:00'
where id = '40000000-0000-0000-0000-000000000003'::uuid;

commit;
