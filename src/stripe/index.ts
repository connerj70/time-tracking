import Stripe from 'stripe';
import { config } from '../config.js';
import type { WorkspaceRow } from '../services/context.js';
import type { InvoiceRow } from '../services/invoices.js';

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!config.stripe.enabled) return null;
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

/**
 * Client payments stay on Stripe-hosted surfaces: we create a one-off Price + Payment Link per invoice.
 * If the workspace has a Connect account, the link is created on that account with an optional platform fee.
 */
export async function createPaymentLink(opts: { workspace: WorkspaceRow; invoice: InvoiceRow; clientName: string }): Promise<{ url: string; id: string } | null> {
  const s = stripe();
  if (!s) return null;
  const { workspace, invoice } = opts;
  const reqOpts: Stripe.RequestOptions = workspace.stripe_connect_account_id ? { stripeAccount: workspace.stripe_connect_account_id } : {};
  const price = await s.prices.create(
    {
      currency: invoice.currency.toLowerCase(),
      unit_amount: invoice.total_cents,
      product_data: { name: `Invoice ${invoice.number} — ${workspace.name}` },
    },
    reqOpts,
  );
  const params: Stripe.PaymentLinkCreateParams = {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { invoice_id: invoice.id, workspace_id: workspace.id, invoice_number: invoice.number },
    payment_intent_data: { metadata: { invoice_id: invoice.id, workspace_id: workspace.id } },
    after_completion: { type: 'redirect', redirect: { url: `${config.baseUrl}/i/${invoice.public_token}?paid=1` } },
  };
  if (workspace.stripe_connect_account_id && config.stripe.connectFeeBps > 0) {
    params.application_fee_amount = Math.round((invoice.total_cents * config.stripe.connectFeeBps) / 10000);
  }
  const link = await s.paymentLinks.create(params, reqOpts);
  return { url: link.url, id: link.id };
}

export async function deactivatePaymentLink(workspace: WorkspaceRow, linkId: string): Promise<void> {
  const s = stripe();
  if (!s) return;
  const reqOpts: Stripe.RequestOptions = workspace.stripe_connect_account_id ? { stripeAccount: workspace.stripe_connect_account_id } : {};
  await s.paymentLinks.update(linkId, { active: false }, reqOpts).catch(() => undefined);
}

/** Subscription checkout for Pro / Team. */
export async function createBillingCheckout(opts: { workspace: WorkspaceRow; email: string; plan: 'pro' | 'team'; seats?: number }): Promise<string> {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  const price = opts.plan === 'pro' ? config.stripe.pricePro : config.stripe.priceTeam;
  if (!price) throw new Error(`STRIPE_PRICE_${opts.plan.toUpperCase()} is not set`);
  let customerId = opts.workspace.stripe_customer_id;
  if (!customerId) {
    const c = await s.customers.create({ email: opts.email, name: opts.workspace.name, metadata: { workspace_id: opts.workspace.id } });
    customerId = c.id;
  }
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: opts.plan === 'team' ? Math.max(1, opts.seats ?? 1) : 1 }],
    success_url: `${config.appUrl}/billing?upgraded=1`,
    cancel_url: `${config.appUrl}/billing`,
    metadata: { workspace_id: opts.workspace.id, plan: opts.plan },
    subscription_data: { metadata: { workspace_id: opts.workspace.id, plan: opts.plan } },
  });
  return session.url!;
}

export async function createPortalSession(workspace: WorkspaceRow): Promise<string> {
  const s = stripe();
  if (!s || !workspace.stripe_customer_id) throw new Error('No Stripe customer');
  const session = await s.billingPortal.sessions.create({ customer: workspace.stripe_customer_id, return_url: `${config.appUrl}/billing` });
  return session.url;
}

/** Stripe Connect Express onboarding so client payments settle to the user's own account. */
export async function createConnectOnboarding(workspace: WorkspaceRow, email: string): Promise<{ url: string; accountId: string }> {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  let accountId = workspace.stripe_connect_account_id;
  if (!accountId) {
    const acct = await s.accounts.create({ type: 'express', email, metadata: { workspace_id: workspace.id } });
    accountId = acct.id;
  }
  const link = await s.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${config.appUrl}/billing?connect=refresh`,
    return_url: `${config.appUrl}/billing?connect=done`,
  });
  return { url: link.url, accountId };
}
