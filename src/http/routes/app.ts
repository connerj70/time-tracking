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
import { formatMoney } from '../../lib/money.js';
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

const page = (req: Request, title: string, body: string) =>
  layout(title, body, {
    nav: true,
    width: 'app',
    user: (req as AppReq).ctx.user,
    active: req.path === '/' ? '' : req.path.replace(/\/+$/, ''),
  });

const money = (amount: number, currency: string) => esc(formatMoney(Math.round(amount * 100), currency));
const hrs = (h: number) => h.toFixed(2);
/** Flash messages from the redirect-after-post pattern. */
const flash = (req: Request, okText?: string) =>
  `${req.query.saved || req.query.upgraded ? `<p class="notice ok">${esc(okText ?? 'Saved.')}</p>` : ''}` +
  `${req.query.error ? `<p class="notice err">${esc(req.query.error)}</p>` : ''}`;

/** Plan comparison. The current plan is marked with the brand slash rather than a coloured border. */
function planCard(name: string, price: string, features: string[], current: boolean, action: string): string {
  return `<section class="panel"${current ? ' style="border-color:var(--rule-2)"' : ''}>
    <div class="panel-hd"><h2>${esc(name)}</h2>${current ? '<span class="pill">Your plan</span>' : ''}</div>
    <p style="font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 12px"><span${current ? ' class="marker"' : ''}>${esc(price)}</span></p>
    <ul class="scopes" style="margin-top:0">${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    ${action ? `<div class="actions">${action}</div>` : ''}
  </section>`;
}

interface OverviewData {
  ctx: Ctx;
  today: string;
  r: Awaited<ReturnType<typeof report>>;
  inv: Awaited<ReturnType<typeof listInvoices>>;
  clients: Awaited<ReturnType<typeof listClients>>;
  projects: Awaited<ReturnType<typeof listProjects>>;
  audit: Awaited<ReturnType<typeof recentAudit>>;
}

