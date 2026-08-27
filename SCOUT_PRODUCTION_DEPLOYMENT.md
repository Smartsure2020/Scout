# Scout production deployment runbook

Status: approved operational procedure for the existing production
`scout-backend` Worker. This document covers the safe release path for the
reporting-enabled Claims API. It does not authorize a release by itself.

Production target: `scout-backend`

Current accepted release: record the active version ID during every preflight

Frontend Worker: `scout-smartsure`
Separate briefing/history Worker: `my-worker` topology remains unresolved and
is outside this release path.

## Production warning

**Do not use ordinary `wrangler deploy` for `scout-backend`.** The live Worker
has the Worker-level setting `observability.redact_query_string: false`, which
the currently approved Wrangler versions cannot safely model. Do not remove or
alter that setting, disable strict mode, or deploy through the dashboard or a
raw mutating API workaround.

Use the controlled Cloudflare Version Upload process below:

1. verify the current live version and Worker settings;
2. build and test the candidate;
3. upload a new version with strict binding inheritance;
4. inspect the uploaded version without changing production traffic;
5. place the candidate at 0% beside the current version;
6. run authenticated smoke tests with a version override;
7. move the candidate directly to 100% only after acceptance; and
8. retain the previous known-good version for rollback.

The official references are [Version Upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/),
[Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/),
[version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/),
and [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## 1. Preflight

Run these checks from the repository root. Save the output with the release
record, but never save API tokens, secret values, or bearer headers.

```powershell
npx wrangler whoami
npx wrangler deployments list --name scout-backend --json
npx wrangler versions list --name scout-backend --json
```

Before uploading, positively confirm all of the following against the live
Worker:

- the target is the existing `scout-backend` Worker;
- the active version ID and the previous known-good version ID are recorded;
- the compatibility date is `2026-04-13`;
- the live compatibility flags are preserved exactly, including an empty set
  when that is the live value;
- the existing bindings, text variables, and secret binding names are known;
- `observability.redact_query_string` is still `false`;
- routes, custom domains, and workers.dev behavior are unchanged; and
- the API Worker has no static asset directory or `ASSETS` binding.

Stop if the version called `latest` is not the intended current inheritance
source. Do not guess which version should provide inherited bindings.

## 2. Build and test gate

Run the repository checks before creating a version:

```powershell
npm test
node --check ".\scout backend.js"
node .\node_modules\prettier\bin\prettier.cjs --check `
  ".\scout backend.js" `
  ".\reporting-domain" `
  ".\wrangler.reporting.jsonc"
```

Use the reporting configuration for a non-mutating packaging check:

```powershell
npx wrangler deploy `
  --config wrangler.reporting.jsonc `
  --keep-vars `
  --strict `
  --dry-run
```

This dry-run is a packaging/configuration check only. If it reports that
`redact_query_string` is unsupported, stop. Do not remove the field or proceed
with ordinary `wrangler deploy`. The approved production path is the Version
Upload API below.

The candidate must contain no `assets` configuration, no frontend asset
upload, and no route or domain change. It must preserve compatibility date
`2026-04-13` and the live compatibility flags. The `BROWSER` binding is the
only intended new binding for the reporting release.

The repository’s `package.json` contains a generic `npm run deploy` command
that invokes ordinary `wrangler deploy` using the default `wrangler.jsonc`.
That default configuration names `my-worker`, not `scout-backend`, and includes
the separate briefing/history configuration. Do not use `npm run deploy` for
the Claims API. This runbook does not change that existing automation.

## 3. Upload a new version, without deploying it

Create a bundled module artifact using the approved build output, then use the
Cloudflare Version Upload API. The API upload creates a version but does not
make it serve traffic.

The metadata must include the actual uploaded main module name and the exact
live compatibility settings. Every existing binding that must remain available
is represented by an inherited binding. The required inheritance form is:

```json
{
  "name": "EXISTING_BINDING_NAME",
  "type": "inherit",
  "version_id": "latest"
}
```

Add the Browser Run binding only to the candidate version:

```json
{
  "name": "BROWSER",
  "type": "browser"
}
```

Send the upload request with `bindings_inherit=strict`. Strict mode makes the
upload fail if an inherited binding cannot be resolved; without it, an
unresolvable inherited binding can be silently dropped. Do not copy secret
values into the metadata. Do not include a new `assets` section, routes,
domains, or an observability override.

The request shape is:

```text
POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/scout-backend/versions?bindings_inherit=strict
Authorization: Bearer <CLOUDFLARE_API_TOKEN>
Content-Type: multipart/form-data

metadata = {
  "main_module": "<UPLOADED_MAIN_MODULE>",
  "compatibility_date": "2026-04-13",
  "compatibility_flags": [<EXACT_LIVE_FLAGS>],
  "bindings": [
    {"name": "<EXISTING_BINDING>", "type": "inherit", "version_id": "latest"},
    {"name": "BROWSER", "type": "browser"}
  ]
}
<worker modules and assets, with no frontend asset directory>
```

Do not upload if the generated metadata would remove an existing binding,
change the compatibility date or flags, add assets, add routes, or redefine
observability.

## 4. Inspect the uploaded version

Record the new version ID returned by the upload. Inspect it before any
deployment action:

```powershell
npx wrangler versions list --name scout-backend --json
```

Use the read-only Cloudflare version/API inspection available to the release
operator to confirm:

- the new version contains the reporting-enabled code;
- all intended inherited bindings resolve from the intended `latest` source;
- `BROWSER` exists with type `browser`;
- all existing text and secret binding names remain present;
- compatibility date is `2026-04-13`;
- compatibility flags exactly match live;
- no `assets` or `ASSETS` binding was introduced; and
- Worker-level `observability.redact_query_string` remains `false`.

Keep the active version ID as the rollback target for this release. Do not
hardcode one historical UUID as a permanent rollback target. Replace the
recorded rollback target with the newly accepted previous version on each
release.

## 5. Place the candidate at 0% and smoke-test it

Create a two-version deployment with the current version at 100% and the new
version at 0%:

```powershell
npx wrangler versions deploy `
  <CANDIDATE_VERSION>@0% `
  <CURRENT_VERSION>@100% `
  --name scout-backend `
  --yes
```

This is the only pre-cutover traffic change. Do not use a mixed percentage
rollout for the operational backend because reporting history capture must not
be split across versions. The candidate is present in the deployment but does
not receive normal traffic.

Send acceptance requests to the existing API domain with the version override
header. The header value must use the candidate version ID and the request
must include the normal Scout bearer token without printing it in logs:

```powershell
curl.exe -sS `
  "https://<SCOUT_API_DOMAIN>/reports/<FINALISED_REPORT_ID>/pdf" `
  -H "Authorization: Bearer <SCOUT_AUTH_TOKEN>" `
  -H 'Cloudflare-Workers-Version-Overrides: scout-backend="<CANDIDATE_VERSION>"'
```

The override is valid only while the candidate is in the current deployment.
Confirm in Cloudflare Observability, response headers, or equivalent release
evidence that the request reached the candidate. Test at least:

- an authorized Manager/Admin request for the real Finalised or Archived
  report;
- unauthorized, missing-token, and insufficient-role responses;
- frozen-state behavior for the selected report;
- the PDF response content type, disposition, byte size, and page count where
  available; and
- existing Claims API routes needed for normal operations.

If any acceptance check fails, keep normal traffic on the current version and
stop. Remove the candidate from the deployment only through the approved
Cloudflare deployment procedure after recording the failure.

## 6. Cut over directly to 100%

After the 0% acceptance evidence is complete, verify the exact candidate and
current version IDs one more time. Then deploy the candidate at 100% and leave
the current version at 0%:

```powershell
npx wrangler versions deploy `
  <CANDIDATE_VERSION>@100% `
  <CURRENT_VERSION>@0% `
  --name scout-backend `
  --yes
```

Confirm that routes, custom domains, workers.dev behavior, variables,
secrets, and observability settings remain unchanged. This cutover does not
touch `scout-smartsure` or the separate briefing/history Worker.

## 7. Post-cutover checks

Immediately after cutover, verify:

- the active deployment reports the candidate at 100%;
- the normal API domain still reaches `scout-backend`;
- authenticated Claims routes, report authorization, and frozen report reads
  succeed;
- the real PDF response downloads successfully and has acceptable byte size
  and page count;
- audit entries are written without exposing rendered HTML, raw source rows,
  tokens, or unnecessary personal data;
- no unexpected Worker errors or latency increase appear; and
- `observability.redact_query_string` is still `false`.

Retain the previous version until post-cutover checks are complete and the
release record identifies it as the rollback target.

## 8. Rollback

If post-cutover checks fail, deploy the previous known-good version directly at
100% using the version ID recorded for this release:

```powershell
npx wrangler versions deploy `
  <PREVIOUS_KNOWN_GOOD_VERSION>@100% `
  --name scout-backend `
  --yes
```

Verify the active deployment and the critical authenticated API routes after
rollback. Keep the failed candidate for investigation and record the incident,
candidate version, rollback version, and observed symptoms. Cloudflare’s
rollback mechanism creates a new deployment using the selected earlier version;
it does not rewrite history. Do not delete the known-good version until the
release has been formally closed.

## Explicit scope boundary

This runbook does not apply Supabase migrations, modify database objects,
change secrets, change production routes, replace the frontend Worker, or
start Phase 7. The separate `my-worker` briefing/history topology remains an
unresolved infrastructure-documentation item and is not a reason to redirect
or overwrite `scout-backend`.
