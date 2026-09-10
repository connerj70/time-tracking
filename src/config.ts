import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

const baseUrl = env('BASE_URL', 'http://localhost:3000').replace(/\/$/, '');

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV', 'development') === 'production',
  port: Number(env('PORT', '3000')),
  baseUrl,
  /** Exactly what users paste into Claude / ChatGPT. Must match PRM `resource`. */
  mcpUrl: env('MCP_URL', `${baseUrl}/mcp`),
  /** OAuth 2.1 issuer. The SDK auth router mounts /authorize, /token, /register, /revoke here. */
  authIssuerUrl: env('AUTH_ISSUER_URL', baseUrl),
  /** Minimal web app: settings, import, billing. */
  appUrl: env('APP_URL', `${baseUrl}/app`),
  databaseUrl: env('DATABASE_URL', 'postgres://tally:tally@localhost:5433/tally'),
  /** Postgres schema for all tables, so the app can share a database with other apps. */
  databaseSchema: env('DATABASE_SCHEMA', 'tallied'),
  sessionSecret: env('SESSION_SECRET', 'dev-secret-do-not-use-in-production'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  email: {
    /** Either works; SMTP_URL wins when both are set. */
    smtpUrl: process.env.SMTP_URL ?? '',
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: env('EMAIL_FROM', 'Tallied <invoices@localhost>'),
    get enabled() {
      return Boolean(this.smtpUrl || this.resendApiKey);
    },
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    pricePro: process.env.STRIPE_PRICE_PRO ?? '',
    priceTeam: process.env.STRIPE_PRICE_TEAM ?? '',
    connectFeeBps: Number(process.env.STRIPE_CONNECT_FEE_BPS ?? '0'),
    get enabled() {
      return Boolean(this.secretKey);
    },
  },
  /** Directory reviewers sign in with an access code instead of email. Both must be set to enable. */
  reviewer: {
    email: (process.env.REVIEWER_EMAIL ?? '').toLowerCase(),
    accessCode: process.env.REVIEWER_ACCESS_CODE ?? '',
    get enabled() {
      return Boolean(this.email && this.accessCode.length >= 16);
    },
  },
  /** Domain-control token for the ChatGPT plugin submission; served verbatim at /.well-known/openai-apps-challenge. */
  openaiAppsChallenge: process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? '',
  productName: env('PRODUCT_NAME', 'Tallied'),
  supportEmail: env('SUPPORT_EMAIL', 'support@localhost'),
  /** Access tokens: 1 hour. Refresh tokens: 30 days, rotated on every use. */
  accessTokenTtlSec: 60 * 60,
  refreshTokenTtlSec: 30 * 24 * 60 * 60,
  authCodeTtlSec: 10 * 60,
  scopes: ['time:read', 'time:write', 'invoices:read', 'invoices:write'] as string[],
  plans: {
    free: { clients: 1, invoicesPerMonth: 2, imports: false, branding: false },
    pro: { clients: Infinity, invoicesPerMonth: Infinity, imports: true, branding: true },
    team: { clients: Infinity, invoicesPerMonth: Infinity, imports: true, branding: true },
  } as const,
} as const;

export type PlanName = keyof typeof config.plans;
