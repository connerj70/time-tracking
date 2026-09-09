import express from 'express';
import cors from 'cors';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from '../config.js';
import { TallyOAuthProvider } from '../auth/provider.js';
import { authRoutes } from '../auth/routes.js';
import { handleMcp } from '../mcp/handler.js';
import { invoicePublicRoutes } from './routes/invoice-public.js';
import { stripeWebhookRoutes } from './routes/stripe-webhook.js';
import { appRoutes } from './routes/app.js';
import { docsRoutes } from './routes/docs.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  const provider = new TallyOAuthProvider();
  const mcpUrl = new URL(config.mcpUrl);
  const issuer = new URL(config.authIssuerUrl);
  const prmUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  // Stripe needs the raw body; mount before any JSON parser.
  app.use(stripeWebhookRoutes);

  // OAuth 2.1 AS: /authorize, /token (form-encoded), /register (DCR, JSON), /revoke,
  // /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp
  app.use(
    cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'], allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'] }),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      baseUrl: issuer,
      resourceServerUrl: mcpUrl,
      resourceName: config.productName,
      serviceDocumentationUrl: new URL(`${config.baseUrl}/docs`),
      scopesSupported: [...config.scopes],
      clientRegistrationOptions: { clientSecretExpirySeconds: undefined, rateLimit: config.isProd ? undefined : false },
      authorizationOptions: { rateLimit: config.isProd ? undefined : false },
      tokenOptions: { rateLimit: config.isProd ? undefined : false },
    }),
  );
  // Some clients fetch the root-level PRM (RFC 9728 without a path suffix). Serve both.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: config.mcpUrl,
      authorization_servers: [config.authIssuerUrl],
      scopes_supported: config.scopes,
      bearer_methods_supported: ['header'],
      resource_name: config.productName,
      resource_documentation: `${config.baseUrl}/docs`,
    });
  });

  // MCP endpoint: 401 + WWW-Authenticate → resource metadata → AS metadata → DCR → PKCE → tokens.
  const mcpPath = mcpUrl.pathname;
  app.use(mcpPath, express.json({ limit: '4mb' }));
  app.all(mcpPath, requireBearerAuth({ verifier: provider, resourceMetadataUrl: prmUrl }), (req, res) => {
    handleMcp(req, res).catch((e) => {
      console.error('mcp error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    });
  });

  app.use(authRoutes);
  app.use(invoicePublicRoutes);
  app.use(new URL(config.appUrl).pathname, appRoutes);
  app.use(docsRoutes);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).send('Something went wrong');
  });
  return app;
}
