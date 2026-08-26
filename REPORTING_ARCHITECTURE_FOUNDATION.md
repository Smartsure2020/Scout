# Scout reporting foundation — Phase 1

Status: Phase 1 foundation only. No reports UI, historical tables, migrations,
new endpoints, deployment changes, or team configuration changes are included.

## Authority and ownership

The claims page at `scout-smartsure/claims/index.html` points to the deployed
legacy claims API at `https://scout-backend.marketing-854.workers.dev`. That is
the current operational claims route based on repository evidence. Its
`scout_*` tables and auth/role lookup remain live and unchanged.

`worker.js` is treated as the separate briefing/history Worker. It owns the
newer `claims`, `claim_extracts`, `briefing_runs`, `briefing_deliveries`,
`digest_log`, and `scout_settings` path. It is not merged with or substituted
for the claims API in this phase.

The reusable domain layer in `reporting-domain/` is the future shared rules
authority. Phase 1 deliberately does not wire the large static claims page or
the briefing Worker to it because parity has not been proven for the Worker
and a live rewrite would change visible behavior. Future reporting must call
this layer rather than copy rules into a report endpoint or UI.

## Canonical contract

`reporting-domain/claims-contract.mjs` normalizes source aliases while keeping
identity and event provenance explicit:

- `databaseId`: trusted only when supplied by the database row;
- `sourceClaimNumber`: Cardinal/source identifier, not assumed globally unique;
- `canonicalClaimId`: nullable until a future identity decision is made;
- `sourceEventAt`: a source-provided event timestamp, if present;
- `extractEffectiveAt`: when the extract represents the source state;
- `firstObservedAt`: when Scout first saw the state;
- `observedBetween`: an interval between extracts when the source supplied no
  exact event time;
- `derivation`: `source` or a future explicit inferred value.

An observed change is not an exact event. For example, a reassignment seen in
Tuesday's extract but absent from Monday's extract is only “observed between
Monday and Tuesday” unless Cardinal supplies a timestamp. Phase 1 does not
fabricate IDs, event times, or historical transitions.

## Canonical operational rules

`reporting-domain/claims-rules.mjs` is deterministic and DOM-free. It includes:

- claims-page status normalization, terminal/open detection, the full current
  status/SLA category catalogue, and explicit unmapped status handling;
- working-day and calendar ageing, movement thresholds, and all six current
  Ready to Close rules;
- zero-estimate and estimate/outstanding conflicts;
- high-value/mandate, assessor/investigator/broker overdue, legal/recovery,
  NFO/Ombudsman, fraud, and repudiation expiry categories;
- structured priority/risk output without UI strings or CSS classes;
- rule version `claims-operations-rules-v1`.

SLA states are `on_track`, `stale`, `critical`, `unmapped`, `unknown`, or
`not_applicable`. Unmapped and unknown claims are not compliant, not breached,
and excluded from the denominator. A future compliance KPI must use
`compliant / (compliant + breached)` and report unmapped/unknown separately.

## Date semantics

- Time zone: `Africa/Johannesburg`.
- Internal timestamp ranges are half-open: `start <= timestamp < end`.
- Weekly period: Monday 00:00 local through Saturday 00:00 local; Friday is
  included and weekend activity is excluded.
- Monthly period: first local day through the first local day of the next
  month.
- Management ageing bands: `0-30`, `31-60`, `61-90`, `91+` calendar days.
- SLA ageing: working days using the existing claims-page calendar semantics.

The current claims-page holiday list is isolated in
`reporting-domain/date-periods.mjs` and has coverage only through 2027. Any
date range outside that coverage is surfaced as unsupported by default; the
library does not silently become weekday-only.

## Role and authorization foundation

`reporting-domain/roles.mjs` resolves active users, normalized roles, stable
database ID-or-email keys, handler scope, and manager/admin scope from rows
already obtained through the existing authenticated API. It does not verify
Microsoft tokens, add endpoints, or alter permissions. The legacy API remains
the server-side security boundary. No current handler names or name-to-email
maps are embedded in the domain layer.

## Documented rule drift

