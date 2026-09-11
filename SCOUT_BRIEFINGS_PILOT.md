# Scout Briefings email pilot

`scout-briefings` is a deliberately isolated, manual-only Worker for the D1 email pilot. It generates a manager briefing from the current production extract, sends only to an explicitly allowlisted pilot address, and records delivery history.

## Safety boundary

- This change does not deploy a Worker, send email, change the existing delivery Worker, change the Scout frontend or backend, change Supabase schema, configure Azure, create secrets, configure routes, or enable a scheduled trigger.
- The only supported delivery type is `manager`.
- The production manager address is used only as a configuration-readiness signal. It is never used as the pilot destination.
- Handler and anomaly fan-out are intentionally disabled. Missing handler mappings appear in the plan and never cause a delivery.
- Microsoft Graph is the only provider. `saveToSentItems` is explicitly `false`.
- Every non-health request requires a Microsoft identity token and an exact caller allowlist match. CORS is not authentication.
- Empty or invalid caller and pilot-recipient allowlists fail closed.

## Idempotency

The existing `briefing_deliveries.id` UUID primary key supplies the uniqueness constraint needed for the pilot. A SHA-256-derived deterministic UUID is computed from the caller-provided idempotency key and inserted before any provider call. Concurrent attempts with the same key therefore have one reservation winner; later attempts return a duplicate/in-progress result and cannot start a second delivery.

The current schema has no dedicated columns for pilot mode, caller identity, or the original idempotency-key text. The implementation records the caller identity in the manual run trigger and represents the idempotency key through its deterministic delivery-record ID. The delivery record also stores the pilot recipient, subject, status, and result; the digest history record stores the generated content and send result. No schema migration is included in this pilot.

## Runtime bindings

The Worker expects the following runtime bindings to be supplied by the deployment owner. This checkpoint does not create or set them:

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `MAIL_FROM`, `DELIVERY_ALLOWED_CALLERS_JSON`, and `DELIVERY_PILOT_RECIPIENTS_JSON`.

No binding value is present in source or configuration. The Wrangler configuration contains only non-secret table names and retention metadata, and contains no routes, assets, triggers, or cron schedule.
