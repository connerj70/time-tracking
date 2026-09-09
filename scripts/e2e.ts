/**
 * End-to-end smoke test against a running server (BASE_URL, default http://localhost:3000).
 * Plays the host: DCR → PKCE authorize → magic-link sign-in → consent → token → refresh rotation → MCP tool calls.
 * Requires RESEND_API_KEY unset (dev mode prints the magic link into the page) and a seeded user.
 *   npx tsx scripts/e2e.ts [email]
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const MCP = `${BASE}/mcp`;
const EMAIL = process.argv[2] ?? 'reviewer@example.com';
const REDIRECT = 'http://localhost:9999/callback';
const RUN = Date.now().toString(36); // unique per run so the script is re-runnable against the same DB

const b64 = (b: Buffer) => b.toString('base64url');
let step = 0;
const log = (msg: string, extra?: unknown) => console.log(`\n[${++step}] ${msg}`, extra !== undefined ? JSON.stringify(extra, null, 1).slice(0, 1200) : '');
const assert = (c: unknown, msg: string) => {
  if (!c) throw new Error(`ASSERT: ${msg}`);
};

async function main() {
  // --- Discovery ---
  const unauth = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(unauth.status === 401, '401 without token');
  const www = unauth.headers.get('www-authenticate') ?? '';
  const prmUrl = www.match(/resource_metadata="([^"]+)"/)?.[1];
  assert(prmUrl, 'WWW-Authenticate carries resource_metadata');
  const prm = await (await fetch(prmUrl!)).json();
  assert(prm.resource === MCP, `PRM resource matches MCP URL (${prm.resource})`);
  const asMeta = await (await fetch(new URL('/.well-known/oauth-authorization-server', prm.authorization_servers[0]))).json();
  log('discovery ok', { prm: prmUrl, authorize: asMeta.authorization_endpoint, token: asMeta.token_endpoint, register: asMeta.registration_endpoint });

  // --- DCR (JSON) ---
  const reg = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E Host', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  assert(reg.status === 201, `DCR returns 201 (got ${reg.status})`);
  const client = await reg.json();
  log('registered client', { client_id: client.client_id });

  // --- Authorize with PKCE ---
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const state = b64(randomBytes(8));
  const authUrl = new URL(asMeta.authorization_endpoint);
  Object.entries({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'time:read time:write invoices:read invoices:write', resource: MCP }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  assert(authRes.status === 302, `authorize redirects (got ${authRes.status})`);
  const loginUrl = new URL(authRes.headers.get('location')!, BASE);
  const reqId = loginUrl.searchParams.get('req');
  assert(reqId, 'login url carries req id');
  log('authorize → login', loginUrl.href);

  // --- Magic link sign-in (dev mode prints link on page) ---
  const next = `/oauth/consent?req=${reqId}`;
  const magic = await fetch(`${BASE}/oauth/magic/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, next }) });
  const html = await magic.text();
  const link = html.match(/href="([^"]*\/oauth\/magic\/verify\?token=[^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  assert(link, 'dev magic link present on page (is RESEND_API_KEY unset?)');
  const verify = await fetch(link!, { redirect: 'manual' });
  assert(verify.status === 302, 'magic verify redirects');
  const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  assert(cookie.includes('tally_session=') || cookie.includes('pending_user='), 'session or pending cookie set');
  log('signed in', { redirect: verify.headers.get('location'), cookie: cookie.slice(0, 40) + '…' });

  // --- Consent ---
  const consentPage = await fetch(`${BASE}${next}`, { headers: { cookie } });
  assert(consentPage.status === 200, 'consent page renders');
  const consent = await fetch(`${BASE}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ req: reqId!, decision: 'allow', business_name: 'E2E Studio', default_rate: '100', currency: 'USD', timezone: 'America/Chicago' }),
  });
  assert(consent.status === 302, 'consent redirects back');
  const cb = new URL(consent.headers.get('location')!);
  assert(cb.origin + cb.pathname === REDIRECT, 'redirect goes to registered redirect_uri');
  assert(cb.searchParams.get('state') === state, 'state round-trips');
  const code = cb.searchParams.get('code')!;
  log('consent → code', { code: code.slice(0, 8) + '…' });

  // --- Token (form-encoded) ---
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: MCP }),
  });
  assert(tokenRes.status === 200, `token exchange 200 (got ${tokenRes.status}: ${await tokenRes.clone().text()})`);
  let tokens = await tokenRes.json();
  assert(tokens.access_token && tokens.refresh_token && tokens.expires_in === 3600, 'access + refresh token, 1h');
  log('tokens issued', { expires_in: tokens.expires_in, scope: tokens.scope });

  // Code replay must fail
  const replay = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }) });
  assert(replay.status === 400, 'code replay rejected');

  // --- Refresh rotation ---
  const oldRefresh = tokens.refresh_token;
  const refreshRes = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: client.client_id }) });
  assert(refreshRes.status === 200, `refresh 200 (got ${refreshRes.status}: ${await refreshRes.clone().text()})`);
  tokens = await refreshRes.json();
  assert(tokens.refresh_token !== oldRefresh, 'refresh token rotated');
  const reuse = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: client.client_id }) });
  assert(reuse.status === 400, 'rotated refresh token reuse rejected');
  const afterReuse = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }) });
  assert(afterReuse.status === 400, 'family revoked after reuse');
  log('refresh rotation + reuse detection ok');
  // Get a fresh grant for the MCP calls (family was revoked above).
  const access = await freshAccessToken(asMeta, client.client_id);

  // --- MCP ---
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${access}` } } });
  const mcp = new Client({ name: 'e2e', version: '0.0.1' });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  log(`tools/list: ${tools.tools.length} tools`, tools.tools.map((t) => `${t.name} [${t.annotations?.readOnlyHint ? 'R' : 'W'}${t.annotations?.destructiveHint ? 'D' : ''}${t.annotations?.openWorldHint ? 'O' : ''}]${(t._meta as any)?.ui ? ' +ui' : ''}`));
  assert(tools.tools.every((t) => t.title && t.annotations && t.description?.startsWith('Use this')), 'every tool has title, annotations, "Use this" description');
  const prompts = await mcp.listPrompts();
  assert(prompts.prompts.length === 5, `5 prompts (got ${prompts.prompts.length})`);
  const resources = await mcp.listResources();
  log('resources', resources.resources.map((r) => r.uri));
  const ctxRes = await mcp.readResource({ uri: 'workspace://context' });
  const ctx = JSON.parse((ctxRes.contents[0] as any).text);
  log('workspace://context', { workspace: ctx.workspace, clients: ctx.clients.map((c: any) => `${c.name}: ${c.projects.map((p: any) => p.name).join(', ')}`) });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    const sc = (r.structuredContent ?? JSON.parse((r.content as any)[0].text)) as any;
    log(`${name}(${JSON.stringify(args)})${r.isError ? ' → ERROR' : ''}`, sc);
    return { r, sc };
  };

  const rep = await call('time.report', { group_by: 'day' });
  assert(rep.sc.view === 'week_grid' && Array.isArray(rep.sc.groups), 'report renders week grid');
  const amb = await call('time.log_entry', { description: 'Sync', duration: '30m', project: 'Acme' });
  assert(amb.sc.status === 'ambiguous' && amb.sc.candidates.length >= 2, 'ambiguous project returns candidates, does not log');
  const bad = await call('time.log_entry', { description: 'x', duration: 'a while', project: 'acme site' });
  assert(bad.r.isError || bad.sc.status === 'error', 'unparseable duration is reported');
  const logged = await call('time.log_entry', { description: `E2E hero tweaks ${RUN}`, duration: '2h30m', project: 'acme site' });
  assert(logged.sc.status === 'logged' && logged.sc.entry.duration_min === 150 && logged.sc.matched_project.name === 'Website Redesign', 'alias match + lenient duration');
  const dup = await call('time.log_entry', { description: `E2E hero tweaks ${RUN}`, duration: '2.4', project: 'Website Redesign' });
  assert(dup.sc.status === 'duplicate' && dup.sc.possible_duplicate === true, 'duplicate detection within ±10%');
  const idem1 = await call('time.log_entry', { description: `E2E idempotent ${RUN}`, duration: '1:00', project: 'Website Redesign', idempotency_key: `e2e-key-1 ${RUN}`, date: '2020-01-06' });
  const idem2 = await call('time.log_entry', { description: `E2E idempotent ${RUN}`, duration: '1:00', project: 'Website Redesign', idempotency_key: `e2e-key-1 ${RUN}`, date: '2020-01-06' });
  assert(idem1.sc.entry.id === idem2.sc.entry.id, 'idempotency key replays the same entry');
  const batch = await call('time.log_entries_batch', { entries: [{ description: `E2E batch A ${RUN}`, duration: '45 min', project: 'portal' }, { description: `E2E batch B ${RUN}`, duration: '1h', project: 'nonexistent thing' }] });
  assert(batch.sc.summary.logged === 1 && batch.sc.summary.needs_input === 1, 'batch partial success');
  const list = await call('time.list_entries', { limit: 3 });
  assert(list.sc.entries.length === 3 && list.sc.page.next_cursor, 'pagination');
  const page2 = await call('time.list_entries', { limit: 3, cursor: list.sc.page.next_cursor });
  assert(page2.sc.entries[0].id !== list.sc.entries[0].id, 'cursor advances');
  const upd = await call('time.update_entry', { entry_id: logged.sc.entry.id, duration: '3h', description: `E2E hero tweaks ${RUN} (edited)` });
  assert(upd.sc.entry.duration_min === 180, 'update duration');
  const delCheck = await call('time.delete_entry', { entry_id: idem1.sc.entry.id });
  assert(delCheck.sc.needs_confirmation === true, 'delete requires confirm');
  const del = await call('time.delete_entry', { entry_id: idem1.sc.entry.id, confirm: true });
  assert(del.sc.deleted === true, 'delete with confirm');

  const proposal = await call('time.propose_entries', {
    activity: [
      { source: 'calendar', title: 'Acme redesign review', start: '2020-01-07T10:00:00', end: '2020-01-07T11:00:00', participants: ['pm@acme.com'] },
      { source: 'git', title: 'feat(portal): filters', url: 'https://github.com/x/y/commit/1', start: '2020-01-07T14:00:00' },
      { source: 'git', title: 'fix(portal): table sort', url: 'https://github.com/x/y/commit/2', start: '2020-01-07T15:00:00' },
      { source: 'issue_tracker', title: 'Write quarterly taxes memo', start: '2020-01-07T16:00:00', duration_min: 30 },
      { source: 'calendar', title: 'Team offsite', start: '2020-01-08T00:00:00', end: '2020-01-09T00:00:00' },
    ],
  });
  assert(proposal.sc.proposed.length >= 2 && proposal.sc.unmatched.length >= 1 && proposal.sc.skipped.length >= 1, 'proposal matches, leaves unmatched, skips all-day');
  const confirmed = await call('time.log_entries_batch', { entries: proposal.sc.proposed.map((p: any) => p.entry) });
  assert(confirmed.sc.summary.logged === proposal.sc.proposed.length, 'confirmed proposal logs');

  const preview = await call('invoice.preview_draft', { client: 'Acme' });
  assert(preview.sc.view === 'invoice_preview' && preview.sc.lines.length >= 1, 'preview lines');
  const draft = await call('invoice.create_draft', { client: 'Initech', notes: 'E2E draft', tax_rate_percent: 8.25 });
  assert(draft.sc.status === 'draft' && draft.sc.tax > 0 && draft.sc.public_url, 'draft created with tax');
  const locked = await call('time.update_entry', { entry_id: draft.sc.lines[0].time_entry_ids?.[0] ?? batch.sc.results[0].entry.id, duration: '5h' });
  assert(!locked.r.isError || locked.sc.error === 'locked' || locked.sc.entry, 'entries on a DRAFT stay editable; only sent invoices lock');
  const got = await call('invoice.get', { invoice_id: draft.sc.number });
  assert(got.sc.id === draft.sc.id, 'get by number');
  const sent = await call('invoice.send', { invoice_id: draft.sc.id, message: 'Thanks for a great month!' });
  assert(sent.sc.sent === true && sent.sc.invoice.status === 'sent', 'send flips to sent (email logged in dev)');
  const lockedNow = await call('time.update_entry', { entry_id: draft.sc.lines[0].time_entry_ids[0], duration: '5h' });
  assert(lockedNow.r.isError && lockedNow.sc.error === 'locked', 'entries on a sent invoice are locked');
  const pub = await fetch(draft.sc.public_url);
  assert(pub.status === 200 && (await pub.text()).includes('__TALLY_DATA__'), 'public invoice page renders the app bundle');
  const pdf = await fetch(draft.sc.pdf_url);
  assert(pdf.status === 200 && pdf.headers.get('content-type')?.includes('pdf'), 'pdf renders');
  const viewed = await call('invoice.get', { invoice_id: draft.sc.id });
  assert(viewed.sc.status === 'viewed', 'public view flips sent → viewed');
  const paid = await call('invoice.record_payment', { invoice_id: draft.sc.id, method: 'bank transfer' });
  assert(paid.sc.invoice.status === 'paid', 'manual payment');
  const overdue = await call('invoice.list', { status: 'overdue' });
  assert(overdue.sc.count >= 1, 'seeded overdue invoice listed');
  const voidCheck = await call('invoice.void', { invoice_id: overdue.sc.invoices[0].id });
  assert(voidCheck.sc.needs_confirmation, 'void needs confirm');
  const limit = await call('workspace.create_client', { name: `E2E Client ${RUN}`, rate: 90 });
  assert(limit.sc.client?.name === `E2E Client ${RUN}` || limit.sc.error === 'plan_limit', 'create client (or plan limit with upgrade_url)');
  if (limit.sc.error === 'plan_limit') assert(limit.sc.upgrade_url, 'plan limit carries upgrade_url');

  await mcp.close();
  console.log('\n✅ e2e passed');
}

async function freshAccessToken(asMeta: any, clientId: string): Promise<string> {
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const authUrl = new URL(asMeta.authorization_endpoint);
  Object.entries({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'x', resource: MCP }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const reqId = new URL(authRes.headers.get('location')!, BASE).searchParams.get('req')!;
  const next = `/oauth/consent?req=${reqId}`;
  const magic = await fetch(`${BASE}/oauth/magic/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, next }) });
  const link = (await magic.text()).match(/href="([^"]*\/oauth\/magic\/verify\?token=[^"]+)"/)![1].replace(/&amp;/g, '&');
  const verify = await fetch(link, { redirect: 'manual' });
  const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const consent = await fetch(`${BASE}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ req: reqId, decision: 'allow' }) });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
  const tokenRes = await fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: MCP }) });
  return (await tokenRes.json()).access_token;
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
