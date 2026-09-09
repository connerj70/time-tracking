---
name: month-close
description: Use when the user wants to close out a whole month at once — "close out the month", "invoice everyone for last month". Do not use for a single client (invoice-client) or for a plain hours summary with no invoicing intent (weekly-report).
---

1. Call `time.report` with `group_by: "client"` for the month in question (last calendar month unless the user says otherwise) to see unbilled amounts per client.
2. For each client whose unbilled amount is greater than zero:
   a. Call `invoice.preview_draft` for that client (`through_date` = end of the month).
   b. Call `invoice.create_draft` with the same arguments to create the draft.
3. After processing every client, summarize the batch: for each, client name, hours, and total — plus any client skipped because it had a plan-limit error (relay its `upgrade_url`).
4. **Never batch-send.** Do not call `invoice.send` for more than one invoice without the user separately approving that specific invoice. Ask, per invoice, whether to send it now, and only call `invoice.send` for the ones they explicitly approve.
5. If a client has no billing email, ask for one and pass it as `to_email` when sending that invoice.
6. Report the final state: which invoices were created, which were sent, and which are still waiting on the user's approval or an email address.
