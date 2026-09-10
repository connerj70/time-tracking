import { Router, type Request, type Response } from 'express';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/index.js';
import { randomToken, sha256 } from '../lib/ids.js';
import { sendMagicLink } from '../email/index.js';
import { completeAuthorization, denyAuthorization, getAuthRequest } from './provider.js';
import { clearSession, readSession, setSession } from './session.js';
import { createWorkspaceForUser, upsertUser, type Identity } from './users.js';
import { esc, layout, mark } from '../http/views/layout.js';

/**
 * Identity + consent. The OAuth consent screen IS signup: no password, Google or magic link,
 * optional business card, workspace created on consent. Two clicks from "Connect" to a logged hour.
 */
export const authRoutes = Router();
authRoutes.use(express.urlencoded({ extended: false }));

const P = config.productName;
const SCOPE_TEXT: Record<string, string> = {
  'time:read': 'Read your time entries and reports',
  'time:write': 'Log and edit time entries you describe',
  'invoices:read': 'Read your invoices and payment status',
  'invoices:write': 'Create drafts and send invoices you approve',
};

function nextPath(req: Request): string {
  const n = String(req.query.next ?? req.body?.next ?? '');
  return n.startsWith('/') && !n.startsWith('//') ? n : `${config.appUrl}`;
}

function loginPage(opts: { next: string; clientName?: string | null; error?: string; sent?: string; devLink?: string }): string {
  const google = config.google.enabled
    ? `<a class="btn secondary block" href="/oauth/google/start?next=${encodeURIComponent(opts.next)}">Continue with Google</a><p class="sep">or</p>`
    : '';
  return layout(
    'Sign in',
    `<div class="signin-mark">${mark(82)}</div>
    <div class="card">
      <h1>${opts.clientName ? `Connect ${esc(P)} to ${esc(opts.clientName)}` : `Sign in to ${esc(P)}`}</h1>
      <p class="lede">No password needed. If you are new, signing in creates your free workspace.</p>
      ${opts.error ? `<p class="notice err">${esc(opts.error)}</p>` : ''}
      ${
        opts.sent
          ? `<p class="notice ok">We sent a sign-in link to ${esc(opts.sent)}. It works for 15 minutes.</p>
             ${opts.devLink ? `<p class="hint">Development mode, so no email was sent. <a href="${esc(opts.devLink)}">Open the link</a>.</p>` : ''}`
          : `${google}
      <form method="post" action="/oauth/magic/start">
        <input type="hidden" name="next" value="${esc(opts.next)}">
        <div class="field"><label for="email">Email</label><input id="email" type="email" name="email" required autofocus placeholder="you@studio.com" autocomplete="email"></div>
        <button class="btn primary block" type="submit">Email me a sign-in link</button>
      </form>
      ${
        config.reviewer.enabled
          ? `<details open class="reviewer"><summary>Reviewing ${esc(P)}? Use your access code</summary>
      <form method="post" action="/oauth/reviewer" style="margin-top:12px">
        <input type="hidden" name="next" value="${esc(opts.next)}">
        <div class="field"><label for="code">Access code</label><input id="code" type="password" name="code" required autocomplete="off"></div>
        <button class="btn secondary block" type="submit">Sign in as reviewer</button>
      </form></details>`
          : ''
      }`
      }
    </div>
    <p class="legal">By continuing you agree to the <a href="${esc(config.baseUrl)}/terms">terms</a> and <a href="${esc(config.baseUrl)}/privacy">privacy policy</a>.</p>`,
  );
}

// ---- Login entry (from the OAuth authorize redirect, or the web app) ----
authRoutes.get('/oauth/login', async (req, res) => {
  const reqId = typeof req.query.req === 'string' ? req.query.req : null;
  const next = reqId ? `/oauth/consent?req=${reqId}` : nextPath(req);
  const session = readSession(req);
  if (session) return res.redirect(next);
  let clientName: string | null = null;
  if (reqId) {
    const ar = await getAuthRequest(reqId);
    if (!ar) return res.status(400).send(layout('Expired', `<div class="signin-mark">${mark(82)}</div><div class="card"><h1>This connection request expired</h1><p class="lede">Go back to Claude or ChatGPT and click Connect again to start over.</p></div>`));
    clientName = ar.client_name;
  }
  res.send(loginPage({ next, clientName, error: typeof req.query.error === 'string' ? req.query.error : undefined }));
});

// ---- Magic link ----
authRoutes.post('/oauth/magic/start', async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const next = nextPath(req);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).send(loginPage({ next, error: 'Enter a valid email address.' }));
  const token = randomToken(32);
  await query(`INSERT INTO magic_links (token_hash, email, next_path, expires_at) VALUES ($1,$2,$3, now() + interval '15 minutes')`, [sha256(token), email, next]);
  const url = `${config.authIssuerUrl}/oauth/magic/verify?token=${token}`;
  await sendMagicLink(email, url);
  res.send(loginPage({ next, sent: email, devLink: !config.email.enabled && !config.isProd ? url : undefined }));
});

