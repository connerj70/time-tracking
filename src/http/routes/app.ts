import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { config } from '../../config.js';
import { readSession, clearSession } from '../../auth/session.js';
import { loadContext, planLimits, type Ctx } from '../../services/context.js';
import { listClients, listProjects, updateWorkspace } from '../../services/workspace.js';
import { report } from '../../services/time.js';
import { listInvoices } from '../../services/invoices.js';
import { importCsv, listImports } from '../../import/index.js';
import { recentAudit } from '../../services/audit.js';
import { createBillingCheckout, createConnectOnboarding, createPortalSession } from '../../stripe/index.js';
import { query } from '../../db/index.js';
import { isValidZone, todayIn, monthBounds } from '../../lib/dates.js';
import { esc, layout } from '../views/layout.js';
import { ToolError } from '../../lib/errors.js';

/** The four-page web app: overview, settings, import, billing. */
export const appRoutes = Router();
appRoutes.use(express.urlencoded({ extended: false }));

type AppReq = Request & { ctx: Ctx };

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const s = readSession(req);
  if (!s) return res.redirect(`/oauth/login?next=${encodeURIComponent(req.originalUrl)}`);
  try {
    (req as AppReq).ctx = await loadContext(s.userId, s.workspaceId);
    next();
  } catch {
    clearSession(res);
    res.redirect('/oauth/login');
  }
}
appRoutes.use(requireUser);

const page = (req: Request, title: string, body: string) => layout(title, body, { nav: true, wide: true, user: (req as AppReq).ctx.user });

