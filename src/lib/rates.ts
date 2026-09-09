/** Rate resolution order: entry override → project rate → client rate → workspace default. */
export function resolveRateCents(opts: {
  entryRateCents?: number | null;
  projectRateCents?: number | null;
  clientRateCents?: number | null;
  workspaceDefaultCents: number;
}): { rateCents: number; source: 'entry' | 'project' | 'client' | 'workspace' } {
  if (opts.entryRateCents != null) return { rateCents: opts.entryRateCents, source: 'entry' };
  if (opts.projectRateCents != null) return { rateCents: opts.projectRateCents, source: 'project' };
  if (opts.clientRateCents != null) return { rateCents: opts.clientRateCents, source: 'client' };
  return { rateCents: opts.workspaceDefaultCents, source: 'workspace' };
}
