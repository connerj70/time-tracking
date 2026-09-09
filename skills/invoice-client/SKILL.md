---
name: invoice-client
description: Use when the user wants to bill or invoice a specific client — "invoice Acme for August", "bill Acme". Do not use for a month-end run across every client (use month-close) or for just checking unbilled hours (time.report).
---

1. Call `invoice.preview_draft` with the client name. This creates nothing — it just shows what an invoice would contain.
2. Present the preview: line items (grouped however it came back), total hours, and total amount. Mention the `through_date` used.
3. Let the user adjust before creating anything:
   - `through_date` — cut off unbilled entries at a different date.
   - `group_lines_by` — `project`, `day`, or `entry`.
   - `tax_rate_percent`, `notes`, `due_in_days` (net terms).
   Re-run `invoice.preview_draft` with the new options if they change something and want to see it again first.
4. When the user is happy with the preview, call `invoice.create_draft` with the same arguments. This still does not send anything — it only creates a draft the client cannot see yet.
5. Show the result: invoice number, total, due date, and `public_url` if present.
6. Offer to send it, but **only call `invoice.send` when the user explicitly says to send it** (e.g. "send it", "email that to them"). Never send automatically after creating a draft.
7. If the client has no billing email on file, `invoice.send` will need one — ask the user for an email and pass it as `to_email`.
8. If any step returns a plan-limit error with `upgrade_url`, tell the user what limit was hit (e.g. invoices this month) and relay the link.