| Rule             | Claims UI behavior                                                              | Briefing Worker behavior                                                                     | Phase 1 treatment                                                                            |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Status catalogue | Full claims-page catalogue with case-insensitive lookup; explicit terminal list | Smaller duplicate terminal/payment/assessor marker sets and no equivalent full SLA catalogue | Canonical layer preserves claims-page behavior; Worker remains unchanged pending parity work |
| SLA ageing       | Working-day thresholds from status rules; repudiation excluded from generic SLA | Mostly flag heuristics based on `age` and text markers; no equivalent threshold catalogue    | Canonical layer owns the claims behavior; no live Worker rewrite                             |
| Movement         | Exact `>14` and `>30` calendar-day thresholds, excluding legal/terminal         | Same threshold intent but uses Worker-specific legal text matching                           | Canonical layer preserves the claims exclusion/category semantics                            |
| Ready to Close   | Six ordered rules, current `>` boundaries, recovery text check                  | Same six-rule shape but separate implementation and output fields                            | Canonical layer keeps the claims implementation; parity tests cover boundaries               |
| Zero estimate    | Uses mapped status category plus outstanding/paid values                        | Uses payment/status marker heuristics                                                        | Canonical layer keeps mapped-category behavior; Worker remains unchanged                     |
| Priority         | Tiered scores and flags with status SLA rules                                   | Count-of-flags score plus age/value bonuses                                                  | Canonical layer exposes structured claims-page-derived scoring; Worker migration is later    |
| History          | Browser local extract history and derived change labels are heuristic           | Extract/briefing tables exist, but are a separate data path                                  | No historical claims are treated as trustworthy in Phase 1                                   |

## Current source and Phase 2 boundary

The current handler and role source remains the active `scout_users` lookup in
the legacy API, with handler scope based on the authenticated user's email.
The old frontend `DEFAULT_HANDLERS` and hardcoded name-to-email resolver are
not authoritative for reporting and were not copied into this foundation.

Historical reporting remains unsupported as a trustworthy capability: current
extract comparisons can identify an observed difference, not the exact time a
claim changed or who changed it.

The smallest safe Phase 2 boundary is **Immutable Extract Snapshots +
Provenance-Aware Claim History**: first agree the authoritative claims route,
stable identity strategy, extract effective timestamp, immutable snapshot
retention, and source-vs-derived provenance. Only then should historical
period KPIs or event-like views be built. The Phase 2 foundation now lives in
`reporting-domain/history.mjs`, the additive migration
`supabase/migrations/20260825114848_reporting_history_foundation.sql`, and the legacy API's
manager/admin-only history verification routes. No report KPI engine or UI is
included.

## Phase 2 historical contract

The legacy `/upload` path remains the current-state operational write path.
Accepted uploads now follow this conceptual sequence:

```text
source payload → checksum/quality gate → immutable manifest
              → normalized snapshot rows → observed changes
              → existing scout_claims/scout_extracts update
```

The historical tables are additive:

- `scout_history_extracts` stores manifest, checksum, source/effective/received
  time semantics, quality, previous/correction lineage, and lifecycle state;
- `scout_history_claims` stores stable source-scoped identities;
- `scout_history_snapshots` stores one normalized row per source row per
  accepted extract, including recoverable source evidence and rule-versioned
  derived classifications;
- `scout_history_changes` stores append-only provenance-aware observations.

The upload API hashes the canonical claims JSON payload with SHA-256 when a
source-file checksum is not supplied. This is explicitly recorded as
`checksum_basis = claims-json-payload`; filenames are never used for
idempotency. Exact duplicate payloads are acknowledged without creating a new
manifest. A different payload on the same nominal extract date creates a new
manifest and may link to the prior version through correction lineage.

`effective_at` is populated only when the source supplies an explicit
timestamp. A date-only `extractDate` is stored as `effective_date` with
`effective_precision = source_date`. `received_at` is the server receipt time
and is never substituted for source effective time.

Unique source-scoped claim numbers receive a durable `scout_history_claims.id`
and a matchable source-system identity key. Duplicate claim numbers within an
extract receive separate non-matchable identity rows and a data-quality
ambiguity flag; they are never silently merged. Source claim number, source row
identity, and source evidence remain preserved.

