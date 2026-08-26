# Scout management PDF export - Phase 6

Status: implementation complete in the repository. No production migration was
applied and no Worker was deployed.

## Architecture

The official export path is deliberately on-demand:

```text
Finalised or Archived report
        |
        v
Manager/Admin bearer authorization
        |
        v
Frozen metrics_snapshot + frozen workflow membership snapshots
        |
        v
Deterministic Weekly/Monthly HTML template
        |
        v
Cloudflare Browser Run quickAction("pdf")
        |
        v
PDF response -> browser download
```

The export never reads the current claims table, current live workflow rows, or
the current date to change a frozen result. It does not invoke AI. Finalised
workflow statuses, due dates, notes, owners, and carry-forward lineage are
rendered from the snapshot columns. Overdue state is not recalculated at
download time.

## Endpoint and authorization

`GET /reports/:reportId/pdf` is implemented in `scout backend.js`.

- Manager and Admin roles are allowed through the existing report authorization
  boundary. Handler roles are denied.
- Draft reports are rejected. Finalised and Archived reports are allowed as
  immutable snapshots.
- Reports with `insufficient` historical coverage are rejected.
- A missing Phase 5 workflow schema or missing Browser Run binding returns a
  safe `503` response; it does not produce a partial or unofficial PDF.
- The response is `application/pdf`, `Content-Disposition: attachment`,
  `Cache-Control: no-store`, and carries the template version, renderer
  version, and export timestamp in headers.
- Audit entries record requested, generated, and failed export attempts. Audit
  details contain report metadata and versions, not rendered HTML or claim
  rows.

## Template

`reporting-domain/claims-report-pdf.mjs` provides the deterministic view model
and a complete semantic HTML document. Weekly and Monthly reports use the same
professional template but their own direct snapshot metrics and period labels.

The fixed section order is:

1. Executive Summary
2. Claims Movement and Management Ageing
3. SLA Performance
4. Operational Health
5. Handler Performance
6. Activity & Changes
7. Financial Position
8. Management Attention
9. Action Plan
10. Coverage & Methodology

The print stylesheet uses A4 landscape, restrained Scout colours, system fonts,
repeatable table headers, page-safe rows, CSS bars for ageing/SLA, and explicit
unavailable states. Zero is rendered as `0`; unavailable values are rendered as
`Data unavailable` and are never coerced to zero.

All free text is HTML-escaped. The PDF does not include raw database IDs, raw
source rows, or manager email addresses. Claim numbers can appear where they
are part of a frozen management attention/action context.

Template version: `claims-management-pdf-v1`  
Renderer version: `cloudflare-browser-run-quick-action`

## Wrangler configuration

The repository already has a separate `worker.js` briefing/history Worker. Its
existing `wrangler.jsonc` remains unchanged as the briefing deployment target.
The reporting API has its own configuration:

- `wrangler.reporting.jsonc`
- `main`: `scout backend.js`
- Browser Run binding: `env.BROWSER` from `"browser": { "binding": "BROWSER" }`
- Compatibility date remains `2026-05-28`, which is already within the
  Browser Run Quick Actions compatibility requirement.

The static site `.git` directory is excluded from asset collection by
`scout-smartsure/.assetsignore` so the dry-run can safely package the dashboard.

## Storage decision

Phase 6 uses on-demand generation and does not persist PDF bytes. There is no
R2 bucket, Supabase Storage object, export table, retention policy, or download
history added. Version and timestamp metadata are carried in response headers
and audit records. This keeps the first export path reversible and avoids
creating a second source of truth for a PDF that is derived from an immutable
report snapshot.

## Validation

- `node --test`: 67 passing, 0 failing.
- `node --check`: backend, UI, template, and test modules pass.
- Prettier check: all touched files pass.
- Wrangler dry-run for `wrangler.reporting.jsonc`: passes and reports
  `env.BROWSER` as a Browser Run binding.
- Wrangler dry-run for the existing `wrangler.jsonc`: passes and still reports
  only the briefing/history bindings.
- Template tests cover deterministic output, Weekly/Monthly periods, escaping,
  zero versus unavailable values, twelve handlers, twelve attention items,
  sixteen actions, long notes, carry-forward lineage, and frozen status
  precedence.

Actual PDF page rendering could not be run in this local environment because
no Chromium/Chrome/Edge executable, Poppler renderer, or Python PDF renderer
is installed. Therefore the HTML/template contract is verified, but a rendered
PDF page screenshot and PDF text extraction remain pending the configured
Browser Run binding or a local PDF renderer. No fake PDF artifact was created.

## Not included

Phase 6 does not apply the existing Phase 5 migrations, deploy either Worker,
send email or Teams messages, add AI-generated narrative, or create durable
export storage.

The smallest Phase 7 boundary is optional export history and distribution:
persist a generated-export metadata record and/or store the PDF in an approved
durable store, then add explicitly authorized email/Teams delivery. That work
must not alter the frozen report snapshot or metric engine.
