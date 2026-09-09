import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomUUID } from 'node:crypto';
import { one, query, withTx } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/ids.js';

/**
 * OAuth 2.1 authorization server state lives in Postgres. The SDK's router owns the protocol surface
 * (DCR JSON parsing, PKCE S256 verification, form-encoded token requests, discovery metadata); this class owns
 * codes, tokens, and the hand-off to the login/consent UI.
 *
 * Tokens are opaque random strings; only SHA-256 hashes are stored. Refresh tokens rotate on every use; reuse
 * of a rotated refresh token revokes the whole family.
 */
class PgClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await one<{ metadata: OAuthClientInformationFull }>(`SELECT metadata FROM oauth_clients WHERE client_id = $1`, [clientId]);
    return row?.metadata;
  }
  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Public clients (Claude, ChatGPT, Inspector) use PKCE; no secret is issued for token_endpoint_auth_method "none".
      ...(client.token_endpoint_auth_method === 'none' ? { client_secret: undefined } : { client_secret: randomToken(32), client_secret_expires_at: 0 }),
    };
    await query(`INSERT INTO oauth_clients (client_id, client_secret, metadata) VALUES ($1,$2,$3)`, [full.client_id, full.client_secret ?? null, JSON.stringify(full)]);
    return full;
  }
}