appRoutes.get('/', async (req, res) => {
  const { ctx } = req as AppReq;
  const today = todayIn(ctx.workspace.timezone);
  const m = monthBounds(today);
  const [r, inv, clients, projects, audit] = await Promise.all([report(ctx, { start_date: m.start, end_date: m.end, group_by: 'client' }), listInvoices(ctx, { status: 'outstanding' }), listClients(ctx), listProjects(ctx), recentAudit(ctx.workspaceId, 15)]);
  res.send(
    page(
      req,
      'Overview',
      `<h1>${esc(ctx.workspace.name)}</h1><p class="muted">Plan: ${esc(ctx.workspace.plan)} · ${esc(ctx.workspace.timezone)} · ${esc(ctx.workspace.currency)} · today ${today}</p>
      <div class="card"><h2 style="margin-top:0">Connect to your assistant</h2>
        <p>MCP server URL: <code>${esc(config.mcpUrl)}</code></p>
        <p class="muted">Claude: Settings → Connectors → Add custom connector. ChatGPT: Settings → Connectors (Developer mode) → Create. Then say "log 2 hours on ${esc(projects[0]?.name ?? 'a project')}".</p></div>
      <div class="row">
        <div class="card"><h2 style="margin-top:0">This month</h2><p><b>${r.total_hours}h</b> total · ${r.billable_hours}h billable</p><p>Unbilled: <b>${esc(r.currency)} ${r.unbilled_amount.toFixed(2)}</b></p>
          <table>${r.groups.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.hours}h</td><td>${esc(r.currency)} ${g.unbilled_amount.toFixed(2)}</td></tr>`).join('') || '<tr><td class="muted">No entries yet</td></tr>'}</table></div>
        <div class="card"><h2 style="margin-top:0">Outstanding invoices</h2><p>${esc(inv.currency)} ${inv.outstanding_total.toFixed(2)} outstanding · ${inv.overdue_total.toFixed(2)} overdue</p>
          <table>${inv.invoices.map((i) => `<tr><td><a href="${esc(i.public_url)}">${esc(i.number)}</a></td><td>${esc(i.client)}</td><td><span class="pill ${i.status === 'overdue' ? 'bad' : ''}">${esc(i.status)}</span></td><td>${esc(i.total_formatted)}</td></tr>`).join('') || '<tr><td class="muted">Nothing outstanding</td></tr>'}</table></div>
      </div>
      <div class="card"><h2 style="margin-top:0">Clients &amp; projects</h2>
        <table>${clients.map((c) => `<tr><td><b>${esc(c.name)}</b><br><span class="muted">${esc(c.billing_email ?? 'no billing email')}</span></td><td>${projects.filter((p) => p.client_id === c.id).map((p) => `${esc(p.name)}${p.aliases.length ? ` <span class="muted">(${esc(p.aliases.join(', '))})</span>` : ''}`).join('<br>') || '<span class="muted">no projects</span>'}</td></tr>`).join('') || '<tr><td class="muted">No clients yet. Ask your assistant to create one.</td></tr>'}</table></div>
      <div class="card"><h2 style="margin-top:0">Recent assistant activity</h2>
        <table>${audit.map((a) => `<tr><td class="muted">${new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td><td><code>${esc(a.tool_name)}</code></td><td>${esc(a.result_summary)}</td></tr>`).join('') || '<tr><td class="muted">No tool calls yet</td></tr>'}</table></div>`,
    ),
  );
});

appRoutes.get('/settings', (req, res) => {
  const { ctx } = req as AppReq;
  const w = ctx.workspace;
  res.send(
    page(
      req,
      'Settings',
      `<h1>Settings</h1>${req.query.saved ? '<p class="ok">Saved.</p>' : ''}${req.query.error ? `<p class="err">${esc(req.query.error)}</p>` : ''}
      <form method="post" class="card">
        <label>Business name</label><input name="name" value="${esc(w.name)}" required>
        <label>Business address (shown on invoices)</label><textarea name="business_address" rows="3">${esc(w.business_address ?? '')}</textarea>
        <div class="row"><div><label>Default hourly rate</label><input name="default_rate" type="number" min="0" step="0.01" value="${(w.default_rate_cents / 100).toFixed(2)}"></div>
        <div><label>Currency (ISO 4217)</label><input name="currency" value="${esc(w.currency)}" maxlength="3" required></div></div>
        <div class="row"><div><label>Timezone (IANA)</label><input name="timezone" value="${esc(w.timezone)}" required></div>
        <div><label>Invoice number prefix</label><input name="invoice_prefix" value="${esc(w.invoice_prefix)}"></div></div>
        <label>Logo URL${planLimits(w).branding ? '' : ' (Pro)'}</label><input name="logo_url" value="${esc(w.logo_url ?? '')}" ${planLimits(w).branding ? '' : 'disabled'}>
        <p><button class="btn" type="submit">Save</button></p>
      </form>
      <div class="card"><h2 style="margin-top:0">Connected apps</h2><p class="muted">Revoke access from inside Claude or ChatGPT (remove the connector). Tokens expire after an hour and refresh automatically.</p></div>`,
    ),
  );
});

appRoutes.post('/settings', async (req, res) => {
  const { ctx } = req as AppReq;
  const tz = String(req.body.timezone ?? '').trim();
  if (!isValidZone(tz)) return res.redirect('/app/settings?error=' + encodeURIComponent(`Unknown timezone "${tz}"`));
  const currency = String(req.body.currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return res.redirect('/app/settings?error=Currency+must+be+a+3-letter+code');
  await updateWorkspace(ctx, {
    name: String(req.body.name ?? '').trim() || ctx.workspace.name,
    business_address: String(req.body.business_address ?? '').trim() || null,
    default_rate_cents: Math.round(Number(req.body.default_rate || 0) * 100),
    currency,
    timezone: tz,
    invoice_prefix: String(req.body.invoice_prefix ?? 'INV-'),
    ...(planLimits(ctx.workspace).branding ? { logo_url: String(req.body.logo_url ?? '').trim() || null } : {}),
  });
  res.redirect('/app/settings?saved=1');
});

appRoutes.get('/import', async (req, res) => {
  const { ctx } = req as AppReq;
  const imports = await listImports(ctx);
  const allowed = planLimits(ctx.workspace).imports;
  res.send(
    page(
      req,
      'Import',
      `<h1>Import from Toggl, Harvest, or Clockify</h1>
      <p class="muted">Export a CSV of detailed time entries from your old tracker and upload it. Clients and projects are created as needed; re-uploading the same file won't duplicate entries.</p>
      ${allowed ? '' : `<p class="warn">CSV import is a Pro feature. <a href="/app/billing">Upgrade</a></p>`}
      ${req.query.result ? `<div class="card"><pre style="white-space:pre-wrap;margin:0">${esc(req.query.result)}</pre></div>` : ''}
      <form method="post" enctype="multipart/form-data" class="card">
        <label>CSV file</label><input type="file" name="file" accept=".csv,text/csv" required>
        <label>Source (auto-detected if left blank)</label><select name="source"><option value="">Auto</option><option value="toggl">Toggl</option><option value="harvest">Harvest</option><option value="clockify">Clockify</option></select>
        <label><input type="checkbox" name="dry_run" value="1" style="width:auto"> Dry run (parse only)</label>
        <p><button class="btn" type="submit" ${allowed ? '' : 'disabled'}>Import</button></p>
      </form>
      <div class="card"><h2 style="margin-top:0">Previous imports</h2><table>${imports.map((i) => `<tr><td>${new Date(i.created_at).toISOString().slice(0, 10)}</td><td>${esc(i.source)}</td><td>${esc(i.filename)}</td><td>${i.rows_ok} ok / ${i.rows_failed} failed</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</table></div>`,
    ),
  );
});

