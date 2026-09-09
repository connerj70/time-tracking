import { describe, expect, it } from 'vitest';
import { matchClient, matchProject, type MatchableProject } from '../src/lib/match.js';

const projects: MatchableProject[] = [
  { id: 'p1', name: 'Website Redesign', aliases: ['acme site', 'landing page'], clientId: 'c1', clientName: 'Acme Corp', clientEmailDomain: 'acme.com', recentEntries: 12 },
  { id: 'p2', name: 'Mobile App', aliases: [], clientId: 'c1', clientName: 'Acme Corp', clientEmailDomain: 'acme.com', recentEntries: 3 },
  { id: 'p3', name: 'Brand Identity', aliases: ['logo'], clientId: 'c2', clientName: 'Globex', clientEmailDomain: 'globex.io', recentEntries: 0 },
  { id: 'p4', name: 'Internal', aliases: ['admin', 'ops'], clientId: null, clientName: null, recentEntries: 20 },
];

describe('matchProject', () => {
  it('exact name', () => {
    const r = matchProject('Website Redesign', projects);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p1');
  });
  it('alias', () => {
    const r = matchProject('acme site', projects);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p1');
  });
  it('case/punctuation insensitive partial', () => {
    const r = matchProject('the redesign', projects);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p1');
  });
  it('client name alone is ambiguous when the client has several projects', () => {
    const r = matchProject('Acme', projects);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.id).sort()).toEqual(['p1', 'p2']);
  });
  it('client name resolves when the client has one project', () => {
    const r = matchProject('Globex', projects);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p3');
  });
  it('id', () => {
    const r = matchProject('p2', [{ ...projects[1], id: '123e4567-e89b-12d3-a456-426614174000' }]);
    expect(r.kind).not.toBe('match');
    const r2 = matchProject('123e4567-e89b-12d3-a456-426614174000', [{ ...projects[1], id: '123e4567-e89b-12d3-a456-426614174000' }]);
    expect(r2.kind).toBe('match');
  });
  it('no match returns none, never guesses', () => {
    const r = matchProject('quarterly taxes', projects);
    expect(r.kind).toBe('none');
  });
  it('participant domain boosts a client project', () => {
    const r = matchProject('Sync call', [projects[2], projects[3]], { participantEmails: ['jane@globex.io'], threshold: 0.6, gap: 0.1 });
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p3');
  });
  it('typo tolerance via trigrams', () => {
    const r = matchProject('brand identty', projects);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.project.id).toBe('p3');
  });
});

describe('matchClient', () => {
  const clients = [
    { id: 'c1', name: 'Acme Corp' },
    { id: 'c2', name: 'Acme Labs' },
    { id: 'c3', name: 'Globex' },
  ];
  it('exact', () => expect(matchClient('Globex', clients).kind).toBe('match'));
  it('ambiguous prefix', () => expect(matchClient('Acme', clients).kind).toBe('ambiguous'));
  it('none', () => expect(matchClient('Initech', clients).kind).toBe('none'));
});
