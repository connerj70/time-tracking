import { Router } from 'express';
import express from 'express';
import type Stripe from 'stripe';
import { config } from '../../config.js';
import { stripe } from '../../stripe/index.js';
import { one, query } from '../../db/index.js';
import { markPaidByStripe } from '../../services/invoices.js';
import { setPlan } from '../../services/plan.js';

export const stripeWebhookRoutes = Router();

/** Mounted BEFORE express.json so the raw body is available for signature verification. */
stripeWebhookRoutes.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const s = stripe();
  if (!s || !config.stripe.webhookSecret) return res.status(503).send('Stripe not configured');
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, config.stripe.webhookSecret);
  } catch (e) {
    return res.status(400).send(`Webhook signature failed: ${(e as Error).message}`);
  }
  // Idempotent: Stripe retries.
  const seen = await one(`SELECT 1 FROM stripe_events WHERE id = $1`, [event.id]);
  if (seen) return res.json({ received: true, duplicate: true });
  await query(`INSERT INTO stripe_events (id, type) VALUES ($1,$2)`, [event.id, event.type]);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'payment') {
          // Payment-link checkout for an invoice (metadata copied from the link).
          const invoiceId = session.metadata?.invoice_id ?? (session.payment_link ? await invoiceIdForLink(String(session.payment_link)) : null);
          if (invoiceId) await markPaidByStripe(invoiceId, `stripe checkout ${session.id}`);
        } else if (session.mode === 'subscription') {
          const wsId = session.metadata?.workspace_id;
          const plan = session.metadata?.plan === 'team' ? 'team' : 'pro';
          if (wsId) await setPlan(wsId, plan, { customerId: String(session.customer), subscriptionId: String(session.subscription) });
        }
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        if (pi.metadata?.invoice_id) await markPaidByStripe(pi.metadata.invoice_id, `stripe payment_intent ${pi.id}`);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const wsId = sub.metadata?.workspace_id ?? (await workspaceForCustomer(String(sub.customer)));
        if (!wsId) break;
        const active = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
        if (!active || event.type === 'customer.subscription.deleted') await setPlan(wsId, 'free');
        else await setPlan(wsId, sub.metadata?.plan === 'team' ? 'team' : 'pro', { subscriptionId: sub.id });
        break;
      }
      case 'account.updated': {
        // Connect onboarding finished; nothing to persist beyond the account id we already stored.
        break;
      }
    }
  } catch (e) {
    console.error('stripe webhook handler failed', event.type, e);
    return res.status(500).send('handler failed');
  }
  res.json({ received: true });
});

async function invoiceIdForLink(linkId: string): Promise<string | null> {
  const row = await one<{ id: string }>(`SELECT id FROM invoices WHERE stripe_payment_link_id = $1`, [linkId]);
  return row?.id ?? null;
}
async function workspaceForCustomer(customerId: string): Promise<string | null> {
  const row = await one<{ id: string }>(`SELECT id FROM workspaces WHERE stripe_customer_id = $1`, [customerId]);
  return row?.id ?? null;
}