export class TallyOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new PgClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = (params.scopes?.length ? params.scopes : config.scopes).filter((s) => config.scopes.includes(s));
    const row = await one<{ id: string }>(
      `INSERT INTO oauth_auth_requests (client_id, redirect_uri, code_challenge, scopes, state, resource, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '20 minutes') RETURNING id`,
      [client.client_id, params.redirectUri, params.codeChallenge, scopes, params.state ?? null, params.resource?.href ?? null],
    );
    res.redirect(`${config.authIssuerUrl}/oauth/login?req=${row!.id}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await one<{ code_challenge: string; client_id: string }>(`SELECT code_challenge, client_id FROM oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(authorizationCode)]);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(authorizationCode);
    return withTx(async (tx) => {
      const code = await one<{ client_id: string; user_id: string; workspace_id: string; scopes: string[]; redirect_uri: string; resource: string | null }>(
        `UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING client_id, user_id, workspace_id, scopes, redirect_uri, resource`,
        [hash],
        tx,
      );
      if (!code || code.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri && redirectUri !== code.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
      if (resource && code.resource && resource.href !== code.resource) throw new InvalidGrantError('resource mismatch');
      return issueTokens({ clientId: client.client_id, userId: code.user_id, workspaceId: code.workspace_id, scopes: code.scopes, resource: code.resource, familyId: randomUUID() }, tx);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    // Reuse detection runs outside the transaction so the family revocation survives the thrown error.
    const pre = await one<{ client_id: string; family_id: string; revoked_at: Date | null }>(`SELECT client_id, family_id, revoked_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, [hash]);
    if (!pre || pre.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (pre.revoked_at) {
      // Replay of a rotated token: assume theft, kill the whole family.
      await query(`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [pre.family_id]);
      throw new InvalidGrantError('Refresh token reuse detected; re-authorize');
    }
    return withTx(async (tx) => {
      const row = await one<{ client_id: string; user_id: string; workspace_id: string; scopes: string[]; resource: string | null; family_id: string; revoked_at: Date | null; expires_at: Date }>(
        `SELECT client_id, user_id, workspace_id, scopes, resource, family_id, revoked_at, expires_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE`,
        [hash],
        tx,
      );
      if (!row || row.revoked_at) throw new InvalidGrantError('Invalid refresh token');
      if (row.expires_at.getTime() < Date.now()) throw new InvalidGrantError('Refresh token expired');
      if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError('resource mismatch');
      const granted = scopes?.length ? scopes.filter((s) => row.scopes.includes(s)) : row.scopes;
      if (scopes?.length && granted.length !== scopes.length) throw new InvalidRequestError('Requested scope exceeds original grant');
      await query(`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1`, [hash], tx);
      return issueTokens({ clientId: client.client_id, userId: row.user_id, workspaceId: row.workspace_id, scopes: granted, resource: row.resource, familyId: row.family_id }, tx);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await one<{ client_id: string; user_id: string; workspace_id: string; scopes: string[]; resource: string | null; expires_at: Date; revoked_at: Date | null }>(
      `SELECT client_id, user_id, workspace_id, scopes, resource, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access'`,
      [sha256(token)],
    );
    if (!row || row.revoked_at) throw new InvalidTokenError('Invalid token');
    if (row.expires_at.getTime() < Date.now()) throw new InvalidTokenError('Token expired');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: Math.floor(row.expires_at.getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id, workspaceId: row.workspace_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = await one<{ family_id: string; client_id: string }>(`SELECT family_id, client_id FROM oauth_tokens WHERE token_hash = $1`, [sha256(request.token)]);
    if (!row || row.client_id !== client.client_id) return;
    await query(`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
  }
}

async function issueTokens(
  t: { clientId: string; userId: string; workspaceId: string; scopes: string[]; resource: string | null; familyId: string },
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
): Promise<OAuthTokens> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, workspace_id, scopes, resource, family_id, expires_at) VALUES
       ($1,'access',$3,$4,$5,$6,$7,$8, now() + ($9 || ' seconds')::interval),
       ($2,'refresh',$3,$4,$5,$6,$7,$8, now() + ($10 || ' seconds')::interval)`,
    [sha256(access), sha256(refresh), t.clientId, t.userId, t.workspaceId, t.scopes, t.resource, t.familyId, String(config.accessTokenTtlSec), String(config.refreshTokenTtlSec)],
    tx,
  );
  return { access_token: access, token_type: 'bearer', expires_in: config.accessTokenTtlSec, refresh_token: refresh, scope: t.scopes.join(' ') };
}

/** Called by the consent page after the user approves. Mints the code and returns the redirect URL. */
export async function completeAuthorization(authRequestId: string, userId: string, workspaceId: string): Promise<string> {
  const req = await one<{ id: string; client_id: string; redirect_uri: string; code_challenge: string; scopes: string[]; state: string | null; resource: string | null }>(
    `SELECT * FROM oauth_auth_requests WHERE id = $1 AND expires_at > now()`,
    [authRequestId],
  );
  if (!req) throw new Error('This sign-in request has expired. Go back to Claude or ChatGPT and connect again.');
  const code = randomToken(32);
  await query(
    `INSERT INTO oauth_codes (code_hash, auth_request_id, client_id, user_id, workspace_id, scopes, code_challenge, redirect_uri, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
    [sha256(code), req.id, req.client_id, userId, workspaceId, req.scopes, req.code_challenge, req.redirect_uri, req.resource, String(config.authCodeTtlSec)],
  );
  await query(`UPDATE oauth_auth_requests SET user_id = $2 WHERE id = $1`, [req.id, userId]);
  const url = new URL(req.redirect_uri);
  url.searchParams.set('code', code);
  if (req.state) url.searchParams.set('state', req.state);
  return url.href;
}

export async function denyAuthorization(authRequestId: string): Promise<string | null> {
  const req = await one<{ redirect_uri: string; state: string | null }>(`SELECT redirect_uri, state FROM oauth_auth_requests WHERE id = $1`, [authRequestId]);
  if (!req) return null;
  const url = new URL(req.redirect_uri);
  url.searchParams.set('error', 'access_denied');
  if (req.state) url.searchParams.set('state', req.state);
  return url.href;
}

export async function getAuthRequest(id: string) {
  return one<{ id: string; client_id: string; scopes: string[]; client_name: string | null }>(
    `SELECT r.id, r.client_id, r.scopes, c.metadata->>'client_name' AS client_name FROM oauth_auth_requests r JOIN oauth_clients c ON c.client_id = r.client_id WHERE r.id = $1 AND r.expires_at > now()`,
    [id],
  );
}
