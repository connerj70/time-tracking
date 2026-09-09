import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';

const COOKIE = 'tally_session';

interface Session {
  userId: string;
  workspaceId: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function setSession(res: Response, s: Omit<Session, 'exp'>, days = 30): void {
  const body = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + days * 86400000 })).toString('base64url');
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: days * 86400000,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

export function readSession(req: Request): Session | null {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    if (!s.userId || !s.workspaceId || s.exp < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
