# Scout UX isolated acceptance preview

This guide recreates the accepted Scout UX candidate in an isolated, read-only
preview. It is for QA and release review only. The preview must not share
credentials, data, delivery endpoints, or routes with production.

1. Purpose and safety boundary: this is an isolated, read-only QA environment
   for the accepted Scout UX candidate. Never use production data, routes,
   delivery endpoints, or credentials.

2. Create or use a separate Supabase preview project. Never use the production
   Supabase project or its credentials.

3. Run the preview schema SQL in that project. Start with
   `scout-legacy-schema.sql`, then apply the repository migrations required by
   the seed, in timestamp order:
   `supabase/migrations/20260825114848_reporting_history_foundation.sql`,
   `20260825122259_reporting_runs_foundation.sql`,
   `20260825141850_management_attention_action_plan.sql`,
   `20260827182353_claim_notifications.sql`, and
   `20260828120000_scout_notes_foundation.sql`.

4. Establish a database role named `scout_preview_reader` with SELECT-only
   access to the preview tables. In the preview project's SQL editor, grant it
   USAGE on `public`, grant SELECT on the tables used by the seed, revoke
   INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER, and set matching
   default privileges for future preview tables. Keep the role separate from
   `anon`, `authenticated`, and `service_role`. Revoke mutation
   privileges from any non-owner role used by the preview if the base dump
   grants them.

5. Load the synthetic seed. Supply the approved tester email outside the
   repository when running the seed, for example with the database client's
   parameter mechanism:

   ```
   psql --set=SCOUT_PREVIEW_TESTER_EMAIL=<approved-tester-email> \
     --file=scout-preview-synthetic-seed.sql
   ```

   The email belongs only in the isolated preview project's `scout_users`
   row, with the role required for acceptance. Do not replace the placeholder
   in the repository or commit the tester's address. All claim, history, and
   report rows in the seed are synthetic.

6. Apply `scout-preview-report-detail-fix.sql` after the seed. Keep this as a
   separate corrective step because the seed creates the accepted report shell,
   while the correction deterministically supplies the persisted report-detail
   metrics and claim mappings.

7. Add one approved Azure tester to `scout_users` if the seed was loaded by a
   tool that does not expand the parameter. Use the approved tester's current
   Azure email, the accepted role, an active row, and the claims portal. Do not
   put that email in this repository.

8. Mint or provide the reader JWT outside the repository. Never commit JWTs,
   signing keys, or examples containing real values.

9. Configure the preview Worker secrets outside the repository:
   `SUPABASE_PREVIEW_API_KEY` and `SUPABASE_PREVIEW_READER_TOKEN`.
   Do not configure production Supabase credentials.

10. Deploy the preview backend only with `wrangler.preview.jsonc`. It must
   point at the isolated preview Supabase URL and keep
   `SCOUT_PREVIEW_READONLY=true`.

11. Deploy the remediation frontend only with
    `wrangler.frontend.remediation.jsonc`. It must select the preview
    backend, not the production backend.

12. Verify `/auth/me` with the approved Azure tester. The tester must already
    exist in the preview project's `scout_users` table with the accepted role.

13. Verify representative reads for claims, history, reports, notes, and the
    report-detail route.

14. Verify a representative mutation returns HTTP 403. The preview is
    read-only, including notes, actions, uploads, settings, and delivery routes.

15. Verify CORS from the remediation frontend origin and confirm other origins
    are not granted access.

16. Verify that no audit, email, Teams, or other delivery side effects occur.
    Email and Teams delivery are intentionally unavailable in this isolated
    preview. Do not create `briefing_runs` solely to remove preview warnings:
    it is intentionally unavailable because delivery infrastructure is
    deliberately excluded. Do not create `scout_settings` solely to remove
    preview warnings: it is intentionally unavailable because operational
    settings and configuration are deliberately excluded. These intentional
    limitations do not affect production Scout.

Production routes are not part of this setup. Never use production Supabase
credentials, never commit signing keys or JWTs, and never use this preview to
test production data or delivery.
