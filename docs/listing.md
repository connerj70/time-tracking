# Directory listing copy — Tallied

Copy for the Claude Connectors Directory and the ChatGPT plugin directory.
Same product, same copy where the two directories allow it; platform-specific
fields are called out.

## Name

Tallied

## Tagline

"Log hours, invoice clients, get paid."

Character count: 37 (limit 55).

## Categories

- **Claude Connectors Directory:** Productivity, Financial services
- **ChatGPT:** Productivity

## Description

(2000 character limit; this copy is 1143 characters.)

Tallied is time tracking and invoicing for freelancers and small teams, built to
be used entirely from chat. Tell it what you worked on — "spent the morning on
the Acme landing page" — and it logs the hours to the right project and
client, asking before it guesses a duration or creates something new.

Forgot to track a day or a week? Tallied reconstructs it from your calendar,
git commits, and tickets, proposes entries with a confidence score per item,
and flags anything unmatched or already logged before you confirm.

Ask how your week or month went and get hours by day, project, or client,
billable vs. non-billable, and what's still unbilled. When it's time to get
paid, Tallied previews the invoice — lines, hours, total — before creating a
draft, and only emails it (with a Stripe payment link) once you explicitly say
to send it. It can also close out an entire month across every client with
unbilled hours, drafting one invoice at a time and sending only what you
approve.

Already tracking time elsewhere? Import your history from Toggl, Harvest, or
Clockify.

Nothing needed before connecting — a free account is created on connect.

## Use-case description

**Primary uses:**
- Log time from a spoken/typed recap of the day.
- Reconstruct missed time from calendar events, commits, and tickets.
- Summarize hours and billing status by day, project, or client.
- Preview, create, and send client invoices.
- Close out a month across all clients with unbilled work.

**Prerequisites:** none. A free Tallied account is created automatically on
first connect.

**Read/write:** both. Tallied reads time entries, projects, clients, and
invoices, and writes new time entries, projects, clients, and invoices. It
sends real email (via `invoice.send`) only when the user explicitly asks it
to send an invoice.

## Default prompts

- "Log 2 hours on the Acme redesign"
- "How many billable hours this month?"
- "What haven't I invoiced yet?"
- "Reconstruct my Tuesday from my calendar"
- "Invoice Acme for last month"

## Claude slug

Recommended slug: `tally`

Note: the slug is permanent once the connector is published in the Claude
Connectors Directory — it cannot be changed later without losing the
directory listing's history and any deep links pointing at it. Confirm the
name is final before first publish.
