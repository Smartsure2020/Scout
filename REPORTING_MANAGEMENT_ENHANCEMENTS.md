# Management reporting enhancements

This release adds a management-first report layout. Values are calculated by
`buildReportSnapshot`, frozen in `metrics_snapshot`, and rendered without live
claim queries at PDF-download time. It does not change claim status or mutate
claims.

## Source and grouping rules

- Cardinal `Broker` is canonical `broker`: surrounding whitespace is trimmed;
  blank becomes null; case, punctuation, and internal spacing are preserved.
- For management reporting, claims whose claim number begins `REN0002` are
  grouped as `Renault`. Scout retains the original Cardinal Broker value for
  source evidence and drill-down. This is an approved deterministic business
  mapping, not fuzzy normalization. Location names are not used, and
  non-REN0002 claims retain their exact Broker values.
- Insurer and broker distributions use the accepted closing open-claim
  population. Counts reconcile exactly to closing inventory; percentages use
  deterministic integer basis-point allocation; financial totals aggregate in
  integer cents. Ambiguous multi-row financial sections are not summed.
- Collision warnings for case or whitespace variants are informational only;
  exact source values remain separate. Literal source values named `Other` or
  `Unknown / Unmapped` remain distinct from synthetic reporting buckets.

## Extract capture and frozen history

Broker header presence and populated-row count are persisted in extract source
metadata/quality. A missing header is a non-blocking ingestion warning. If the
closing extract did not capture Broker, brokerage distribution is unavailable
and the PDF says: “Broker was not captured in this source extract.” A captured
header with blank row values continues to use Unknown / Unmapped. Historical
extracts and frozen reports are not backfilled: reports whose closing extract
predates Worker/Broker capture will not gain Broker automatically.

For management reporting, claims whose claim number begins REN0002 are grouped
as Renault. Scout retains the original Cardinal Broker value for source
evidence and drill-down.

## Management exceptions and display

- High value means known Outstanding at or above R100,000. Ambiguous multi-row
  claims appear under `High-value items requiring review`, with each section
  amount, largest section, and “Sections straddle threshold / additive
  semantics unresolved”; section amounts are not summed.
- The section `Zero-estimate claims requiring review` separates ready-to-close
  candidates from Estimate / reserve review. A payment status plus a zero Own
  Damage Original Estimate is not closure evidence. No claim state is changed.
- Brokerage PDF shows the top 10 non-blank reporting groups, keeps Unknown /
  Unmapped separate, and groups the rest as `Other (N values)`. Top-N cutoff
  ties and value collisions are disclosed. The frozen report stores the full
  distribution and source Broker evidence.
- PDF template v9 was the committed baseline. The in-progress management
  template advanced to v11 while adding management pages/sections; v10 was not
  a released artifact. This remediation labels the corrected real-volume
  template v12. Historical v3 report snapshots remain renderable; current
  management snapshots use report engine/schema v4. A v3 Worker fails closed
  rather than regenerating a v4 draft.

## Controlled rollout order

1. Apply the additive migrations in the controlled release window:
   `20261019120000_cardinal_broker_source.sql`,
   `20261020063354_broker_reporting_group_snapshot.sql`, and
   `20261020072523_report_engine_v4_generation_guard.sql` (after the existing
   workflow-table schema migration).
2. Probe `scout_claims.broker`, `scout_history_snapshots.broker`,
   `scout_report_run_claims.broker_snapshot`, and
   `scout_report_run_claims.broker_reporting_group_snapshot`.
3. Deploy the Worker.
4. Deploy the frontend.
5. Upload the next Cardinal extract.
6. Verify Broker was captured and the populated count is plausible.
7. Regenerate the draft.
8. Complete real-volume PDF acceptance.
9. Finalise.

Adding `broker:null` changes claims-json-payload checksums across deployment.
A same-date re-upload across that boundary may be treated as a correction
rather than a duplicate; check correction lineage before retrying. No old
history is backfilled.
