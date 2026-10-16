# Reporting release hygiene

## Version guard release order

The report generation trigger migration is required because an already deployed v2 Worker cannot be changed retroactively. Apply `20261016120000_report_engine_generation_guard.sql` before serving the updated backend: the backend report list selects its new `finalised_engine_version` column. The migration changes no existing rows. Once applied, a rollback to the old v2 Worker can still read and export frozen reports, but attempts to overwrite or finalise a v3 draft fail at the database boundary. The current backend returns a clear 409 for incompatible drafts. Verify the migration in a non-production database before the controlled release; this pass does not apply it.

## Deferred work register

These items are deliberately outside the current reporting hygiene pass.

| Item                                                                 | Next work                                                                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GitHub issue #25](https://github.com/Smartsure2020/Scout/issues/25) | Align briefing worker terminal and payment taxonomy.                                                                                                  |
| Incomplete historical extract artefacts                              | Investigate the incomplete 6 October lineage and stuck upload; preserve source and accepted extract evidence.                                         |
| Incorrect finalised 5–9 October report                               | Implement the audited supersession mechanism below before creating a corrected replacement. Do not edit the existing report.                          |
| Visual and UX audit                                                  | Review Reports, Overview, Claims and Exceptions in a separate pass.                                                                                   |
| Management reporting enhancements                                    | Consider insurer distribution, brokerage distribution, high-value claim details and zero-estimate closure candidates in a separate reporting release. |

## Design only: audited supersession of a finalised report

The current unique key on `scout_report_runs` permits one row per domain, type, period and scope. Finalised snapshots and claim populations are immutable; archiving does not release that key. The 5–9 October report therefore cannot be corrected by an ordinary Generate or Regenerate call.

### Minimal data change

Add nullable `supersedes_report_id uuid references scout_report_runs(id) on delete restrict` and a required `supersession_reason` for replacement rows. Keep the original row and its claim population untouched. Replace the existing five-column unique constraint with two constraints: a partial unique index on the same five columns for root rows (`supersedes_report_id is null`), and a unique index on non-null `supersedes_report_id` to prevent two direct successors. A trigger must require the referenced report to be finalised or archived, require the same logical key, and reject cycles. A chain is allowed only by superseding its current head. The current head is the report with no successor in its chain; it is derived, not stored on an older immutable row.

### API and lifecycle

Add an admin-only `POST /reports/:id/supersede` that requires a reason, confirms the target is the current finalised or archived head, then creates a new **draft** with a new ID, the same logical period and scope, and `supersedes_report_id` set to the target. Generation uses accepted extract evidence and the current report engine; it does not copy or rewrite the old frozen metrics. Ordinary Generate remains a conflict when the logical slot already has a current report. Regenerate and Finalise apply to the replacement draft under the existing lifecycle and engine guards. The creation and lineage check should be transactional so concurrent requests cannot fork the chain; the unique successor index is the final race guard. Record actor, reason, target and replacement ID in the audit log as well as on the replacement row.

`GET /reports` returns all rows and lineage fields. Current selection resolves the unsuperseded head for each logical key. `GET /reports/:id`, PDF export and historical drill-through continue to address the exact ID and frozen evidence, including superseded originals.

### UI

Weekly and Monthly display the current head for each period. History includes both versions: the replacement is marked **Current replacement** and the original **Superseded by [replacement]**, with a direct link to each. A direct link to the original remains valid and shows a visible superseded notice without changing its content or PDF.

### Migration and verification

The migration must contain no report-row DML, backfill or deletion. Create and validate the new lineage constraints, then replace the old logical-key constraint in one controlled migration; check the actual constraint name and existing duplicate state first. Deploy the schema before the API and UI change. Do not create the 5–9 October replacement as part of that deployment.

Tests must cover one root per logical key, one successor per head, key/status/cycle rejection, concurrent supersession attempts, immutable original metrics and claims, correct current-head selection, both History labels, old direct links and PDF export, and Finalise of the replacement draft. Production reconciliation should verify all existing report IDs and frozen values are unchanged before any replacement is created.
