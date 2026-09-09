# Tallied

Tallied is a time-tracking and invoicing MCP server. It's connector-first: Claude and ChatGPT (or any MCP client) are the primary UI — you tell an assistant what you worked on and it logs the hours, ask what's unbilled and it drafts the invoice. A minimal web app handles the things chat is bad at: account settings, CSV import, and billing. Clients pay invoices through a Stripe payment link on a public, tokenized page.

```
Claude / ChatGPT / MCP client
        │  MCP over Streamable HTTP (OAuth 2.1 bearer token)
        ▼
┌───────────────────────────────────────────────┐
│  one origin (BASE_URL)                         │
│  /mcp            MCP endpoint                  │
│  /authorize /token /register /revoke           │
│                   OAuth 2.1 authorization server│
│  /app/*          web app (settings, import,     │
│                   billing)                      │
│  /i/<token>      public invoice page + PDF      │
└───────────────────────────────────────────────┘
        │                    │                │
        ▼                    ▼                ▼
    Postgres              Stripe        SMTP / Resend
 (workspaces, entries,  (subscriptions,  (magic links,
  invoices, tokens,      payment links)   invoice emails)
  audit log)
                                          pdfkit (invoice PDFs, in-process)
```

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up          # postgres via docker compose, localhost:5433
npm run db:migrate     # applies src/db/schema.sql idempotently
npm run db:seed        # seeds a demo workspace; prints the login email
# In production (compiled image, no tsx): node dist/scripts/seed.js reviewer@withtallied.com
npm run build:app      # builds the MCP App UI bundle into app/dist/app.html
npm run dev            # tsx watch src/index.ts
```

Then connect with the MCP Inspector:

```bash
npm run inspector
```

Choose **Streamable HTTP**, point it at `http://localhost:3000/mcp`, and connect. The inspector will hit the OAuth flow and open the login page in your browser. Without `SMTP_URL` or `RESEND_API_KEY` set, magic-link sign-in doesn't send an email — the link is printed to the server log and also shown directly on the "check your email" page, so local dev never needs a real mailbox.

## Project layout

```
src/
  index.ts       entry point
  config.ts      env vars, plans, scopes
  db/            schema.sql, migration runner, query helpers
  lib/           dates, duration parsing, rates, ids, errors, money
  services/      workspace, time entries, invoices, propose (catch-up), audit
  mcp/           McpServer setup: tools, resources, prompts (src/mcp/server.ts)
  auth/          OAuth provider, login/consent routes, sessions, Google OIDC
  http/          express app, docs/marketing routes, web app routes, invoice pages
  import/        CSV import (Toggl/Harvest/Clockify)
  stripe/        billing checkout, Connect onboarding, webhook handling
  email/         email sending via SMTP (nodemailer) or Resend (magic links, invoice emails)
  pdf/           invoice PDF rendering (pdfkit)
app/             MCP App UI source; scripts/build-app.ts bundles it into app/dist/app.html,
                 which src/mcp/app-resource.ts embeds as an MCP UI resource and
                 src/http/routes/invoice-public.ts reuses for the public invoice page
skills/          bundled Claude skills (log-day, catch-up, weekly-report,
                 invoice-client, month-close) — also exposed as MCP prompts
.claude-plugin/  Claude plugin/connector manifest
.codex-plugin/   ChatGPT/Codex plugin manifest
docs/            privacy.md, terms.md, docs.md, landing.md, llms.txt — served live
                 at /privacy, /terms, /docs, /, and /llms.txt by src/http/routes/docs.ts
test/            unit tests (vitest) and the golden prompt set
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | no (default `development`) | `production` enables prod-only behavior (rate limiting, no dev magic-link shortcut) |
| `PORT` | no (default `3000`) | HTTP port |
| `BASE_URL` | no (default `http://localhost:3000`) | Public origin. Everything — MCP, OAuth, web app, invoice pages — is served from here by default |
| `MCP_URL` | no (default `${BASE_URL}/mcp`) | Override to put the MCP endpoint on its own subdomain |
| `AUTH_ISSUER_URL` | no (default `BASE_URL`) | Override to put the OAuth authorization server on its own subdomain |
| `APP_URL` | no (default `${BASE_URL}/app`) | Override to put the web app on its own subdomain |
| `DATABASE_URL` | no (default local docker-compose Postgres) | Postgres connection string |
| `SESSION_SECRET` | yes in production | Signs session cookies and magic links; `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Enables "Continue with Google"; omit to offer only magic links |
| `SMTP_URL` | no | Any SMTP provider, e.g. `smtps://LOGIN:KEY@smtp-relay.brevo.com:465`; takes precedence over Resend |
| `RESEND_API_KEY` | no | Alternative to SMTP_URL. With neither set, emails are printed to the log (dev only) |
| `EMAIL_FROM` | no | From address for outbound email |
| `STRIPE_SECRET_KEY` | no | Enables billing checkout and invoice payment links |
| `STRIPE_WEBHOOK_SECRET` | no (required if `STRIPE_SECRET_KEY` is set) | Verifies `/webhooks/stripe` payloads |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | no | Price IDs for the paid plans |
| `STRIPE_CONNECT_FEE_BPS` | no (default `0`) | Optional platform fee, in basis points, on Connect payment links |
| `PRODUCT_NAME` | no (default `Tallied`) | Used in emails, docs pages, and MCP server metadata |
| `SUPPORT_EMAIL` | no (default `support@localhost`) | Shown in docs and consent screens |