authRoutes.get('/oauth/magic/verify', async (req, res) => {
  const token = String(req.query.token ?? '');
  const row = await one<{ email: string; next_path: string | null }>(
    `UPDATE magic_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email, next_path`,
    [sha256(token)],
  );
  if (!row) return res.status(400).send(loginPage({ next: config.appUrl, error: 'That link is invalid or expired. Request a new one.' }));
  await finishIdentity(req, res, { email: row.email, provider: 'magic_link' }, row.next_path ?? config.appUrl);
});

// ---- Reviewer access code (directory reviewers; one designated account, no email round-trip) ----
const reviewerAttempts = new Map<string, { n: number; reset: number }>();
authRoutes.post('/oauth/reviewer', async (req, res) => {
  const next = nextPath(req);
  if (!config.reviewer.enabled) return res.status(404).send(loginPage({ next, error: 'Reviewer sign-in is not enabled.' }));
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const a = reviewerAttempts.get(ip) ?? { n: 0, reset: now + 60_000 };
  if (a.reset < now) Object.assign(a, { n: 0, reset: now + 60_000 });
  a.n += 1;
  reviewerAttempts.set(ip, a);
  if (a.n > 5) return res.status(429).send(loginPage({ next, error: 'Too many attempts. Wait a minute and try again.' }));
  const given = Buffer.from(String(req.body.code ?? ''));
  const expected = Buffer.from(config.reviewer.accessCode);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).send(loginPage({ next, error: 'That access code is not valid.' }));
  }
  await finishIdentity(req, res, { email: config.reviewer.email, name: 'Reviewer', provider: 'magic_link' }, next);
});

// ---- Google OIDC ----
authRoutes.get('/oauth/google/start', (req, res) => {
  if (!config.google.enabled) return res.status(404).send('Google sign-in is not configured');
  const state = randomBytes(16).toString('base64url');
  res.cookie('g_state', `${state}|${nextPath(req)}`, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 600000, path: '/oauth/google' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', config.google.clientId);
  u.searchParams.set('redirect_uri', `${config.authIssuerUrl}/oauth/google/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  res.redirect(u.href);
});

authRoutes.get('/oauth/google/callback', async (req, res) => {
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('g_state='))?.slice(8);
  const [state, next] = decodeURIComponent(cookie ?? '').split('|');
  res.clearCookie('g_state', { path: '/oauth/google' });
  if (!state || req.query.state !== state || typeof req.query.code !== 'string') return res.status(400).send(loginPage({ next: config.appUrl, error: 'Google sign-in failed. Try again.' }));
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: req.query.code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.authIssuerUrl}/oauth/google/callback`, grant_type: 'authorization_code' }),
  });
  if (!tokenRes.ok) return res.status(400).send(loginPage({ next: config.appUrl, error: 'Google sign-in failed (token exchange).' }));
  const tokens = (await tokenRes.json()) as { access_token: string };
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!info.email || info.email_verified === false) return res.status(400).send(loginPage({ next: config.appUrl, error: 'Google did not return a verified email.' }));
  await finishIdentity(req, res, { email: info.email.toLowerCase(), name: info.name, avatarUrl: info.picture, provider: 'google' }, next || config.appUrl);
});

/** Identity established → session → consent (which creates the workspace for new users) or the app. */
async function finishIdentity(req: Request, res: Response, id: Identity, next: string): Promise<void> {
  const u = await upsertUser(id);
  if (u.workspaceId) {
    setSession(res, { userId: u.userId, workspaceId: u.workspaceId });
    return res.redirect(next);
  }
  // No workspace yet: short-lived pending cookie; the consent/onboarding page creates it.
  res.cookie('pending_user', u.userId, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 1200000, path: '/' });
  const target = next.startsWith('/oauth/consent') ? next : `/oauth/onboard?next=${encodeURIComponent(next)}`;
  res.redirect(target);
}