Observed changes include `first_observed`, `status_changed`,
`handler_changed`, `movement_changed`, `estimate_changed`,
`outstanding_changed`, `paid_changed`, `mandate_changed`,
`terminal_transition_observed`, `reopened`, and `missing_from_extract`.
Changes without an explicit source timestamp use
`provenance = extract_observed` and `timestamp_precision = between_extracts`
(or `source_date` for a changed source date). Terminal transitions use
`system_derived`; no exact closure or assignment timestamp is fabricated.

Missing claims produce `missing_from_extract` only after a comparable,
complete extract passes the row-count safety gate. Missing claims never produce
an automatic closure event. A material row-count drop marks the extract
incomplete and suppresses disappearance generation. The default 50% drop guard
is an operational safety default and can be configured with
`HISTORY_MAX_ROW_COUNT_DROP_RATIO`.

The historical persistence path is service-role-only and the API exposes only
manager/admin verification routes: `/history/latest`, `/history/extracts`,
`/history/extracts/:id`, and `/history/claims/:id`. Raw source evidence is not
returned by these routes. Handlers do not gain cross-handler history access.

No pre-Phase-2 backfill is performed. From the implementation date forward,
preserved snapshot inventory, ownership, status, ageing, and deterministic
flags can be evaluated at extract precision. Exact assignment, closure,
payment-request, and payment-release times remain unavailable unless Cardinal
supplies them.

## Phase 3 deterministic report contract

Phase 3 adds a claims-only metric engine in
`reporting-domain/reporting-metrics.mjs` and persists its server-generated
results in `scout_report_runs` and `scout_report_run_claims` through the
additive migration `supabase/migrations/20260825122259_reporting_runs_foundation.sql`.
No Reports frontend, PDF renderer, AI commentary, Management Attention, or
Action Plan model is part of this phase.

The engine accepts only accepted Phase 2 manifests, immutable snapshots, and
observed changes. It never reads `scout_claims` to calculate a report. Weekly
periods are Monday 00:00 through Saturday 00:00 in Africa/Johannesburg;
monthly periods are local calendar months. Both use half-open activity
boundaries and store canonical UTC instants derived from those local periods.

For each state boundary, selection is deterministic:

1. discard rejected, incomplete, hard-rejected, wrong-scope, or future
   manifests;
2. use `effective_at` when source-exact, otherwise local-midnight
   `effective_date`, otherwise `received_at`;
3. keep candidates at or before the requested boundary;
4. when a correction lineage record supersedes an applicable extract, discard
   the superseded version;
5. choose the latest remaining candidate, with receipt time and ID as stable
   tie-breakers.

No suitable extract produces `partial` or `insufficient` coverage; it never
falls back to current live state. State metrics carry `snapshot_exact`
precision. Source-dated registration carries `source_date` precision.
Terminal transitions, first observation, and assignment changes carry
`observed_period` precision unless the source explicitly supplies an event
timestamp. Mixed populations are marked `mixed`; unsupported payment flow
metrics are `unavailable`.

The report snapshot separates state from activity. Opening/closing inventory,
ageing, SLA, movement, Ready to Close, operational health, handler ownership,
and supported financial totals are evaluated from the selected boundary
snapshots. Registration, first observation, terminal transitions, and handler
changes are evaluated from period changes or period-observed snapshots.
Disappearance is never closure, and net movement is always closing inventory
minus opening inventory.

Every persisted report records metric, claims-rule, history-quality, and report
schema versions, the named 50% material row-drop configuration, coverage
metadata, boundary extract IDs, metric output, and normalized claim
populations. Drafts may be regenerated deterministically. Finalisation freezes
metrics, populations, coverage, versions, period, scope, and extract
references; only an explicit archive lifecycle transition remains. Database
triggers protect finalised report runs and their claim populations from
ordinary mutation.

The Phase 3 server routes are manager/admin-only and service-role-backed:
`POST /reports/generate`, `GET /reports`, `GET /reports/:id`,
`POST /reports/:id/regenerate`, `POST /reports/:id/finalise`,
`POST /reports/:id/archive`, and
`GET /reports/:id/metrics/:metricId/claims`. The browser receives structured
server results and never calculates management KPIs. Drill-through reads the
frozen report-time context and remains behind current server authorization.