See `.env.example` for the same list with inline comments.

## OAuth notes

- The `@modelcontextprotocol/sdk` router (`mcpAuthRouter`) provides the protocol surface: dynamic client registration, PKCE (S256), a form-encoded token endpoint, and RFC 8414 + RFC 9728 discovery metadata. `src/http/app.ts` mounts it at `AUTH_ISSUER_URL` and wires it to `TallyOAuthProvider` (`src/auth/provider.ts`), which persists clients, codes, and tokens in Postgres.
- Identity is Google OIDC or an emailed magic link — no passwords. See `src/auth/routes.ts`.
- **The OAuth consent screen is signup.** A user with no workspace yet gets an onboarding card (business name, default rate, currency, timezone) inline on the consent page; clicking Allow creates the workspace and completes the authorization in one step.
- Tokens are opaque and hashed at rest (never stored in plain text). Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use, with reuse detection (a reused, already-rotated refresh token revokes the whole token family).
- To swap in a hosted identity/OAuth provider (Clerk, WorkOS, Stytch) instead of `TallyOAuthProvider`, replace it with the SDK's `ProxyOAuthServerProvider`, which delegates the same protocol surface to an upstream authorization server.

## Deployment

Tallied runs on any host that gives you a stable HTTPS origin — Fly.io, Railway, Render, or similar.

1. Set `BASE_URL` to your public origin. Set `MCP_URL`, `AUTH_ISSUER_URL`, and/or `APP_URL` only if you're splitting those surfaces across subdomains.
2. `npm run build` (runs `build:app` then `tsc`), then `npm start`.
3. Point your Postgres at `DATABASE_URL` and run `npm run db:migrate`.
4. If using Stripe, register a webhook endpoint at `${BASE_URL}/webhooks/stripe` subscribed to `checkout.session.completed`, `payment_intent.succeeded`, `customer.subscription.updated`, and `customer.subscription.deleted`.
5. If using Google sign-in, add `${BASE_URL}/oauth/google/callback` as an authorized redirect URI in the Google OAuth client.

## Testing

- `npm test` — unit tests (vitest).
- `test/golden-prompts.json` — a hand-curated set of prompts and expected tool-call behavior. It's run manually, in both Claude and ChatGPT, before any change to tool names, descriptions, or input schemas — those are effectively a public API for the model and regressions there don't show up in unit tests.

## Submission checklists

Before submitting to a connector directory, see `docs/listing.md` for store-listing copy and screenshots, and the product spec's submission checklist for the full requirements. Note that Claude's connector directory requires the submitting organization to be on a Team (or Enterprise) plan.
