import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { config } from '../config.js';
import type { Ctx } from '../services/context.js';
import { contextResource, createClient, createProject, listClients, listProjects, publicClient, publicProject } from '../services/workspace.js';
import { deleteEntry, listEntries, logBatch, logEntry, report, updateEntry, type LogEntryInput } from '../services/time.js';
import { createDraft, getInvoice, listInvoices, previewDraft, recordPayment, sendInvoice, voidInvoice } from '../services/invoices.js';
import { proposeEntries } from '../services/propose.js';
import { todayIn } from '../lib/dates.js';
import { EXTERNAL, EXTERNAL_DESTRUCTIVE, MODIFY, READ, WRITE, WRITE_IDEMPOTENT, guarded } from './helpers.js';
import { loadSkills } from './prompts.js';
import { APP_RESOURCE_URI, loadAppHtml } from './app-resource.js';

const P = config.productName;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const entryInput = {
  description: z.string().max(500).optional().describe('What was done, in the user\'s words. Keep it short; this appears on invoices.'),
  duration: z.union([z.string(), z.number()]).optional().describe('Lenient: "2h30m", "2.5", "150", "1:45", "90 min". Omit when start and end are given.'),
  start: z.string().optional().describe('ISO datetime or HH:MM (workspace timezone assumed if no offset). Optional.'),
  end: z.string().optional().describe('ISO datetime or HH:MM. Optional.'),
  date: dateSchema.optional().describe('YYYY-MM-DD. Defaults to today in the workspace timezone. Do not guess today; omit it.'),
  project: z.string().optional().describe('Project name, alias, or id. Fuzzy-matched server-side; returns candidates when ambiguous. Never auto-creates.'),
  billable: z.boolean().optional().describe('Defaults to the project\'s billable_default.'),
  tags: z.array(z.string()).optional(),
  rate: z.number().optional().describe('Per-entry hourly rate override in workspace currency. Rare; omit normally.'),
  idempotency_key: z.string().max(200).optional().describe('Optional. Retrying with the same key never double-logs.'),
};

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: P.toLowerCase(), version: '0.1.0', title: P },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: [
        `${P} tracks time and invoices clients for the connected workspace ("${ctx.workspace.name}", timezone ${ctx.workspace.timezone}, currency ${ctx.workspace.currency}).`,
        `Today in the workspace timezone is ${todayIn(ctx.workspace.timezone)}; omit dates to default to it.`,
        'Read workspace://context once to learn the user\'s clients, projects, aliases, and rates before logging time.',
        'Never guess a project: when a tool returns candidates, ask the user which one.',
        'Invoices are only emailed via invoice.send after the user has reviewed the draft and explicitly asked to send.',
      ].join(' '),
    },
  );
  const ws = ctx.workspace;
  const appHtml = loadAppHtml();
  const uiMeta = appHtml ? { ui: { resourceUri: APP_RESOURCE_URI } } : {};

  // ---------- Resources ----------
  server.registerResource(
    'workspace-context',
    'workspace://context',
    {
      title: 'Workspace context',
      description: `Compact JSON of ${P} clients, projects, aliases, rates, currency, timezone, and recent entry descriptions. Read once per conversation instead of calling workspace.list_projects repeatedly.`,
      mimeType: 'application/json',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await contextResource(ctx), null, 1) }] }),
  );

  if (appHtml) {
    registerAppResource(server, 'tally-app', APP_RESOURCE_URI, { description: `${P} week grid and invoice preview`, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }, async () => ({
      contents: [{ uri: APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: appHtml }],
    }));
  }

  // ---------- Read tools ----------
  server.registerTool(
    'time.list_entries',
    {
      title: 'List time entries',
      description:
        'Use this when the user asks what they worked on, what they logged, or wants entries for a day, week, project, or client. Returns individual entries with resolved project/client names and per-entry rates. For totals and breakdowns use time.report instead. Do not use for calendar events, tasks, or reminders. Defaults to the current week in the workspace timezone.',
      inputSchema: {
        start_date: dateSchema.optional().describe('YYYY-MM-DD, inclusive. Default: Monday of the current week.'),
        end_date: dateSchema.optional().describe('YYYY-MM-DD, inclusive. Default: today.'),
        project: z.string().optional().describe('Project name or id'),
        client: z.string().optional().describe('Client name or id'),
        billable_only: z.boolean().optional(),
        unbilled_only: z.boolean().optional().describe('Only billable entries not yet on an invoice'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100'),
        cursor: z.string().optional().describe('page.next_cursor from a previous call'),
      },
      annotations: { ...READ, title: 'List time entries' },
    },
    guarded(ctx, 'time.list_entries', async (args) => {
      const data = await listEntries(ctx, args);
      return { data, summary: `${data.entries.length} entries ${data.range.start}..${data.range.end} (${data.page.total_hours_on_page}h on this page)${data.page.next_cursor ? ', more available' : ''}` };
    }),
  );

  registerAppTool(
    server,
    'time.report',
    {
      title: 'Hours and billing summary',
      description:
        'Use this when the user asks how many hours they worked, billable vs. non-billable, hours by day, project, or client, or how much is unbilled. Returns aggregates, not individual entries (use time.list_entries for those). Defaults to the current week in the workspace timezone. With group_by "day" this renders a week grid.',
      inputSchema: {
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        group_by: z.enum(['day', 'project', 'client', 'none']).optional().describe('Default "none". Use "day" for weekly views.'),
        client: z.string().optional(),
        project: z.string().optional(),
      },
      annotations: { ...READ, title: 'Hours and billing summary' },
      _meta: uiMeta,
    },
    guarded(ctx, 'time.report', async (args) => {
      const data = await report(ctx, args);
      return {
        data: { view: data.group_by === 'day' ? 'week_grid' : 'report', ...data },
        summary: `${data.total_hours}h total (${data.billable_hours}h billable) ${data.range.start}..${data.range.end}; unbilled ${data.currency} ${data.unbilled_amount.toFixed(2)}`,
      };
    }),
  );

  server.registerTool(
    'workspace.list_projects',
    {
      title: 'List clients, projects, and rates',
      description:
        'Use this when the user asks what projects or clients exist, what a rate is, or when you need to resolve an ambiguous project name before logging time. Returns clients with their projects, aliases, and effective rates. Cheap to call. Prefer reading the workspace://context resource once if the host supports resources.',
      inputSchema: { include_archived: z.boolean().optional() },
      annotations: { ...READ, title: 'List clients, projects, and rates' },
    },
    guarded(ctx, 'workspace.list_projects', async (args) => {
      const [clients, projects] = await Promise.all([listClients(ctx, args.include_archived), listProjects(ctx, args.include_archived)]);
      const data = {
        workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone, default_rate: ws.default_rate_cents / 100, plan: ws.plan, today: todayIn(ws.timezone) },
        clients: clients.map((c) => ({ ...publicClient(c), projects: projects.filter((p) => p.client_id === c.id).map((p) => publicProject(p, ws)) })),
        unassigned_projects: projects.filter((p) => !p.client_id).map((p) => publicProject(p, ws)),
      };
      return { data, summary: `${clients.length} clients, ${projects.length} projects` };
    }),
  );

  server.registerTool(
    'invoice.list',
    {
      title: 'List invoices',
      description:
        'Use this when the user asks about invoices: outstanding, overdue, paid, drafts, sent this month, which clients owe money, or a specific client\'s invoices. Returns invoice summaries with status and totals. Use invoice.get for line items.',
      inputSchema: {
        status: z.enum(['draft', 'sent', 'viewed', 'paid', 'void', 'overdue', 'outstanding', 'all']).optional().describe('Default "all". "outstanding" = sent or viewed; "overdue" = outstanding and past due.'),
        client: z.string().optional(),
        start_date: dateSchema.optional().describe('Issue date from'),
        end_date: dateSchema.optional().describe('Issue date to'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { ...READ, title: 'List invoices' },
    },
    guarded(ctx, 'invoice.list', async (args) => {
      const data = await listInvoices(ctx, args);
      return { data, summary: `${data.count} invoices (${data.status_filter}); outstanding ${data.currency} ${data.outstanding_total.toFixed(2)}, overdue ${data.overdue_total.toFixed(2)}` };
    }),
  );

  registerAppTool(
    server,
    'invoice.get',
    {
      title: 'Get invoice details',
      description: 'Use this when the user asks about a specific invoice\'s lines, total, due date, payment link, or payment status. Accepts an invoice id or number (e.g. "INV-0007"). Renders an invoice preview.',
      inputSchema: { invoice_id: z.string().describe('Invoice id or number') },
      annotations: { ...READ, title: 'Get invoice details' },
      _meta: uiMeta,
    },
    guarded(ctx, 'invoice.get', async (args) => {
      const data = await getInvoice(ctx, args.invoice_id);
      return { data, summary: `Invoice ${data.number} for ${data.client.name}: ${data.total_formatted}, ${data.status}, due ${data.due_date}` };
    }),
  );

  registerAppTool(
    server,
    'invoice.preview_draft',
    {
      title: 'Preview what an invoice would contain',
      description:
        'Use this when the user asks what they could invoice a client for, or wants to see unbilled work before creating an invoice. Creates nothing. Returns the lines, hours, and total an invoice.create_draft call with the same arguments would produce.',
      inputSchema: {
        client: z.string().describe('Client name or id'),
        through_date: dateSchema.optional().describe('Include unbilled entries up to and including this date. Default: today.'),
        group_lines_by: z.enum(['project', 'day', 'entry']).optional().describe('Default "project"'),
        tax_rate_percent: z.number().min(0).max(100).optional(),
      },
      annotations: { ...READ, title: 'Preview what an invoice would contain' },
      _meta: uiMeta,
    },
    guarded(ctx, 'invoice.preview_draft', async (args) => {
      const data = await previewDraft(ctx, args);
      return { data: { view: 'invoice_preview', ...data }, summary: `${data.client.name}: ${data.total_hours}h unbilled through ${data.through_date} = ${data.total_formatted}` };
    }),
  );

  server.registerTool(
    'time.propose_entries',
    {
      title: 'Propose time entries from activity',
      description:
        'Use this when the user wants to reconstruct or catch up a day or week from calendar events, commits, pull requests, tickets, or notes you have already gathered from other tools or the user. Pass the raw activity; this returns proposed entries mapped to the user\'s projects with confidence scores, plus unmatched items, detected gaps, and overlaps. It saves nothing. Present the proposal, confirm with the user, then call time.log_entries_batch with the confirmed entry objects. Do not use for logging a single known entry (use time.log_entry).',
      inputSchema: {
        date_range: z.object({ start: dateSchema.optional(), end: dateSchema.optional() }).optional().describe('Defaults to the span of the activity'),
        activity: z
          .array(
            z.object({
              source: z.enum(['calendar', 'git', 'issue_tracker', 'note', 'other']),
              title: z.string(),
              start: z.string().optional().describe('ISO datetime'),
              end: z.string().optional().describe('ISO datetime'),
              duration_min: z.number().optional(),
              url: z.string().optional(),
              participants: z.array(z.string()).optional().describe('Emails; domains are matched to clients'),
              description: z.string().optional(),
            }),
          )
          .max(500),
        already_logged_handling: z.enum(['skip', 'flag']).optional().describe('Default "flag": include items that look already logged but mark them.'),
        target_hours_per_day: z.number().min(1).max(24).optional().describe('For gap detection. Default 8.'),
        default_duration_min: z.number().int().min(5).max(480).optional().describe('For items without a duration. Default varies by source (calendar 60, git 30, tickets 45).'),
      },
      annotations: { ...READ, title: 'Propose time entries from activity' },
    },
    guarded(ctx, 'time.propose_entries', async (args) => {
      const data = await proposeEntries(ctx, args as any);
      return { data, summary: `${data.summary.proposed_count} proposed (${data.summary.proposed_hours}h), ${data.summary.unmatched_count} unmatched, ${data.gaps.length} days with gaps` };
    }),
  );

  // ---------- Write tools: contained ----------
  server.registerTool(
    'time.log_entry',
    {
      title: 'Log a time entry',
      description:
        'Use this when the user states work they did with a duration or a start and end time, for today or a past date. Do not use for future plans, reminders, timers, or calendar scheduling. If the project is ambiguous this returns candidates instead of logging; ask the user and retry. Never auto-creates a project. Echoes the parsed duration and resolved date so you can confirm.',
      inputSchema: entryInput,
      annotations: { ...WRITE_IDEMPOTENT, title: 'Log a time entry' },
    },
    guarded(ctx, 'time.log_entry', async (args) => {
      const data = await logEntry(ctx, args as LogEntryInput);
      const summary =
        data.status === 'logged'
          ? `Logged ${data.entry.hours}h on ${data.entry.project ?? '(no project)'} for ${data.entry.date}`
          : data.status === 'duplicate'
            ? 'Possible duplicate; not logged'
            : data.status === 'error'
              ? `Not logged: ${data.error}`
              : 'Not logged: project needs clarification';
      return { data, summary };
    }),
  );

  server.registerTool(
    'time.log_entries_batch',
    {
      title: 'Log several time entries',
      description:
        'Use this when logging multiple entries at once: an end-of-day recap, a pasted list, or after time.propose_entries has been confirmed. Each entry is validated independently; partial success is reported per row with the same statuses as time.log_entry. Do not call before the user has confirmed proposed entries.',
      inputSchema: { entries: z.array(z.object(entryInput)).min(1).max(100) },
      annotations: { ...WRITE_IDEMPOTENT, title: 'Log several time entries' },
    },
    guarded(ctx, 'time.log_entries_batch', async (args) => {
      const data = await logBatch(ctx, args.entries as LogEntryInput[]);
      return { data, summary: `${data.summary.logged} logged (${data.summary.total_hours}h), ${data.summary.duplicates} duplicates, ${data.summary.needs_input} need input, ${data.summary.errors} errors` };
    }),
  );

  server.registerTool(
    'time.update_entry',
    {
      title: 'Edit a time entry',
      description:
        'Use this when the user corrects a duration, description, project, date, times, tags, or billable flag on an existing entry. Requires the entry id (from time.list_entries or a previous log result). Cannot edit entries already on a sent invoice; returns an error explaining why. Returns the previous and updated entry.',
      inputSchema: {
        entry_id: z.string(),
        description: z.string().max(500).optional(),
        duration: z.union([z.string(), z.number()]).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        date: dateSchema.optional(),
        project: z.string().optional(),
        billable: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        rate: z.number().nullable().optional(),
      },
      annotations: { ...MODIFY, title: 'Edit a time entry' },
    },
    guarded(ctx, 'time.update_entry', async (args) => {
      const data = await updateEntry(ctx, args);
      return { data, summary: 'ambiguous' in data ? 'Project needs clarification' : `Updated entry ${data.entry.id}` };
    }),
  );

  server.registerTool(
    'time.delete_entry',
    {
      title: 'Delete a time entry',
      description:
        'Use this only when the user explicitly asks to remove an entry. Requires confirm: true; when omitted it returns the entry for a final check without deleting. Entries on sent invoices cannot be deleted. To fix a mistake, prefer time.update_entry.',
      inputSchema: { entry_id: z.string(), confirm: z.boolean().optional().describe('Must be true to actually delete') },
      annotations: { ...MODIFY, title: 'Delete a time entry' },
    },
    guarded(ctx, 'time.delete_entry', async (args) => {
      const data = await deleteEntry(ctx, args.entry_id, Boolean(args.confirm));
      return { data, summary: data.deleted ? 'Deleted' : 'Awaiting confirmation' };
    }),
  );

  server.registerTool(
    'workspace.create_client',
    {
      title: 'Create a client',
      description:
        'Use this when the user names a client that does not exist and confirms it should be created, or asks to add a client with a rate or billing email. Do not create clients speculatively while logging time; ask first. Free plan allows one client; the error includes upgrade_url when the limit is hit.',
      inputSchema: {
        name: z.string().min(1).max(200),
        billing_email: z.string().email().optional(),
        address: z.string().max(500).optional(),
        rate: z.number().min(0).optional().describe('Default hourly rate for this client, in workspace currency'),
        net_terms_days: z.number().int().min(0).max(365).optional().describe('Default 30'),
      },
      annotations: { ...WRITE, title: 'Create a client' },
    },
    guarded(ctx, 'workspace.create_client', async (args) => {
      const c = await createClient(ctx, args);
      return { data: { client: publicClient(c) }, summary: `Created client ${c.name}` };
    }),
  );

  server.registerTool(
    'workspace.create_project',
    {
      title: 'Create a project',
      description:
        'Use this when the user names a project that does not exist and confirms it should be created, or asks to add one with a rate. Aliases help future fuzzy matching ("acme site", "landing page"). Do not create projects speculatively; ask first.',
      inputSchema: {
        name: z.string().min(1).max(200),
        client: z.string().optional().describe('Client name or id. Required for invoicing.'),
        rate: z.number().min(0).optional().describe('Hourly rate override; otherwise the client or workspace rate applies'),
        billable_default: z.boolean().optional().describe('Default true'),
        aliases: z.array(z.string()).optional(),
      },
      annotations: { ...WRITE, title: 'Create a project' },
    },
    guarded(ctx, 'workspace.create_project', async (args) => {
      const p = await createProject(ctx, args);
      return { data: { project: publicProject(p, ws) }, summary: `Created project ${p.name}${p.client_name ? ` for ${p.client_name}` : ''}` };
    }),
  );

  registerAppTool(
    server,
    'invoice.create_draft',
    {
      title: 'Create a draft invoice',
      description:
        'Use this when the user asks to invoice a client, bill for a period, or turn unbilled hours into an invoice. Creates a draft only; nothing is sent and the client cannot see it yet. Includes all unbilled billable entries for the client through through_date and marks them as invoiced. Show the draft to the user, then use invoice.send when they ask to send it.',
      inputSchema: {
        client: z.string(),
        through_date: dateSchema.optional().describe('Default: today'),
        group_lines_by: z.enum(['project', 'day', 'entry']).optional().describe('Default "project"'),
        due_in_days: z.number().int().min(0).max(365).optional().describe('Default: client net terms (30)'),
        notes: z.string().max(2000).optional(),
        tax_rate_percent: z.number().min(0).max(100).optional(),
      },
      annotations: { ...WRITE, title: 'Create a draft invoice' },
      _meta: uiMeta,
    },
    guarded(ctx, 'invoice.create_draft', async (args) => {
      const data = await createDraft(ctx, args);
      return { data, summary: `Draft ${data.number} for ${data.client.name}: ${data.total_formatted} (${data.total_hours}h), due ${data.due_date}. Not sent.` };
    }),
  );

  server.registerTool(
    'invoice.record_payment',
    {
      title: 'Record a manual payment',
      description: 'Use this when the user says a client paid by check, bank transfer, cash, or otherwise outside the Stripe payment link. Marks the invoice paid. Stripe payments are recorded automatically; do not use this for them.',
      inputSchema: {
        invoice_id: z.string().describe('Invoice id or number'),
        paid_on: dateSchema.optional().describe('Default: today'),
        method: z.string().max(100).optional().describe('e.g. "bank transfer", "check #1042"'),
        note: z.string().max(500).optional(),
      },
      annotations: { ...WRITE_IDEMPOTENT, title: 'Record a manual payment' },
    },
    guarded(ctx, 'invoice.record_payment', async (args) => {
      const data = await recordPayment(ctx, args);
      return { data, summary: `Invoice ${data.invoice.number} marked paid` };
    }),
  );

  // ---------- Write tools: external effect ----------
  server.registerTool(
    'invoice.send',
    {
      title: 'Send an invoice to the client',
      description:
        'Use this only after the user has reviewed the draft and asks to send it. Emails the invoice with a Stripe payment link to the client\'s billing email (or to_email) and changes the status to sent. Do not call to re-send unless the user asks. This sends a real email to a real person.',
      inputSchema: {
        invoice_id: z.string().describe('Invoice id or number'),
        to_email: z.string().email().optional().describe('Override or supply the recipient when the client has no billing email'),
        message: z.string().max(2000).optional().describe('Optional cover note in the user\'s voice'),
      },
      annotations: { ...EXTERNAL, title: 'Send an invoice to the client' },
    },
    guarded(ctx, 'invoice.send', async (args) => {
      const data = await sendInvoice(ctx, args);
      return { data, summary: `${data.resent ? 'Re-sent' : 'Sent'} invoice ${data.invoice.number} to ${data.to}${data.payment_link ? ' with payment link' : ''}` };
    }),
  );

  server.registerTool(
    'invoice.void',
    {
      title: 'Void an invoice',
      description:
        'Use this only when the user explicitly asks to void or cancel an invoice. Requires confirm: true; without it returns the invoice for a final check. Voiding releases its time entries so they can be invoiced again. Paid invoices cannot be voided.',
      inputSchema: { invoice_id: z.string(), reason: z.string().max(500).optional(), confirm: z.boolean().optional() },
      annotations: { ...EXTERNAL_DESTRUCTIVE, title: 'Void an invoice' },
    },
    guarded(ctx, 'invoice.void', async (args) => {
      const data = await voidInvoice(ctx, args);
      return { data, summary: data.voided ? `Voided ${data.invoice.number}` : 'Awaiting confirmation' };
    }),
  );

  // ---------- Prompts (mirror the bundled skills) ----------
  for (const skill of loadSkills()) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: skill.description,
        argsSchema: { input: z.string().optional().describe('What the user said, e.g. the recap, the client name, or the week') },
      },
      ({ input }) => ({
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `${skill.body}\n\n---\nUser input: ${input ?? '(none)'}` },
          },
        ],
      }),
    );
  }

  return server;
}
