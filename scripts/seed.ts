/**
 * Seeds a fully populated demo/reviewer workspace: 3 clients, 6 projects, ~40 entries across 3 weeks,
 * 2 invoices (one paid, one sent). Idempotent per email. Usage: npm run db:seed [-- email@example.com]
 */
import { DateTime } from 'luxon';
import { pool, one, query } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { loadContext } from '../src/services/context.js';
import { createClient, createProject } from '../src/services/workspace.js';
import { logEntry } from '../src/services/time.js';
import { createDraft } from '../src/services/invoices.js';
import { createWorkspaceForUser, upsertUser } from '../src/auth/users.js';

const email = process.argv[2] ?? 'reviewer@example.com';
const TZ = 'America/New_York';

async function main() {
  await migrate();
  const existing = await one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing) {
    console.log(`User ${email} already exists; delete it first to re-seed:\n  DELETE FROM users WHERE email = '${email}';`);
    return;
  }
  const u = await upsertUser({ email, name: 'Riley Reviewer', provider: 'magic_link' });
  const wsId = await createWorkspaceForUser(u.userId, { businessName: 'Riley Design Studio', defaultRate: 120, currency: 'USD', timezone: TZ }, { email });
  await query(`UPDATE workspaces SET plan = 'pro', business_address = '410 Market St, Suite 12\nSan Francisco, CA 94105' WHERE id = $1`, [wsId]);
  const ctx = await loadContext(u.userId, wsId);

  const acme = await createClient(ctx, { name: 'Acme Corp', billing_email: 'ap@acme.com', address: '1 Acme Way\nAustin, TX', rate: 150, net_terms_days: 30 });
  const globex = await createClient(ctx, { name: 'Globex', billing_email: 'billing@globex.io', rate: 135, net_terms_days: 14 });
  const initech = await createClient(ctx, { name: 'Initech', billing_email: 'finance@initech.example', rate: 110, net_terms_days: 30 });
  const P = {
    redesign: await createProject(ctx, { name: 'Website Redesign', client: acme.name, aliases: ['acme site', 'landing page', 'redesign'], rate: 160 }),
    mobile: await createProject(ctx, { name: 'Mobile App', client: acme.name, aliases: ['ios app', 'acme app'] }),
    brand: await createProject(ctx, { name: 'Brand Identity', client: globex.name, aliases: ['logo', 'branding'] }),
    deck: await createProject(ctx, { name: 'Investor Deck', client: globex.name, aliases: ['pitch deck', 'deck'] }),
    portal: await createProject(ctx, { name: 'Customer Portal', client: initech.name, aliases: ['portal', 'tps portal'] }),
    internal: await createProject(ctx, { name: 'Internal', aliases: ['admin', 'ops', 'bizdev'], billable_default: false }),
  };

  const today = DateTime.now().setZone(TZ).startOf('day');
  const weekStart = today.startOf('week'); // Monday
  const plan: [keyof typeof P, string, number][] = [
    ['redesign', 'Hero section and nav', 150], ['redesign', 'Responsive layout fixes', 120], ['mobile', 'Onboarding flow wireframes', 90],
    ['brand', 'Logo concepts round 1', 180], ['portal', 'Dashboard components', 150], ['internal', 'Invoicing and admin', 45],
    ['redesign', 'Client review call', 60], ['deck', 'Slides 1-10 layout', 120], ['portal', 'Auth screens', 135],
    ['mobile', 'Design system tokens', 90], ['brand', 'Color palette exploration', 120], ['internal', 'Proposal for new lead', 60],
    ['redesign', 'Footer and contact form', 105], ['portal', 'Table and filters', 180], ['deck', 'Charts and data slides', 90],
  ];
  // Three weeks: two past weeks fully populated, current week partially.
  let n = 0;
  for (let w = 2; w >= 0; w--) {
    const start = weekStart.minus({ weeks: w });
    for (let d = 0; d < 5; d++) {
      const day = start.plus({ days: d });
      if (day > today) continue;
      const perDay = w === 0 ? 2 : 3;
      for (let k = 0; k < perDay; k++) {
        const [proj, desc, min] = plan[(d * 3 + k + w * 5) % plan.length];
        const startAt = day.set({ hour: 9 + k * 3, minute: 0 });
        const r = await logEntry(ctx, {
          description: desc,
          project: P[proj].id,
          start: startAt.toISO()!,
          end: startAt.plus({ minutes: min }).toISO()!,
          idempotency_key: `seed:${day.toISODate()}:${k}`,
        });
        if (r.status === 'logged') n++;
        else console.warn('seed entry skipped', day.toISODate(), r.status);
      }
    }
  }

  // Invoices: Acme (two weeks ago, paid) and Globex (last week, sent & overdue-ish).
  const twoWeeksEnd = weekStart.minus({ weeks: 1 }).minus({ days: 1 }).toISODate()!;
  const acmeInv = await createDraft(ctx, { client: acme.name, through_date: twoWeeksEnd, issue_date: weekStart.minus({ weeks: 1 }).toISODate()!, notes: 'Thank you for your business.' });
  await query(`UPDATE invoices SET status = 'paid', sent_at = now() - interval '12 days', viewed_at = now() - interval '11 days', paid_at = now() - interval '9 days', paid_via = 'stripe', paid_note = 'seed' WHERE id = $1`, [acmeInv.id]);
  const globexInv = await createDraft(ctx, { client: globex.name, through_date: weekStart.minus({ days: 1 }).toISODate()!, issue_date: weekStart.minus({ days: 20 }).toISODate()!, due_in_days: 14 });
  await query(`UPDATE invoices SET status = 'sent', sent_at = now() - interval '20 days' WHERE id = $1`, [globexInv.id]);

  console.log(`Seeded workspace "${ctx.workspace.name}" for ${email}: 3 clients, 6 projects, ${n} entries, invoices ${acmeInv.number} (paid) and ${globexInv.number} (sent, overdue).`);
  console.log(`Sign in with a magic link for ${email} (printed to the server log when RESEND_API_KEY is unset).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
