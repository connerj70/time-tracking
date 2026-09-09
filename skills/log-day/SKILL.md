---
name: log-day
description: Use when the user recaps their day in free-form text — "here's what I did today", "log my day", "end of day: ...", or a list of tasks with rough times. Do not use for a single already-clear entry (just log it directly) or for reconstructing a past day/week from calendar or commits (use catch-up instead).
---

1. Parse the user's recap into candidate entries. For each: `description`, a `duration` (or `start`/`end`), an optional `project`, `date` (default today — omit it and let the tool default rather than guessing), and `billable` if stated.
2. **Never invent a duration.** If an item has no duration and no start/end, ask the user for it before logging that item (you may log the rest in the meantime). Only use a duration the user actually gave, in whatever loose form ("2h", "90 min", "9:30-11") — never round or estimate on their behalf.
3. **Never create a project or client without asking.** Let `time.log_entries_batch` try to fuzzy-match project names server-side. Do not call `workspace.create_project` or `workspace.create_client` speculatively.
4. Call `time.log_entries_batch` with every entry you could parse, in one call.
5. Read the per-row results and follow up:
   - `logged` — counts toward the day total.
   - `ambiguous` — the row carries `candidates`; show them and ask which project was meant, then log that one entry again once the user answers.
   - `no_project` — tell the user nothing matched and ask whether to use an existing project or create a new one; only call `workspace.create_project` after they explicitly confirm.
   - `duplicate` — the row carries `possible_duplicate`; ask whether to log it anyway or skip it.
   - `error` — relay the error message plainly.
   - any result carrying `upgrade_url` (plan limit hit) — tell the user what limit was hit and share the link.
6. After resolving follow-ups, report the day's total hours and billable hours, and list anything still unresolved.
