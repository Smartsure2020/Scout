-- SCOUT reporting roster: the authoritative bridge between the text Cardinal
-- puts in "Claim Handler" and a reporting role.
--
-- NOT APPLIED. Review, then run once in the Supabase SQL editor. No schema
-- change: it writes one row (id = 'reporting_roster') to the existing
-- scout_settings (id text primary key, value jsonb, updated_at) table.
--
-- Roles
--   handler               active claims handler. Always gets a scorecard.
--   claims_manager        occasionally accepts a claim. Scorecard only when
--                         holding claims. No warning.
--   claims_administrator  registers claims. Any open or newly registered claim
--                         still held here is a RED allocation warning
--                         ("the correct handler must be allocated").
--   former_handler        no longer in claims; claims are normally re-opened for
--                         payments. AMBER warning requiring ownership
--                         confirmation.
--   anything else         RED warning (unrecognised Cardinal handler).
--
-- Matching: every string in "match" is compared to Cardinal's text ignoring
-- case, spacing, punctuation and word order. There are deliberately NO
-- first-name aliases: a name only matches if Cardinal literally sent it.
--
-- Evidence: the exact distinct values of "Claim Handler" found by scanning all
-- 14 workbooks in "1. CLAIMS BACK UP\60 DAYS" (the number is how many of the 14
-- workbooks contain the value; it is NOT a claim count):
--   "Sarah Dzumba"            14   -> handler
--   "Naledi Moletsane"        14   -> handler
--   "Lucky Mokgomo"           13   -> handler
--   "Beverly De Beer"         14   -> Bev   (Cardinal ALSO sends "De Beer Bev")
--   "De Beer Bev"             10   -> Bev
--   "Lesire Make"             14   -> former handler
--   "Rakgalakane Karabo"      10   -> Karabo (surname first in Cardinal)
--   "Juan-Paul Van der Merwe"  9   -> Juan-Paul
--   "Nicole Mentor"            2   -> claims administrator
--   "Busi Nyangintsimbi"       7   -> Busi (former handler; approved 2026-10-05)
--   "Johnson Kuhamba"          5   -> Johnson (former handler; approved 2026-10-05)
--   "Lorraine Greyling"        3   -> NOT MAPPED on purpose (approved 2026-10-05):
--                                     2 settled claims from 2021 and never in a
--                                     weekly export, so no evidence of a handler role.
--   "ABSA "                    2   -> NOT MAPPED on purpose: ABSA is a source,
--                                     not a handler. A claim carrying it is
--                                     flagged red so a real handler is allocated.
--
-- Approved 2026-10-05: Busi and Johnson are former handlers (amber, ownership to be
-- confirmed). Lorraine Greyling and "ABSA " stay unmapped, so a claim carrying
-- either shows as a RED "unrecognised" allocation exception.
-- This file has NOT been applied to any database.

insert into scout_settings (id, value, updated_at)
values (
  'reporting_roster',
  $json$
  {
    "version": "2026-10-05",
    "members": [
      { "id": "lucky",    "label": "Lucky",     "role": "handler",              "match": ["Lucky Mokgomo"] },
      { "id": "naledi",   "label": "Naledi",    "role": "handler",              "match": ["Naledi Moletsane"] },
      { "id": "sarah",    "label": "Sarah",     "role": "handler",              "match": ["Sarah Dzumba"] },
      { "id": "bev",      "label": "Bev",       "role": "claims_manager",       "match": ["Beverly De Beer", "De Beer Bev"] },
      { "id": "nicole",   "label": "Nicole",    "role": "claims_administrator", "match": ["Nicole Mentor"] },
      { "id": "lesire",   "label": "Lesire",    "role": "former_handler",       "match": ["Lesire Make"] },
      { "id": "juanpaul", "label": "Juan-Paul", "role": "former_handler",       "match": ["Juan-Paul Van der Merwe"] },
      { "id": "karabo",   "label": "Karabo",    "role": "former_handler",       "match": ["Rakgalakane Karabo"] },
      { "id": "busi",     "label": "Busi",      "role": "former_handler",       "match": ["Busi Nyangintsimbi"] },
      { "id": "johnson",  "label": "Johnson",   "role": "former_handler",       "match": ["Johnson Kuhamba"] }
    ]
  }
  $json$::jsonb,
  now()
)
on conflict (id) do update
  set value = excluded.value,
      updated_at = excluded.updated_at;
