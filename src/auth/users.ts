import { one, query, withTx } from '../db/index.js';
import { isValidZone } from '../lib/dates.js';

export interface Identity {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  provider: 'google' | 'magic_link';
}

export interface OnboardingCard {
  businessName?: string;
  defaultRate?: number;
  currency?: string;
  timezone?: string;
}

/** Find or create the user; returns whether onboarding (workspace creation) is still needed. */
export async function upsertUser(id: Identity): Promise<{ userId: string; workspaceId: string | null; isNew: boolean }> {
  const existing = await one<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [id.email]);
  let userId: string;
  let isNew = false;
  if (existing) {
    userId = existing.id;
    await query(`UPDATE users SET name = COALESCE($2, name), avatar_url = COALESCE($3, avatar_url) WHERE id = $1`, [userId, id.name ?? null, id.avatarUrl ?? null]);
  } else {
    const row = await one<{ id: string }>(`INSERT INTO users (email, name, avatar_url, auth_provider) VALUES ($1,$2,$3,$4) RETURNING id`, [id.email.toLowerCase(), id.name ?? null, id.avatarUrl ?? null, id.provider]);
    userId = row!.id;
    isNew = true;
  }
  const ws = await one<{ workspace_id: string }>(`SELECT workspace_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [userId]);
  return { userId, workspaceId: ws?.workspace_id ?? null, isNew };
}

/** Creates user's first workspace from the optional consent-screen card. All fields skippable. */
export async function createWorkspaceForUser(userId: string, card: OnboardingCard, fallback: { email: string; name?: string | null }): Promise<string> {
  const name = (card.businessName ?? '').trim() || (fallback.name ? `${fallback.name}'s workspace` : fallback.email.split('@')[0]);
  const currency = /^[A-Z]{3}$/.test(card.currency ?? '') ? card.currency! : 'USD';
  const timezone = card.timezone && isValidZone(card.timezone) ? card.timezone : 'UTC';
  const rateCents = card.defaultRate && Number.isFinite(card.defaultRate) ? Math.round(card.defaultRate * 100) : 0;
  return withTx(async (tx) => {
    const ws = await one<{ id: string }>(
      `INSERT INTO workspaces (name, currency, timezone, default_rate_cents) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, currency, timezone, rateCents],
      tx,
    );
    await query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1,$2,'owner')`, [userId, ws!.id], tx);
    return ws!.id;
  });
}
