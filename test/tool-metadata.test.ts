import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Directory reviewers flag unannotated tools and vague descriptions. This test keeps every registered tool honest:
 * title, annotations with all three hints, "Use this" opening, ≤64-char name, and a stated "do not use" scope for writes.
 */
const src = readFileSync('src/mcp/server.ts', 'utf8');
const blocks = [...src.matchAll(/(?:server\.registerTool|registerAppTool)\(\s*(?:server,\s*)?'([^']+)',\s*\{([\s\S]*?)\n\s{4}\},/g)];

describe('tool metadata', () => {
  it('finds the tool surface', () => {
    const names = blocks.map((b) => b[1]);
    expect(names).toEqual(
      expect.arrayContaining([
        'time.list_entries', 'time.report', 'workspace.list_projects', 'invoice.list', 'invoice.get', 'invoice.preview_draft', 'time.propose_entries',
        'time.log_entry', 'time.log_entries_batch', 'time.update_entry', 'time.delete_entry', 'workspace.create_client', 'workspace.create_project',
        'invoice.create_draft', 'invoice.record_payment', 'invoice.send', 'invoice.void',
      ]),
    );
    expect(names.length).toBe(17);
  });
  for (const [, name, body] of blocks) {
    it(`${name} is well described`, () => {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[a-z_.]+$/);
      expect(body).toMatch(/title:\s*'/);
      expect(body).toMatch(/description:\s*\n?\s*'Use this/);
      expect(body).toMatch(/annotations:/);
      const ann = body.match(/annotations: \{ \.\.\.(\w+)/)?.[1];
      expect(ann, 'annotations preset').toBeTruthy();
      if (name === 'invoice.send' || name === 'invoice.void') expect(ann).toMatch(/^EXTERNAL/);
      if (name.startsWith('time.list') || name.endsWith('.list') || name.endsWith('.get') || name.includes('preview') || name.includes('propose') || name.includes('list_projects')) expect(ann).toBe('READ');
      if (name.includes('update') || name.includes('delete')) expect(ann).toBe('MODIFY');
    });
  }
});
