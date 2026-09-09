import { query } from '../db/index.js';
import type { PlanName } from '../config.js';

export async function setPlan(workspaceId: string, plan: PlanName, stripe: { customerId?: string | null; subscriptionId?: string | null } = {}): Promise<void> {
  await query(
    `UPDATE workspaces SET plan = $2,
       stripe_customer_id = COALESCE($3, stripe_customer_id),
       stripe_subscription_id = COALESCE($4, stripe_subscription_id)
     WHERE id = $1`,
    [workspaceId, plan, stripe.customerId ?? null, stripe.subscriptionId ?? null],
  );
}