appRoutes.post('/import', express.raw({ type: 'multipart/form-data', limit: '20mb' }), async (req, res) => {
  const { ctx } = req as AppReq;
  try {
    // Node's built-in multipart parser via the Fetch API: no extra dependency.
    const form = await new Response(new Uint8Array(req.body as Buffer), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new ToolError('No file uploaded', 'invalid');
    const source = String(form.get('source') ?? '') || undefined;
    const result = await importCsv(ctx, { text: await file.text(), filename: file.name, source: source as 'toggl' | 'harvest' | 'clockify' | undefined, dryRun: form.get('dry_run') === '1' });
    const summary = `${result.dry_run ? 'Dry run: ' : ''}${result.source}: ${result.rows_parsed} rows parsed, ${result.rows_ok} imported, ${result.duplicates} duplicates skipped, ${result.rows_failed} failed. Created ${result.created.clients} clients, ${result.created.projects} projects.${result.errors.length ? '\n\nErrors:\n' + result.errors.map((e) => `row ${e.row}: ${e.error}`).join('\n') : ''}`;
    res.redirect('/app/import?result=' + encodeURIComponent(summary));
  } catch (e) {
    res.redirect('/app/import?result=' + encodeURIComponent(`Import failed: ${(e as Error).message}`));
  }
});

appRoutes.get('/billing', async (req, res) => {
  const { ctx } = req as AppReq;
  const w = ctx.workspace;
  const [{ count: clientCount }] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM clients WHERE workspace_id = $1 AND archived = false`, [w.id]);
  const [{ count: invCount }] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM invoices WHERE workspace_id = $1 AND status <> 'void' AND created_at >= date_trunc('month', now())`, [w.id]);
  const stripeOn = config.stripe.enabled;
  res.send(
    page(
      req,
      'Billing',
      `<h1>Billing</h1>${req.query.upgraded ? '<p class="ok">Thanks! Your plan updates as soon as Stripe confirms the subscription.</p>' : ''}${req.query.error ? `<p class="err">${esc(req.query.error)}</p>` : ''}
      <div class="card"><h2 style="margin-top:0">Current plan: ${esc(w.plan)}</h2>
        <p>Clients: ${clientCount}${w.plan === 'free' ? ' / 1' : ''} · Invoices this month: ${invCount}${w.plan === 'free' ? ' / 2' : ''}</p>
        ${w.stripe_customer_id && stripeOn ? `<form method="post" action="/app/billing/portal"><button class="btn secondary">Manage subscription</button></form>` : ''}
      </div>
      <div class="row">
        <div class="card"><h2 style="margin-top:0">Free</h2><p>Unlimited time entries · 1 client · 2 invoices/month</p><p class="muted">$0</p></div>
        <div class="card"><h2 style="margin-top:0">Pro</h2><p>Unlimited clients and invoices · PDF branding · CSV export · imports</p><p><b>$12/month</b></p>${stripeOn && w.plan !== 'pro' ? `<form method="post" action="/app/billing/checkout"><input type="hidden" name="plan" value="pro"><button class="btn">Upgrade to Pro</button></form>` : ''}</div>
        <div class="card"><h2 style="margin-top:0">Team</h2><p>Everything in Pro · shared clients/projects · per-member reports</p><p><b>$8/seat/month</b></p>${stripeOn && w.plan !== 'team' ? `<form method="post" action="/app/billing/checkout"><input type="hidden" name="plan" value="team"><input name="seats" type="number" min="1" value="2" style="width:80px;display:inline-block"> seats <button class="btn">Upgrade to Team</button></form>` : ''}</div>
      </div>
      ${stripeOn ? '' : '<p class="muted">Stripe is not configured on this server; upgrades are disabled.</p>'}
      <div class="card"><h2 style="margin-top:0">Getting paid</h2>
        <p>Invoices include a Stripe payment link. ${w.stripe_connect_account_id ? `Payments settle to your connected Stripe account (<code>${esc(w.stripe_connect_account_id)}</code>).` : 'Connect your Stripe account so client payments settle directly to you.'}</p>
        ${stripeOn ? `<form method="post" action="/app/billing/connect"><button class="btn secondary">${w.stripe_connect_account_id ? 'Update Stripe account' : 'Connect Stripe'}</button></form>` : ''}
      </div>`,
    ),
  );
});

