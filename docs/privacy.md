# Privacy Policy

**Effective September 2026**

This policy explains what {{PRODUCT}} collects, why, and how you can control or delete it. {{PRODUCT}} is a time-tracking and invoicing tool you use from an AI assistant (like Claude or ChatGPT) or from the web app at {{BASE_URL}}/app.

## What we collect

- **Account identity.** Your email address and name, from Google sign-in or from a magic-link email you request. If you sign in with Google, we also receive your profile picture URL.
- **Workspace settings.** Your business name, default currency, timezone, default hourly rate, invoice numbering prefix, logo, and business address, if you set them.
- **The data you create.** Time entries, clients, projects, and invoices you (or an assistant acting on your instructions) create, edit, or delete.
- **OAuth client registrations.** When you connect {{PRODUCT}} to Claude, ChatGPT, or another MCP-compatible app, we store that app's registration details (its name and redirect URL) and issue it access tokens scoped to your workspace.
- **An audit log of assistant tool calls.** Every time an AI assistant calls a {{PRODUCT}} tool on your behalf, we log the tool name, the arguments it was called with, a short result summary, and whether it succeeded. This is what lets you (and us, on request) see exactly what an assistant did to your data.
- **Payment and billing identifiers.** If you subscribe to a paid plan or send invoices with a Stripe payment link, we store your Stripe customer ID, subscription ID, and (if you use Stripe Connect payouts) your connected account ID.
- **Invoice view activity.** When a client opens an invoice link, we record the timestamp so you can see whether it's been viewed.
- **CSV imports.** If you import time entries from Toggl, Harvest, or Clockify, we store the filename, row counts, and any row-level errors from that import.

## What we do not collect

- We do not store the content of your conversations with Claude, ChatGPT, or any other assistant. We only see the arguments passed to {{PRODUCT}}'s own tools (for example, a time entry's description and duration) — not the rest of the conversation.
- We never see or store your card number, bank account, or other payment credentials. Stripe handles all payment processing; we only keep the identifiers described above.

## How AI assistants access your data

An assistant can only read or change your {{PRODUCT}} data after you connect it through OAuth and approve the scopes it's requesting. In plain language, those scopes are:

- **Read your time entries and reports** — see what you've logged and how your hours add up.
- **Log and edit time entries you describe** — create or change entries based on what you tell it.
- **Read your invoices and payment status** — see drafts, sent invoices, and whether they've been paid.
- **Create drafts and send invoices you approve** — draft invoices from unbilled hours, and email them only when you explicitly say to.

Access tokens expire after **1 hour**. Refresh tokens last 30 days and rotate every time they're used, so a stolen refresh token stops working the moment the real one is used again. You can revoke access at any time by removing the connector from Claude, ChatGPT, or whichever app you connected — this immediately invalidates its tokens.

## Subprocessors

We use a small number of service providers to run {{PRODUCT}}:

- **Stripe** — payment processing for your subscription and for the payment links on invoices you send to your clients.
- **Our email provider** (an SMTP service such as Brevo, or Resend) — delivers magic-link sign-in emails and invoice emails.
- **Google** — optional sign-in via Google OAuth, if you choose it instead of a magic link.
- **Our hosting and database provider** — runs the application and stores the data described above.

We don't sell your data or share it with anyone else for advertising.

## Retention and deletion

We keep your data for as long as your account is active. To delete your account and workspace, email {{SUPPORT_EMAIL}}. Deleting your workspace removes your time entries, clients, projects, invoices, and audit log; it does not retroactively delete records Stripe or the email provider already hold in their own systems as required by their own retention rules (e.g. completed payment records).

## Security

- All traffic to {{BASE_URL}} is encrypted with TLS.
- OAuth access and refresh tokens are stored as one-way hashes, never in plain text.
- Connections use OAuth 2.1 with PKCE, so authorization codes can't be replayed by an intercepting party.

## Children

{{PRODUCT}} is a business tool and is not directed at, or knowingly used to collect information from, children under 13.

## Changes to this policy

We'll update the effective date above when this policy changes. If a change is material, we'll make a reasonable effort to notify account holders by email.

## Contact

Questions about this policy or your data: {{SUPPORT_EMAIL}}.
