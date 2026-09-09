import { one, query, withTx } from '../db/index.js';
import { ToolError } from '../lib/errors.js';
import { emailDomain, matchClient, matchProject, type MatchableProject, type MatchDecision, type MatchOptions } from '../lib/match.js';
import { toCents } from '../lib/money.js';
import { assertClientLimit, type Ctx } from './context.js';

export interface ClientRow {
  id: string;
  workspace_id: string;
  name: string;
  billing_email: string | null;
  address: string | null;
  default_rate_cents: number | null;
  net_terms_days: number;
  archived: boolean;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  client_id: string | null;
  name: string;
  aliases: string[];
  rate_cents: number | null;
  billable_default: boolean;
  archived: boolean;
}

export interface ProjectWithClient extends ProjectRow {
  client_name: string | null;
  client_rate_cents: number | null;
  client_email: string | null;
  recent_entries: number;
}

export async function listClients(ctx: Ctx, includeArchived = false): Promise<ClientRow[]> {
  return query<ClientRow>(
    `SELECT * FROM clients WHERE workspace_id = $1 ${includeArchived ? '' : 'AND archived = false'} ORDER BY name`,
    [ctx.workspaceId],
  );
}

export async function listProjects(ctx: Ctx, includeArchived = false): Promise<ProjectWithClient[]> {
  return query<ProjectWithClient>(
    `SELECT p.*, c.name AS client_name, c.default_rate_cents AS client_rate_cents, c.billing_email AS client_email,
            (SELECT count(*)::int FROM time_entries t WHERE t.project_id = p.id AND t.date >= (current_date - 30)) AS recent_entries
     FROM projects p LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.workspace_id = $1 ${includeArchived ? '' : 'AND p.archived = false'}
     ORDER BY c.name NULLS LAST, p.name`,
    [ctx.workspaceId],
  );
}

export function toMatchable(p: ProjectWithClient): MatchableProject {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases ?? [],
    clientId: p.client_id,
    clientName: p.client_name,
    clientEmailDomain: emailDomain(p.client_email),
    recentEntries: p.recent_entries,
    archived: p.archived,
  };
}

/** Resolve a project reference (name, alias, or id). Never auto-creates. */
export async function resolveProject(
  ctx: Ctx,
  ref: string | null | undefined,
  opts: MatchOptions = {},
  projects?: ProjectWithClient[],
): Promise<{ decision: MatchDecision; project: ProjectWithClient | null }> {
  const all = projects ?? (await listProjects(ctx, true));
  if (!ref || !ref.trim()) return { decision: { kind: 'none', candidates: [] }, project: null };
  const decision = matchProject(ref, all.map(toMatchable), opts);
  const project = decision.kind === 'match' ? all.find((p) => p.id === decision.project.id) ?? null : null;
  return { decision, project };
}

export async function resolveClient(ctx: Ctx, ref: string): Promise<ClientRow> {
  const clients = await listClients(ctx, true);
  const m = matchClient(ref, clients);
  if (m.kind === 'match') return m.client;
  if (m.kind === 'ambiguous') {
    throw new ToolError(`"${ref}" matches several clients. Ask the user which one.`, 'ambiguous', { candidates: m.candidates });
  }
  throw new ToolError(`No client matches "${ref}". Use workspace.list_projects to see clients, or workspace.create_client to add one.`, 'not_found', {
    candidates: m.candidates,
  });
}

export async function createClient(
  ctx: Ctx,
  input: { name: string; billing_email?: string | null; address?: string | null; rate?: number | null; net_terms_days?: number | null },
): Promise<ClientRow> {
  const name = input.name.trim();
  if (!name) throw new ToolError('Client name is required', 'invalid');
  const existing = await one<ClientRow>(`SELECT * FROM clients WHERE workspace_id = $1 AND lower(name) = lower($2)`, [ctx.workspaceId, name]);
  if (existing) throw new ToolError(`Client "${existing.name}" already exists`, 'conflict', { client: publicClient(existing) });
  await assertClientLimit(ctx);
  const row = await one<ClientRow>(
    `INSERT INTO clients (workspace_id, name, billing_email, address, default_rate_cents, net_terms_days)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ctx.workspaceId, name, input.billing_email ?? null, input.address ?? null, toCents(input.rate), input.net_terms_days ?? 30],
  );
  return row!;
}

export async function createProject(
  ctx: Ctx,
  input: { name: string; client?: string | null; rate?: number | null; billable_default?: boolean; aliases?: string[] },
): Promise<ProjectWithClient> {
  const name = input.name.trim();
  if (!name) throw new ToolError('Project name is required', 'invalid');
  const existing = await one<ProjectRow>(`SELECT * FROM projects WHERE workspace_id = $1 AND lower(name) = lower($2)`, [ctx.workspaceId, name]);
  if (existing) throw new ToolError(`Project "${existing.name}" already exists`, 'conflict', { project_id: existing.id });
  let clientId: string | null = null;
  if (input.client) clientId = (await resolveClient(ctx, input.client)).id;
  const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const row = await one<ProjectRow>(
    `INSERT INTO projects (workspace_id, client_id, name, aliases, rate_cents, billable_default)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ctx.workspaceId, clientId, name, aliases, toCents(input.rate), input.billable_default ?? true],
  );
  const all = await listProjects(ctx, true);
  return all.find((p) => p.id === row!.id)!;
}

export function publicClient(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    billing_email: c.billing_email,
    rate: c.default_rate_cents != null ? c.default_rate_cents / 100 : null,
    net_terms_days: c.net_terms_days,
    archived: c.archived,
  };
}

export function publicProject(p: ProjectWithClient, ws: Ctx['workspace']) {
  const effective = p.rate_cents ?? p.client_rate_cents ?? ws.default_rate_cents;
  return {
    id: p.id,
    name: p.name,
    client: p.client_name,
    client_id: p.client_id,
    aliases: p.aliases,
    rate: p.rate_cents != null ? p.rate_cents / 100 : null,
    effective_rate: effective / 100,
    billable_default: p.billable_default,
    archived: p.archived,
  };
}

/** Compact JSON for the workspace://context resource. */
export async function contextResource(ctx: Ctx) {
  const [clients, projects, recent] = await Promise.all([
    listClients(ctx),
    listProjects(ctx),
    query<{ description: string }>(
      `SELECT description FROM (
         SELECT description, max(created_at) AS last FROM time_entries
         WHERE workspace_id = $1 AND description <> '' GROUP BY description
       ) d ORDER BY last DESC LIMIT 20`,
      [ctx.workspaceId],
    ),
  ]);
  const ws = ctx.workspace;
  return {
    workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone, default_rate: ws.default_rate_cents / 100, plan: ws.plan },
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      rate: c.default_rate_cents != null ? c.default_rate_cents / 100 : null,
      projects: projects.filter((p) => p.client_id === c.id).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, rate: (p.rate_cents ?? c.default_rate_cents ?? ws.default_rate_cents) / 100, billable_default: p.billable_default })),
    })),
    unassigned_projects: projects.filter((p) => !p.client_id).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, rate: (p.rate_cents ?? ws.default_rate_cents) / 100 })),
    recent_descriptions: recent.map((r) => r.description),
  };
}

export async function updateWorkspace(
  ctx: Ctx,
  patch: Partial<Pick<Ctx['workspace'], 'name' | 'currency' | 'timezone' | 'default_rate_cents' | 'invoice_prefix' | 'logo_url' | 'business_address'>>,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE workspaces SET ${sets} WHERE id = $1`, [ctx.workspaceId, ...keys.map((k) => patch[k])]);
}

export { withTx };
