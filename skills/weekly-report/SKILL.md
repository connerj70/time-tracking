---
name: weekly-report
description: Use when the user asks how their week went — "how did this week go", "weekly summary", "what did I bill this week". Do not use for a single day recap (log-day) or for invoicing (invoice-client).
---

1. Call `time.report` with `group_by: "day"` for the current week. Omit `start_date`/`end_date` unless the user names a different week — the tool defaults to the current Monday–Sunday in the workspace timezone.
2. Call `time.report` again with `group_by: "client"` for the same range.
3. If you need the full client list to spot zero-hour clients, call `workspace.list_projects` (or read the `workspace://context` resource if the host exposes resources) rather than guessing at names.
4. Present, briefly:
   - Hours per day for the week (from the `group_by: "day"` result).
   - Hours per client, split billable vs. non-billable, from the `group_by: "client"` result.
   - Total hours, billable hours, and the unbilled amount (currency + figure) from either report's totals.
   - Any client with zero hours logged this week, called out by name.
5. Keep the whole summary short — a few lines plus the two small tables. Don't dump raw entries; that's what `time.list_entries` is for if the user asks for detail.