function pendingUser(req: Request): string | null {
  const m = (req.headers.cookie ?? '').match(/(?:^|;\s*)pending_user=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function onboardingCard(tz: string): string {
  return `<div style="background:var(--sunk);border-radius:var(--r-sm);padding:18px 18px 6px;margin:22px 0 0">
    <h3 style="margin:0 0 3px">Set up your workspace</h3>
    <p class="hint" style="margin:0 0 14px">All optional, and changeable later in settings.</p>
    <div class="field"><label for="bn">Business name</label><input id="bn" name="business_name" placeholder="Your studio, or your own name"></div>
    <div class="row">
      <div class="field"><label for="dr">Default hourly rate</label><input id="dr" name="default_rate" type="number" min="0" step="1" placeholder="150"></div>
      <div class="field"><label for="cu">Currency</label><select id="cu" name="currency">${['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'BRL', 'MXN', 'ZAR', 'SGD'].map((c) => `<option>${c}</option>`).join('')}</select></div>
    </div>
    <input type="hidden" name="timezone" id="tz" value="${esc(tz)}">
    <script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';var cur={en_US:'USD',en_GB:'GBP',en_CA:'CAD',en_AU:'AUD',de:'EUR',fr:'EUR',es:'EUR',it:'EUR',nl:'EUR',ja:'JPY',en_IN:'INR'}[navigator.language.replace('-','_')]||{de:'EUR',fr:'EUR',es:'EUR',it:'EUR',nl:'EUR',pt:'EUR'}[navigator.language.slice(0,2)];if(cur)document.querySelector('[name=currency]').value=cur}catch(e){}</script>
  </div>`;
}

// ---- Consent (OAuth) ----
authRoutes.get('/oauth/consent', async (req, res) => {
  const reqId = String(req.query.req ?? '');
  const ar = await getAuthRequest(reqId);
  if (!ar) return res.status(400).send(layout('Expired', `<div class="signin-mark">${mark(82)}</div><div class="card"><h1>This connection request expired</h1><p class="lede">Go back to Claude or ChatGPT and click Connect again to start over.</p></div>`));
  const session = readSession(req);
  const pending = pendingUser(req);
  if (!session && !pending) return res.redirect(`/oauth/login?req=${reqId}`);
  const user = await one<{ email: string; name: string | null }>(`SELECT email, name FROM users WHERE id = $1`, [session?.userId ?? pending]);
  const isNew = !session;
  res.send(
    layout(
      'Connect',
      `<div class="signin-mark">${mark(82)}</div>
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="req" value="${esc(reqId)}">
        <div class="card">
          <h1>Connect ${esc(P)} to ${esc(ar.client_name ?? 'this app')}</h1>
          <p class="lede">Signed in as ${esc(user?.email)}.</p>
          <h3 style="margin-top:22px">${esc(ar.client_name ?? 'This app')} will be able to</h3>
          <ul class="scopes">${ar.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`).join('')}</ul>
          <p class="hint" style="margin-top:14px">Invoices are only emailed to your clients when you say so in the conversation.</p>
          ${isNew ? onboardingCard('UTC') : ''}
          <div class="actions">
            <button class="btn primary" type="submit" name="decision" value="allow">Allow</button>
            <button class="btn secondary" type="submit" name="decision" value="deny">Cancel</button>
          </div>
        </div>
      </form>`,
    ),
  );
});

authRoutes.post('/oauth/consent', async (req, res) => {
  const reqId = String(req.body.req ?? '');
  if (req.body.decision !== 'allow') {
    const url = await denyAuthorization(reqId);
    return url ? res.redirect(url) : res.redirect('/oauth/login');
  }
  let session = readSession(req);
  if (!session) {
    const userId = pendingUser(req);
    if (!userId) return res.redirect(`/oauth/login?req=${reqId}`);
    const user = await one<{ email: string; name: string | null }>(`SELECT email, name FROM users WHERE id = $1`, [userId]);
    if (!user) return res.redirect(`/oauth/login?req=${reqId}`);
    const workspaceId = await createWorkspaceForUser(userId, { businessName: req.body.business_name, defaultRate: Number(req.body.default_rate) || undefined, currency: req.body.currency, timezone: req.body.timezone }, user);
    session = { userId, workspaceId, exp: 0 };
    setSession(res, { userId, workspaceId });
    res.clearCookie('pending_user', { path: '/' });
  }
  try {
    const url = await completeAuthorization(reqId, session.userId, session.workspaceId);
    res.redirect(url);
  } catch (e) {
    res.status(400).send(layout('Expired', `<div class="signin-mark">${mark(82)}</div><div class="card"><h1>Something went wrong</h1><p class="lede">${esc((e as Error).message)}</p></div>`));
  }
});

// ---- Web-app onboarding for users who signed in directly (not via OAuth) ----
authRoutes.get('/oauth/onboard', async (req, res) => {
  const userId = pendingUser(req);
  if (!userId) return res.redirect('/oauth/login');
  res.send(layout('Welcome', `<div class="signin-mark">${mark(82)}</div><form method="post" action="/oauth/onboard"><div class="card"><h1>Welcome to ${esc(P)}</h1><p class="lede">A couple of details and you are set up.</p>${onboardingCard('UTC')}<div class="actions"><button class="btn primary block" type="submit">Continue</button></div></div></form>`));
});
authRoutes.post('/oauth/onboard', async (req, res) => {
  const userId = pendingUser(req);
  if (!userId) return res.redirect('/oauth/login');
  const user = await one<{ email: string; name: string | null }>(`SELECT email, name FROM users WHERE id = $1`, [userId]);
  if (!user) return res.redirect('/oauth/login');
  const workspaceId = await createWorkspaceForUser(userId, { businessName: req.body.business_name, defaultRate: Number(req.body.default_rate) || undefined, currency: req.body.currency, timezone: req.body.timezone }, user);
  setSession(res, { userId, workspaceId });
  res.clearCookie('pending_user', { path: '/' });
  res.redirect(nextPath(req));
});

authRoutes.get('/oauth/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/oauth/login');
});
