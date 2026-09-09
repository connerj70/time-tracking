---
name: catch-up
description: Use when the user wants to reconstruct time they forgot to log — "reconstruct my Tuesday", "I forgot to log this week", "figure out my week from my calendar/commits/tickets". Do not use for a same-day recap the user is telling you directly (use log-day) or for a single clear entry (log it directly).
---

1. Determine the date range. If the user didn't give one, ask or infer it from their phrasing ("this week", "Tuesday") — resolve "Tuesday" etc. to an actual `YYYY-MM-DD`.
2. Gather raw activity for that range from whatever connectors/tools are actually available in this host — calendar, GitHub/git log, Linear, Jira, or similar. If no such connector or tool is available, tell the user and ask them to paste their calendar or describe the week instead of guessing at their activity.
3. Map every item you gathered into the `activity` array shape expected by `time.propose_entries`:
   - `source`: one of `calendar`, `git`, `issue_tracker`, `note`, `other`.
   - `title`, and when available `start`/`end` (ISO datetimes) or `duration_min`, plus `url` and `participants` (emails — used to match clients by domain).
   Do not invent start/end times or durations for items that don't have them; leave them out and let the tool apply its defaults.
4. Call `time.propose_entries` with `date_range` and `activity`. It saves nothing.
5. Present the result grouped by day:
   - For each proposed entry: description, project/client match, hours, confidence, and reason.
   - List `unmatched` items with their `candidates` and ask the user to pick a project for each (or say to skip it).
   - List `gaps` (days under the target hours) and `overlaps` (conflicting time blocks) for awareness.
   - Skip any item with `already_logged` set unless the user explicitly says to log it again.
6. Once the user confirms and every unmatched item is resolved (project chosen, or dropped), call `time.log_entries_batch` with the confirmed `entry` objects from `proposed` — they already carry `source: "proposal"` and `source_ref`, so pass them through as-is (don't strip those fields).
7. Report what was logged, using the same per-row status handling as log-day (`ambiguous`, `no_project`, `duplicate`, `error`, `upgrade_url`).