appRoutes.post('/billing/checkout', async (req, res) => {
  const { ctx } = req as AppReq;
  try {
    const url = await createBillingCheckout({ workspace: ctx.workspace, email: ctx.user.email, plan: req.body.plan === 'team' ? 'team' : 'pro', seats: Number(req.body.seats) || 1 });
    res.redirect(url);
  } catch (e) {
    res.redirect('/app/billing?error=' + encodeURIComponent((e as Error).message));
  }
});
appRoutes.post('/billing/portal', async (req, res) => {
  const { ctx } = req as AppReq;
  try {
    res.redirect(await createPortalSession(ctx.workspace));
  } catch (e) {
    res.redirect('/app/billing?error=' + encodeURIComponent((e as Error).message));
  }
});
appRoutes.post('/billing/connect', async (req, res) => {
  const { ctx } = req as AppReq;
  try {
    const { url, accountId } = await createConnectOnboarding(ctx.workspace, ctx.user.email);
    await query(`UPDATE workspaces SET stripe_connect_account_id = $2 WHERE id = $1`, [ctx.workspaceId, accountId]);
    res.redirect(url);
  } catch (e) {
    res.redirect('/app/billing?error=' + encodeURIComponent((e as Error).message));
  }
});

/** Screenshot/preview surface for directory submissions: renders the MCP App bundle with live data injected. */
appRoutes.get('/preview', async (req, res) => {
  const { ctx } = req as AppReq;
  const { loadAppHtml } = await import('../../mcp/app-resource.js');
  const app = loadAppHtml();
  if (!app) return res.status(503).send('Run `npm run build:app` first');
  const view = String(req.query.view ?? 'week_grid');
  let data: unknown;
  if (view === 'invoice') {
    const inv = await listInvoices(ctx, { status: 'all', limit: 1 });
    if (!inv.invoices.length) return res.status(404).send('No invoices to preview');
    const { getInvoice } = await import('../../services/invoices.js');
    data = await getInvoice(ctx, String(req.query.id ?? inv.invoices[0].id));
  } else if (view === 'report') {
    data = { view: 'report', ...(await report(ctx, { group_by: 'client', start_date: String(req.query.start ?? '') || undefined, end_date: String(req.query.end ?? '') || undefined })) };
  } else {
    data = { view: 'week_grid', ...(await report(ctx, { group_by: 'day', start_date: String(req.query.start ?? '') || undefined, end_date: String(req.query.end ?? '') || undefined })) };
  }
  const inject = `<script>window.__TALLY_DATA__=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
  res.send(app.replace('<head>', `<head>${inject}`));
});

appRoutes.get('/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/oauth/login');
});
