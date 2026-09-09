import { Router, type Request, type Response } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/index.js';
import { randomToken, sha256 } from '../lib/ids.js';
import { sendMagicLink } from '../email/index.js';
import { completeAuthorization, denyAuthorization, getAuthRequest } from './provider.js';
import { clearSession, readSession, setSession } from './session.js';
import { createWorkspaceForUser, upsertUser, type Identity } from './users.js';
import { esc, layout } from '../http/views/layout.js';

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
    ? `<a class="btn block" href="/oauth/google/start?next=${encodeURIComponent(opts.next)}">Continue with Google</a><p class="center muted">or</p>`
    : '';
  return layout(
    'Sign in',
    `<div class="card">
      <h1>${opts.clientName ? `Connect ${esc(P)} to ${esc(opts.clientName)}` : `Sign in to ${esc(P)}`}</h1>
      <p class="muted">No password. New here? Signing in creates your free account.</p>
      ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
      ${opts.sent ? `<p class="ok">Check ${esc(opts.sent)} for a sign-in link. It expires in 15 minutes.</p>${opts.devLink ? `<p class="muted">Dev mode, email not sent: <a href="${esc(opts.devLink)}">open the link</a></p>` : ''}` : `
      ${google}
      <form method="post" action="/oauth/magic/start">
        <input type="hidden" name="next" value="${esc(opts.next)}">
        <label>Email</label><input type="email" name="email" required autofocus placeholder="you@studio.com">
        <p><button class="btn block" type="submit">Email me a sign-in link</button></p>
      </form>`}
    </div>
    <p class="muted center">By continuing you agree to the <a href="${esc(config.baseUrl)}/terms">terms</a> and <a href="${esc(config.baseUrl)}/privacy">privacy policy</a>.</p>`,
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
    if (!ar) return res.status(400).send(layout('Expired', `<div class="card"><h1>This connection request expired</h1><p>Go back to Claude or ChatGPT and click Connect again.</p></div>`));
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
  return `<div class="card" style="background:var(--bg)">
    <p class="muted" style="margin-top:0">Optional. You can change these any time in settings.</p>
    <label>Business name</label><input name="business_name" placeholder="Your studio or your name">
    <div class="row">
      <div><label>Default hourly rate</label><input name="default_rate" type="number" min="0" step="1" placeholder="150"></div>
      <div><label>Currency</label><select name="currency">${['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'BRL', 'MXN', 'ZAR', 'SGD'].map((c) => `<option>${c}</option>`).join('')}</select></div>
    </div>
    <input type="hidden" name="timezone" id="tz" value="${esc(tz)}">
    <script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';var cur={en_US:'USD',en_GB:'GBP',en_CA:'CAD',en_AU:'AUD',de:'EUR',fr:'EUR',es:'EUR',it:'EUR',nl:'EUR',ja:'JPY',en_IN:'INR'}[navigator.language.replace('-','_')]||{de:'EUR',fr:'EUR',es:'EUR',it:'EUR',nl:'EUR',pt:'EUR'}[navigator.language.slice(0,2)];if(cur)document.querySelector('[name=currency]').value=cur}catch(e){}</script>
  </div>`;
}

// ---- Consent (OAuth) ----
authRoutes.get('/oauth/consent', async (req, res) => {
  const reqId = String(req.query.req ?? '');
  const ar = await getAuthRequest(reqId);
  if (!ar) return res.status(400).send(layout('Expired', `<div class="card"><h1>This connection request expired</h1><p>Go back to Claude or ChatGPT and click Connect again.</p></div>`));
  const session = readSession(req);
  const pending = pendingUser(req);
  if (!session && !pending) return res.redirect(`/oauth/login?req=${reqId}`);
  const user = await one<{ email: string; name: string | null }>(`SELECT email, name FROM users WHERE id = $1`, [session?.userId ?? pending]);
  const isNew = !session;
  res.send(
    layout(
      'Connect',
      `<form method="post" action="/oauth/consent" class="card">
        <input type="hidden" name="req" value="${esc(reqId)}">
        <h1>Connect ${esc(P)} to ${esc(ar.client_name ?? 'this app')}</h1>
        <p class="muted">Signed in as ${esc(user?.email)}</p>
        <p>${esc(ar.client_name ?? 'The app')} will be able to:</p>
        <ul class="scopes">${ar.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`).join('')}</ul>
        <p class="muted">Nothing is sent to a client without your explicit approval in the conversation.</p>
        ${isNew ? onboardingCard('UTC') : ''}
        <div class="row" style="margin-top:16px">
          <button class="btn" type="submit" name="decision" value="allow">Allow</button>
          <button class="btn secondary" type="submit" name="decision" value="deny">Cancel</button>
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
    res.status(400).send(layout('Expired', `<div class="card"><h1>${esc((e as Error).message)}</h1></div>`));
  }
});

// ---- Web-app onboarding for users who signed in directly (not via OAuth) ----
authRoutes.get('/oauth/onboard', async (req, res) => {
  const userId = pendingUser(req);
  if (!userId) return res.redirect('/oauth/login');
  res.send(layout('Welcome', `<form method="post" action="/oauth/onboard" class="card"><input type="hidden" name="next" value="${esc(nextPath(req))}"><h1>Welcome to ${esc(P)}</h1>${onboardingCard('UTC')}<p><button class="btn block" type="submit">Continue</button></p></form>`));
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
