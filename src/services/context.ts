import { one, query } from '../db/index.js';
import { config, type PlanName } from '../config.js';
import { ToolError } from '../lib/errors.js';

export interface WorkspaceRow {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  default_rate_cents: number;
  invoice_prefix: string;
  next_invoice_number: number;
  logo_url: string | null;
  plan: PlanName;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_connect_account_id: string | null;
  business_address: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export interface Ctx {
  userId: string;
  workspaceId: string;
  workspace: WorkspaceRow;
  user: UserRow;
  role: 'owner' | 'member';
}

export async function loadContext(userId: string, workspaceId: string): Promise<Ctx> {
  const row = await one<{ role: 'owner' | 'member' }>(
    `SELECT role FROM memberships WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  if (!row) throw new ToolError('You do not have access to this workspace', 'forbidden');
  const workspace = await one<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
  const user = await one<UserRow>(`SELECT id, email, name, avatar_url FROM users WHERE id = $1`, [userId]);
  if (!workspace || !user) throw new ToolError('Workspace not found', 'not_found');
  return { userId, workspaceId, workspace, user, role: row.role };
}

export function planLimits(ws: WorkspaceRow) {
  return config.plans[ws.plan] ?? config.plans.free;
}

export function upgradeUrl(): string {
  return `${config.appUrl}/billing`;
}

export async function assertClientLimit(ctx: Ctx): Promise<void> {
  const limits = planLimits(ctx.workspace);
  if (limits.clients === Infinity) return;
  const [{ count }] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM clients WHERE workspace_id = $1 AND archived = false`,
    [ctx.workspaceId],
  );
  if (count >= limits.clients) {
    throw new ToolError(
      `The free plan includes ${limits.clients} client. Upgrade to add more.`,
      'plan_limit',
      { upgrade_url: upgradeUrl(), limit: 'clients', plan: ctx.workspace.plan },
    );
  }
}

export async function assertInvoiceLimit(ctx: Ctx): Promise<void> {
  const limits = planLimits(ctx.workspace);
  if (limits.invoicesPerMonth === Infinity) return;
  const [{ count }] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM invoices
     WHERE workspace_id = $1 AND status <> 'void'
       AND created_at >= date_trunc('month', now() AT TIME ZONE $2)`,
    [ctx.workspaceId, ctx.workspace.timezone],
  );
  if (count >= limits.invoicesPerMonth) {
    throw new ToolError(
      `The free plan includes ${limits.invoicesPerMonth} invoices per month. Upgrade for unlimited invoices.`,
      'plan_limit',
      { upgrade_url: upgradeUrl(), limit: 'invoices_per_month', plan: ctx.workspace.plan },
    );
  }
}
