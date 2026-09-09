# {{PRODUCT}} documentation

{{PRODUCT}} tracks time and invoices clients from inside your AI chat. Tell it what you worked on; it logs the hours to the right client. Ask what's unbilled; it drafts the invoice. Nothing is sent to a client until you say so.

## Connect

**Claude (claude.ai or the desktop app)**
1. Settings → Connectors → Add custom connector.
2. Paste `{{BASE_URL}}/mcp` as the server URL.
3. Click Connect, sign in with Google or an email magic link, then click Allow on the consent screen.

**ChatGPT**
1. Settings → Connectors → Advanced → Developer mode (enable it if you haven't).
2. Create a connector using the same URL, `{{BASE_URL}}/mcp`.
3. Sign in and approve access the same way.

**Claude Code**
```
claude mcp add --transport http tally {{BASE_URL}}/mcp
```
The first tool call opens the sign-in flow in your browser.

Signing in for the first time creates your free {{PRODUCT}} workspace automatically — there's nothing to set up beforehand.

## What you can say

**Log time**
- "Log 2 hours on the Acme redesign"
- "Worked 9:30 to 11:15 on the landing page, billable"
- "Here's my day: standup 15 min, fixed the checkout bug 2h, client call 30m"

**Catch up on forgotten time**
- "Reconstruct my Tuesday from my calendar"
- "I forgot to log this week — figure it out from my commits and calendar"
- "I was out sick Thursday, don't count that day"

**Reports**
- "How did this week go?"
- "How many billable hours this month?"
- "What haven't I invoiced yet?"
- "Break down my hours by client for August"

**Invoices**
- "What could I bill Acme for right now?"
- "Invoice Acme for last month"
- "Send that invoice"
- "Mark the Acme invoice paid, they wired it"
- "Void that invoice, I made a mistake"

**Clients & projects**
- "What clients and projects do I have?"
- "Add a new client, Northwind, net 15, $140/hr"
- "Create a project called 'Q4 audit' under Northwind"

The assistant asks when a project is ambiguous; it never guesses, and it never creates a client or project without you confirming first. Invoices are only sent when you say so — creating a draft never notifies your client.

## How dates and durations are interpreted

"Today" always means today in your **workspace timezone**, not the assistant's guess or your device's clock — the workspace timezone is set once, on signup, and can be changed in Settings.

Durations are read leniently. All of these are understood: `2h30m`, `2h 30m`, `2.5`, `150`, `1:45`, `90 min`, `half an hour`. For a bare number with no unit: a decimal is read as hours (`2.5` → 2.5 hours), and a whole number is read as hours if it's 12 or less, otherwise minutes — so `8` means 8 hours, but `90` means 90 minutes. If you want to be unambiguous, say the unit (`8h`, `90m`).

## Rates

The hourly rate used for a time entry is resolved in this order, first match wins:

1. A rate set directly on that entry (rare — an explicit override).
2. The project's rate.
3. The client's default rate.
4. Your workspace default rate.

## Invoices

An invoice moves through: **draft → sent → viewed → paid**, or **void** at any point before payment.

- A **draft** includes every unbilled billable time entry for a client up to a cutoff date. Creating a draft marks those entries as invoiced but sends nothing.
- **Sending** emails the invoice with a Stripe payment link (if Stripe is configured) to the client's billing email, and moves it to `sent`.
- The invoice lives at a public link: `{{BASE_URL}}/i/<token>`. No login needed — that's what makes it clickable from an email.
- The same invoice as a PDF is at the same link with `.pdf` appended: `{{BASE_URL}}/i/<token>.pdf`.
- Clients can pay directly from the invoice page via the Stripe payment link. A successful Stripe payment marks the invoice `paid` automatically.
- If a client pays another way (check, bank transfer, cash), record it manually — that also marks the invoice paid.
- **Voiding** an unpaid invoice releases its time entries so they can be included on a future invoice. Paid invoices can't be voided.

## Importing from Toggl, Harvest, or Clockify

1. Export your time entries as a detailed CSV from Toggl, Harvest, or Clockify.
2. Upload it at `{{BASE_URL}}/app/import`.
3. Re-uploading the same export (or an overlapping one) won't create duplicate entries — imported rows are matched by source, date, and duration, so importing twice is safe.

CSV import is a **Pro** feature.

## Plans and limits

| Plan | Price | Clients | Invoices/month | Import | Branding |
|---|---|---|---|---|---|
| Free | $0 | 1 | 2 | No | No |
| Pro | $12/month | Unlimited | Unlimited | Yes | Yes |
| Team | $8/seat/month | Unlimited | Unlimited | Yes | Yes |

Hitting a plan limit doesn't fail silently — the assistant will tell you what limit you hit and share a link to upgrade.

## Bundled skills

{{PRODUCT}} ships five workflows as Claude skills. Where your host supports MCP prompts or slash commands, the same workflows are available that way too:

- **log-day** — turn a free-form recap of your day into logged time entries.
- **catch-up** — reconstruct a day or week you forgot to log, from calendar events, commits, or tickets.
- **weekly-report** — a short summary of hours and billing for the current (or a named) week.
- **invoice-client** — preview, create, and (with your approval) send an invoice for one client.
- **month-close** — run invoicing across every client with unbilled hours at the end of a month, one invoice at a time, each still requiring your approval to send.

## Privacy & revoking access

{{PRODUCT}} only sees what you tell it to log, and the arguments of the tools an assistant calls on your behalf — never the rest of your conversation. See the [privacy policy]({{BASE_URL}}/privacy) for details on what's collected and how to delete it.

To revoke an assistant's access, remove the connector from that app (Claude, ChatGPT, etc.) — this immediately invalidates its tokens. You can reconnect at any time; nothing about your workspace or data is lost.

## Tool reference

| Tool | Use when | Type |
|---|---|---|
| `time.list_entries` | Listing individual time entries for a day, week, project, or client | Read |
| `time.report` | Totals and breakdowns: hours by day/project/client, unbilled amount | Read |
| `workspace.list_projects` | Listing clients, projects, aliases, and rates | Read |
| `time.propose_entries` | Reconstructing time from calendar/commits/tickets (proposes only, saves nothing) | Read |
| `invoice.list` | Listing invoices by status, client, or date range | Read |
| `invoice.get` | Viewing one invoice's lines, total, and payment status | Read |
| `invoice.preview_draft` | Previewing what an invoice would contain before creating it | Read |
| `time.log_entry` | Logging one time entry with a known duration | Write |
| `time.log_entries_batch` | Logging several entries at once (a recap, or confirmed proposals) | Write |
| `time.update_entry` | Correcting an existing entry's duration, project, date, etc. | Write |
| `time.delete_entry` | Removing an entry (requires confirmation) | Write |
| `workspace.create_client` | Adding a new client | Write |
| `workspace.create_project` | Adding a new project | Write |
| `invoice.create_draft` | Turning unbilled hours into a draft invoice | Write |
| `invoice.record_payment` | Recording a payment made outside Stripe | Write |
| `invoice.send` | Emailing a reviewed draft to the client with a payment link | Write (external) |
| `invoice.void` | Cancelling an invoice and releasing its entries (requires confirmation) | Write (external) |
