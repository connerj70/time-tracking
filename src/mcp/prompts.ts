import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillDoc {
  name: string;
  description: string;
  body: string;
}

function skillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '../../skills'), join(here, '../../../skills'), join(process.cwd(), 'skills')]) {
    if (existsSync(c)) return c;
  }
  return join(process.cwd(), 'skills');
}

let cache: SkillDoc[] | null = null;

/** Loads skills/<name>/SKILL.md, parsing the frontmatter so MCP prompts and the plugin share one source. */
export function loadSkills(): SkillDoc[] {
  if (cache) return cache;
  const dir = skillsDir();
  const out: SkillDoc[] = [];
  if (!existsSync(dir)) return (cache = out);
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let description = '';
    let body = raw;
    if (m) {
      body = m[2].trim();
      const d = m[1].match(/^description:\s*(.*)$/m);
      description = d ? d[1].trim().replace(/^["']|["']$/g, '') : '';
    }
    out.push({ name, description, body });
  }
  cache = out;
  return out;
}
