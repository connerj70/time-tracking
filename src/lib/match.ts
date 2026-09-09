/**
 * Fuzzy project/client matching. Never guesses: returns a decision plus ranked candidates.
 * Signals: exact id, exact name, alias, client name, token overlap, trigram similarity,
 * participant email domains, and a recent-usage prior.
 */
export interface MatchableProject {
  id: string;
  name: string;
  aliases: string[];
  clientId: string | null;
  clientName: string | null;
  clientEmailDomain?: string | null;
  recentEntries?: number; // usage in the last 30 days
  archived?: boolean;
}

export interface Candidate {
  id: string;
  name: string;
  clientName: string | null;
  confidence: number; // 0..1
  reason: string;
}

export type MatchDecision =
  | { kind: 'match'; project: MatchableProject; confidence: number; reason: string; candidates: Candidate[] }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'none'; candidates: Candidate[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['the', 'a', 'an', 'for', 'on', 'of', 'and', 'to', 'in', 'with', 'project', 'client', 'work', 'meeting', 'call']);

export function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Similarity between a free-text query and one field (name/alias/client). */
export function fieldSimilarity(query: string, field: string): number {
  const q = normalize(query);
  const f = normalize(field);
  if (!q || !f) return 0;
  if (q === f) return 1;
  // Containment: "acme" in "acme redesign" or "acme redesign landing" contains "acme redesign"
  if (f.includes(q) || q.includes(f)) {
    const ratio = Math.min(q.length, f.length) / Math.max(q.length, f.length);
    return 0.7 + 0.25 * ratio;
  }
  const qt = tokens(q);
  const ft = tokens(f);
  let tokenScore = 0;
  if (qt.length && ft.length) {
    let hits = 0;
    for (const t of qt) {
      if (ft.includes(t)) hits++;
      else if (ft.some((x) => x.startsWith(t) || t.startsWith(x)) && t.length >= 3) hits += 0.7;
      else if (t.length >= 4 && ft.some((x) => x.length >= 4 && dice(t, x) >= 0.6)) hits += 0.85; // typo tolerance per token
    }
    // Weight by coverage of the shorter side so "acme" fully covers a one-token field.
    tokenScore = Math.min(1, hits / Math.min(qt.length, ft.length)) * 0.85;
  }
  const tri = dice(q, f) * 0.8;
  return Math.max(tokenScore, tri);
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const m = email.toLowerCase().match(/@([a-z0-9.-]+)$/);
  return m ? m[1] : null;
}

const GENERIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com']);

export interface MatchOptions {
  /** Emails of meeting participants etc. Domains are matched against client billing domains. */
  participantEmails?: string[];
  /** Threshold for a confident single match. */
  threshold?: number;
  /** Minimum gap between #1 and #2 to call it unambiguous. */
  gap?: number;
  maxCandidates?: number;
}

export function scoreProject(query: string, p: MatchableProject, opts: MatchOptions = {}): { score: number; reason: string } {
  let best = 0;
  let reason = 'no match';
  const consider = (s: number, r: string) => {
    if (s > best) {
      best = s;
      reason = r;
    }
  };
  if (query && UUID_RE.test(query.trim()) && query.trim().toLowerCase() === p.id.toLowerCase()) return { score: 1, reason: 'exact id' };
  if (query) {
    consider(fieldSimilarity(query, p.name), `project name "${p.name}"`);
    for (const a of p.aliases ?? []) consider(fieldSimilarity(query, a) * 0.98, `alias "${a}"`);
    if (p.clientName) {
      const cs = fieldSimilarity(query, p.clientName);
      // Client-name hits are useful but shouldn't outrank a project-name hit of the same strength.
      consider(cs * 0.9, `client name "${p.clientName}"`);
      // Query mentions both client and project fragments ("acme site")
      const combined = fieldSimilarity(query, `${p.clientName} ${p.name}`);
      consider(combined, `client + project "${p.clientName} ${p.name}"`);
    }
  }
  if (opts.participantEmails?.length && p.clientEmailDomain && !GENERIC_DOMAINS.has(p.clientEmailDomain)) {
    const domains = new Set(opts.participantEmails.map(emailDomain).filter(Boolean));
    if (domains.has(p.clientEmailDomain)) {
      // Boost text evidence for this client's projects; only a modest floor when there is no text signal,
      // so a client with several projects stays ambiguous instead of being guessed.
      if (best > 0.3) consider(Math.min(1, best + 0.15), `${reason} + participant from ${p.clientEmailDomain}`);
      else consider(0.62, `participant from ${p.clientEmailDomain}`);
    }
  }
  // Recent-usage prior: small nudge, never enough to flip a clear text match.
  const usage = p.recentEntries ?? 0;
  if (best > 0 && usage > 0) best = Math.min(1, best + Math.min(0.06, Math.log1p(usage) * 0.015));
  if (p.archived) best *= 0.5;
  return { score: Math.round(best * 1000) / 1000, reason };
}

export function matchProject(query: string, projects: MatchableProject[], opts: MatchOptions = {}): MatchDecision {
  const threshold = opts.threshold ?? 0.75;
  const gap = opts.gap ?? 0.15;
  const max = opts.maxCandidates ?? 5;
  const scored = projects
    .map((p) => ({ p, ...scoreProject(query, p, opts) }))
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score);
  const candidates: Candidate[] = scored.slice(0, max).map((x) => ({
    id: x.p.id,
    name: x.p.name,
    clientName: x.p.clientName,
    confidence: x.score,
    reason: x.reason,
  }));
  if (!scored.length) return { kind: 'none', candidates };
  const top = scored[0];
  const second = scored[1];
  const clear = top.score >= threshold && (!second || top.score - second.score >= gap || top.score >= 0.97);
  if (clear) return { kind: 'match', project: top.p, confidence: top.score, reason: top.reason, candidates };
  return { kind: 'ambiguous', candidates };
}

/** Match a client by name/id. Same shape, simpler. */
export function matchClient<T extends { id: string; name: string; archived?: boolean }>(
  query: string,
  clients: T[],
  threshold = 0.75,
): { kind: 'match'; client: T; confidence: number } | { kind: 'ambiguous' | 'none'; candidates: { id: string; name: string; confidence: number }[] } {
  const q = query.trim();
  const scored = clients
    .map((c) => ({
      c,
      score: UUID_RE.test(q) && q.toLowerCase() === c.id.toLowerCase() ? 1 : fieldSimilarity(q, c.name) * (c.archived ? 0.5 : 1),
    }))
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5).map((x) => ({ id: x.c.id, name: x.c.name, confidence: Math.round(x.score * 1000) / 1000 }));
  if (!scored.length) return { kind: 'none', candidates };
  const [top, second] = scored;
  if (top.score >= threshold && (!second || top.score - second.score >= 0.15 || top.score >= 0.97)) {
    return { kind: 'match', client: top.c, confidence: Math.round(top.score * 1000) / 1000 };
  }
  return { kind: 'ambiguous', candidates };
}