function overviewBody({ ctx, today, r, inv, clients, projects, audit }: OverviewData): string {
  const w = ctx.workspace;
  const blank = clients.length === 0 && r.entry_count === 0;
  const example = projects[0]?.name ?? 'the Acme redesign';

  const connect = `<section class="panel">
    <div class="panel-hd"><h2>${blank ? 'Start by connecting your assistant' : 'Connect another assistant'}</h2></div>
    <p class="muted">Add this server as a connector, then describe your work in the chat. There is nothing to install.</p>
    <p><code>${esc(config.mcpUrl)}</code></p>
    <table>
      <tbody>
        <tr><td>Claude</td><td class="muted">Settings, then Connectors, then Add custom connector</td></tr>
        <tr><td>ChatGPT</td><td class="muted">Settings, then Connectors in developer mode, then Create</td></tr>
        <tr><td>Claude&nbsp;Code</td><td class="muted"><code>claude mcp add --transport http tallied ${esc(config.mcpUrl)}</code></td></tr>
      </tbody>
    </table>
    <p class="hint">Then try saying: “log 2 hours on ${esc(example)}”.</p>
  </section>`;

  const figures = `<div class="figures">
    <div><span class="k">Hours this month</span><span class="v">${hrs(r.total_hours)}</span></div>
    <div><span class="k">Billable</span><span class="v">${hrs(r.billable_hours)}</span></div>
    <div class="marked"><span class="k">Unbilled</span><span class="v">${money(r.unbilled_amount, r.currency)}</span></div>
    <div><span class="k">Awaiting payment</span><span class="v">${money(inv.outstanding_total, inv.currency)}</span></div>
  </div>`;

  const byClient = `<section class="panel">
    <div class="panel-hd"><h2>This month by client</h2><span class="muted">${r.range.start} to ${r.range.end}</span></div>
    ${
      r.groups.length
        ? `<table><thead><tr><th>Client</th><th class="r">Hours</th><th class="r">Unbilled</th></tr></thead><tbody>
            ${r.groups.map((g) => `<tr><td>${esc(g.label)}</td><td class="r">${hrs(g.hours)}</td><td class="r">${money(g.unbilled_amount, r.currency)}</td></tr>`).join('')}
          </tbody></table>`
        : `<p class="empty">No time logged this month yet.</p>`
    }
  </section>`;

  const invoices = `<section class="panel">
    <div class="panel-hd"><h2>Awaiting payment</h2>${inv.overdue_total > 0 ? `<span class="pill bad">${money(inv.overdue_total, inv.currency)} overdue</span>` : ''}</div>
    ${
      inv.invoices.length
        ? `<table><thead><tr><th>Invoice</th><th>Client</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
            ${inv.invoices
              .map(
                (i) => `<tr><td><a href="${esc(i.public_url)}">${esc(i.number)}</a></td><td>${esc(i.client)}</td>
                  <td><span class="pill ${i.status === 'overdue' ? 'bad' : i.status === 'paid' ? 'ok' : ''}">${esc(i.status)}</span></td>
                  <td class="r">${esc(i.total_formatted)}</td></tr>`,
              )
              .join('')}
          </tbody></table>`
        : `<p class="empty">Nothing outstanding. ${blank ? '' : 'Ask your assistant what you could invoice.'}</p>`
    }
  </section>`;

  const book = `<section class="panel">
    <div class="panel-hd"><h2>Clients and projects</h2><span class="muted">Ask your assistant to add or change these</span></div>
    ${
      clients.length
        ? `<table><thead><tr><th>Client</th><th>Projects</th><th class="r">Rate</th></tr></thead><tbody>
            ${clients
              .map((c) => {
                const ps = projects.filter((p) => p.client_id === c.id);
                return `<tr><td>${esc(c.name)}<span class="sub">${esc(c.billing_email ?? 'No billing email yet')}</span></td>
                  <td>${ps.length ? ps.map((p) => esc(p.name) + (p.aliases.length ? `<span class="sub">also called ${esc(p.aliases.join(', '))}</span>` : '')).join('<br>') : '<span class="muted">No projects</span>'}</td>
                  <td class="r">${c.default_rate_cents != null ? money(c.default_rate_cents / 100, w.currency) : `<span class="muted">${money(w.default_rate_cents / 100, w.currency)}</span>`}</td></tr>`;
              })
              .join('')}
          </tbody></table>`
        : `<p class="empty">No clients yet. Once you are connected, say “add a client called Acme at 150 an hour”.</p>`
    }
  </section>`;

  const stamp = (d: string | Date) => {
    const t = new Date(d);
    return `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  };
  const activity = `<section class="panel">
    <div class="panel-hd"><h2>Recent assistant activity</h2><span class="muted">Every action taken on your behalf</span></div>
    ${
      audit.length
        ? `<table><thead><tr><th>When</th><th>Action</th><th>Result</th></tr></thead><tbody>
            ${audit.map((a: any) => `<tr><td class="muted">${esc(stamp(a.created_at))}</td><td><code>${esc(a.tool_name)}</code></td><td class="${a.ok ? '' : 'err'}">${esc(a.result_summary)}</td></tr>`).join('')}
          </tbody></table>`
        : `<p class="empty">Nothing yet. Actions your assistant takes will be listed here.</p>`
    }
  </section>`;

  return `<h1>${esc(w.name)}</h1>
    <p class="lede">Everything here can also be done by asking your assistant.</p>
    <dl class="facts">
      <div><dt>Plan</dt><dd>${esc(w.plan === 'free' ? 'Free' : w.plan === 'pro' ? 'Pro' : 'Team')}</dd></div>
      <div><dt>Currency</dt><dd>${esc(w.currency)}</dd></div>
      <div><dt>Time zone</dt><dd>${esc(w.timezone)}</dd></div>
      <div><dt>Today</dt><dd>${esc(today)}</dd></div>
    </dl>
    ${blank ? connect : ''}
    ${figures}
    <div class="grid">${byClient}${invoices}</div>
    ${book}
    ${activity}
    ${blank ? '' : connect}`;
}

appRoutes.get('/', async (req, res) => {
  const { ctx } = req as AppReq;
  const today = todayIn(ctx.workspace.timezone);
  const m = monthBounds(today);
  const [r, inv, clients, projects, audit] = await Promise.all([report(ctx, { start_date: m.start, end_date: m.end, group_by: 'client' }), listInvoices(ctx, { status: 'outstanding' }), listClients(ctx), listProjects(ctx), recentAudit(ctx.workspaceId, 15)]);
  res.send(
    page(
      req,
      'Overview',
      overviewBody({ ctx, today, r, inv, clients, projects, audit }),
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
      `<h1>Settings</h1>
      <p class="lede">These details appear on your invoices and set the defaults your assistant uses.</p>
      ${flash(req, 'Settings saved.')}
      <form method="post">
        <section class="panel">
          <div class="panel-hd"><h2>Your business</h2></div>
          <div class="field"><label for="name">Business name</label><input id="name" name="name" value="${esc(w.name)}" required>
            <p class="hint">Shown as the sender on every invoice.</p></div>
          <div class="field"><label for="addr">Address</label><textarea id="addr" name="business_address" rows="3" placeholder="Street, city, postal code">${esc(w.business_address ?? '')}</textarea></div>
          <div class="field"><label for="logo">Logo URL${planLimits(w).branding ? '' : ' — available on Pro'}</label>
            <input id="logo" name="logo_url" value="${esc(w.logo_url ?? '')}" placeholder="https://" ${planLimits(w).branding ? '' : 'disabled'}>
            ${planLimits(w).branding ? '' : '<p class="hint"><a href="/app/billing">Upgrade to Pro</a> to put your logo on invoices.</p>'}</div>
        </section>
        <section class="panel">
          <div class="panel-hd"><h2>Billing defaults</h2></div>
          <div class="row">
            <div class="field"><label for="rate">Default hourly rate</label><input id="rate" name="default_rate" type="number" min="0" step="0.01" value="${(w.default_rate_cents / 100).toFixed(2)}">
              <p class="hint">Used when a project or client has no rate of its own.</p></div>
            <div class="field"><label for="cur">Currency</label><input id="cur" name="currency" value="${esc(w.currency)}" maxlength="3" required>
              <p class="hint">Three-letter code, such as USD or EUR.</p></div>
          </div>
          <div class="row">
            <div class="field"><label for="tz">Time zone</label><input id="tz" name="timezone" value="${esc(w.timezone)}" required>
              <p class="hint">Decides what “today” means when you log time.</p></div>
            <div class="field"><label for="pfx">Invoice number prefix</label><input id="pfx" name="invoice_prefix" value="${esc(w.invoice_prefix)}">
              <p class="hint">Your next invoice will be ${esc(w.invoice_prefix)}${String(w.next_invoice_number).padStart(4, '0')}.</p></div>
          </div>
          <div class="actions"><button class="btn primary" type="submit">Save changes</button></div>
        </section>
      </form>
      <section class="panel">
        <div class="panel-hd"><h2>Connected assistants</h2></div>
        <p class="muted">To revoke access, remove the connector inside Claude or ChatGPT. Access tokens last one hour and refresh automatically until you revoke them.</p>
      </section>`,
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
      `<h1>Bring your history with you</h1>
      <p class="lede">Upload a detailed time export from Toggl, Harvest, or Clockify. Missing clients and projects are created for you, and uploading the same file twice will not duplicate anything.</p>
      ${allowed ? '' : `<p class="notice">CSV import is part of Pro. <a href="/app/billing">See plans</a>.</p>`}
      ${req.query.result ? `<section class="panel"><div class="panel-hd"><h2>Import result</h2></div><pre style="white-space:pre-wrap;margin:0;font-size:13.5px">${esc(req.query.result)}</pre></section>` : ''}
      <form method="post" enctype="multipart/form-data">
        <section class="panel">
          <div class="panel-hd"><h2>Upload a file</h2></div>
          <div class="field"><label for="file">CSV file</label><input id="file" type="file" name="file" accept=".csv,text/csv" required></div>
          <div class="field"><label for="src">Where it came from</label>
            <select id="src" name="source"><option value="">Detect automatically</option><option value="toggl">Toggl</option><option value="harvest">Harvest</option><option value="clockify">Clockify</option></select></div>
          <div class="field"><label style="color:var(--ink)"><input type="checkbox" name="dry_run" value="1"> Check the file without importing</label>
            <p class="hint">Parses every row and reports what would happen, then stops.</p></div>
          <div class="actions"><button class="btn primary" type="submit" ${allowed ? '' : 'disabled'}>Import entries</button></div>
        </section>
      </form>
      <section class="panel">
        <div class="panel-hd"><h2>Previous imports</h2></div>
        ${
          imports.length
            ? `<table><thead><tr><th>Date</th><th>Source</th><th>File</th><th class="r">Imported</th><th class="r">Failed</th></tr></thead><tbody>
                ${imports.map((i: any) => `<tr><td>${esc(new Date(i.created_at).toISOString().slice(0, 10))}</td><td>${esc(i.source)}</td><td class="muted">${esc(i.filename ?? '—')}</td><td class="r">${i.rows_ok}</td><td class="r ${i.rows_failed ? 'err' : 'muted'}">${i.rows_failed}</td></tr>`).join('')}
              </tbody></table>`
            : '<p class="empty">No imports yet.</p>'
        }
      </section>`,
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
      `<h1>Plan and payments</h1>
      <p class="lede">You are on ${esc(w.plan === 'free' ? 'the free plan' : w.plan === 'pro' ? 'Pro' : 'Team')}.</p>
      ${flash(req, 'Thanks. Your plan updates as soon as Stripe confirms the subscription.')}
      <div class="figures">
        <div><span class="k">Clients</span><span class="v">${clientCount}${w.plan === 'free' ? ' <span class="muted" style="font-size:15px">of 1</span>' : ''}</span></div>
        <div><span class="k">Invoices this month</span><span class="v">${invCount}${w.plan === 'free' ? ' <span class="muted" style="font-size:15px">of 2</span>' : ''}</span></div>
        <div><span class="k">Time entries</span><span class="v">Unlimited</span></div>
      </div>
      ${w.stripe_customer_id && stripeOn ? `<form method="post" action="/app/billing/portal" class="actions" style="margin:0 0 24px"><button class="btn secondary">Manage subscription</button></form>` : ''}
      <div class="grid">
        ${planCard('Free', '$0', ['Unlimited time entries', 'One client', 'Two invoices a month'], w.plan === 'free', '')}
        ${planCard('Pro', '$12 a month', ['Unlimited clients and invoices', 'Your logo on invoices', 'CSV export and imports'], w.plan === 'pro', stripeOn && w.plan !== 'pro' ? `<form method="post" action="/app/billing/checkout"><input type="hidden" name="plan" value="pro"><button class="btn primary block">Upgrade to Pro</button></form>` : '')}
        ${planCard('Team', '$8 per seat, a month', ['Everything in Pro', 'Shared clients and projects', 'Reports for each member'], w.plan === 'team', stripeOn && w.plan !== 'team' ? `<form method="post" action="/app/billing/checkout"><div class="field"><label for="seats">Seats</label><input id="seats" name="seats" type="number" min="1" value="2"></div><input type="hidden" name="plan" value="team"><button class="btn secondary block">Upgrade to Team</button></form>` : '')}
      </div>
      ${stripeOn ? '' : '<p class="notice">Stripe is not configured on this server, so upgrades are turned off.</p>'}
      <section class="panel">
        <div class="panel-hd"><h2>Getting paid by your clients</h2>${w.stripe_connect_account_id ? '<span class="pill ok">Connected</span>' : ''}</div>
        <p class="muted">${w.stripe_connect_account_id ? `Invoice payments settle directly to your Stripe account <code>${esc(w.stripe_connect_account_id)}</code>.` : 'Every invoice carries a payment link. Connect your Stripe account so those payments go straight to you rather than through us.'}</p>
        ${stripeOn ? `<div class="actions"><form method="post" action="/app/billing/connect"><button class="btn ${w.stripe_connect_account_id ? 'secondary' : 'primary'}">${w.stripe_connect_account_id ? 'Update Stripe account' : 'Connect Stripe'}</button></form></div>` : ''}
      </section>`,
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
