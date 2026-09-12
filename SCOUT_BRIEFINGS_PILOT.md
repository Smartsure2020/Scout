# Scout Briefings Teams manager pilot

`scout-briefings` is a deliberately isolated, manual-only Worker for the
manager briefing pilot. It generates one concise manager briefing from the
current production extract and delivers it only to the server-side
Claims Manager Teams Workflow destination.

## Safety boundary

- This change does not deploy a Worker, send Teams messages, change the legacy
  `scout-teams-proxy`, change the Scout frontend or backend, change Supabase
  schema, configure Azure, create secrets, configure routes, or enable a
  scheduled trigger.
- Microsoft Graph `/me` is used only to authenticate the caller. Graph
  application email delivery and `sendMail` are not part of this Worker.
- The only supported delivery type is `manager` and the Worker makes exactly
  one webhook request per newly reserved idempotency key.
- The client cannot provide a webhook URL, recipient, channel, or Teams
  destination. The only delivery destination is the `TEAMS_MANAGER_WEBHOOK`
  secret binding.
- Handler mappings remain plan warnings only. Handler and anomaly fan-out are
  disabled.
- Every non-health request requires a Microsoft identity token and an exact
  caller allowlist match. CORS is not authentication. Empty or invalid caller
  allowlists fail closed.
- There is no cron or scheduled delivery entrypoint.

## Manager briefing content

The accepted deterministic Scout predicates and shared briefing model remain
the source of truth. The Teams message is capped and prioritises the extract
date, active claims, critical SLA, stale/at-risk claims, outstanding exposure,
management attention, top risk watch, and closure candidates where relevant.
Useful Scout claim links are retained when configured. The message does not
include the complete extract.

## Delivery outcome safety

The existing `briefing_deliveries.id` UUID primary key supplies the uniqueness
constraint needed for the pilot. A SHA-256-derived deterministic UUID is
computed from the caller-provided idempotency key and inserted before any
provider call. Concurrent attempts with the same key therefore have one
reservation winner; later attempts cannot start a second webhook call.

The outcome states are:

- `accepted` after a clear successful Teams HTTP response. This means the
  Teams Workflow/Webhook accepted the transport payload; it does not confirm
  that Claims Manager received or rendered the Teams message;
- `failed` after a clear Teams HTTP rejection;
- `delivery_unknown` after a network or timeout ambiguity; and
- `accepted_audit_incomplete` if the Workflow/Webhook accepted the message but
  later audit persistence fails.

An existing `accepted` delivery returns `already-accepted` without another
webhook call. Ambiguous outcomes are never retried automatically. The same
idempotency key remains consumed, including after
`accepted_audit_incomplete`.

The API reports `transportAccepted: true` and `deliveryConfirmed: false` for
accepted transport and post-acceptance audit outcomes. The `digest_log.sent_ok`
column remains unchanged for schema compatibility; for this Teams Workflow
pilot, `sent_ok = true` means webhook transport accepted, not confirmed
downstream Teams delivery. The first production pilot requires a human to
verify that Claims Manager actually received the briefing.

## Runtime bindings

The Worker expects the following runtime bindings to be supplied by the
deployment owner. This checkpoint does not create or set them:

`SUPABASE_URL` is non-secret configuration. The required sensitive bindings
`SUPABASE_SECRET_KEY`, `DELIVERY_ALLOWED_CALLERS_JSON`, and
`TEAMS_MANAGER_WEBHOOK` must each be provisioned as Worker secrets. The
briefing Worker uses the dedicated Supabase Secret API key, not the legacy
`service_role` JWT. Supabase requests send that key as the `apikey` header;
they do not send it as an `Authorization` bearer token.

`TEAMS_MANAGER_WEBHOOK` must be provisioned later as a Worker secret. Its value
must never appear in Git, Wrangler vars, tests, logs, or API responses. The
webhook value must be a syntactically valid HTTPS URL; no endpoint hostname is
hard-coded before the dedicated Claims Manager Workflow is approved.

The Wrangler configuration contains only non-secret table names and retention
metadata. It contains no webhook value, routes, assets, triggers, or cron
schedule.
