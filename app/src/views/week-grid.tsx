import { dayLabel, eachDay, hours, money, todayLocal, type ReportData } from '../types.js';

interface Props {
  data: ReportData;
  sendPrompt: (t: string) => Promise<void>;
  canSend: boolean;
}

/**
 * Week grid: columns = days, rows = projects, cell = hours, footer = daily totals.
 * Read-only: tapping a cell asks the conversation to show the entries. Wraps to a stacked day list under 520px.
 */
export function WeekGrid({ data, sendPrompt, canSend }: Props) {
  const days = eachDay(data.range.start, data.range.end);
  const today = todayLocal();
  const byDay = new Map(data.groups.map((g) => [g.key, g]));
  const projects = new Map<string, { project: string; client: string | null; cells: Map<string, number>; total: number }>();
  for (const g of data.groups) {
    for (const p of g.projects ?? []) {
      const key = `${p.client ?? ''}|${p.project}`;
      const row = projects.get(key) ?? { project: p.project, client: p.client, cells: new Map(), total: 0 };
      row.cells.set(g.key, (row.cells.get(g.key) ?? 0) + p.hours);
      row.total += p.hours;
      projects.set(key, row);
    }
  }
  const rows = [...projects.values()].sort((a, b) => b.total - a.total);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const maxCell = Math.max(1, ...rows.flatMap((r) => [...r.cells.values()]));

  const ask = (d: string, project?: string) => {
    const { long } = dayLabel(d);
    return sendPrompt(project ? `Show my entries for ${long} ${d} on ${project}` : `Show my entries for ${long} ${d}`);
  };

  return (
    <div class="card">
      <div class="hdr">
        <div>
          <h1>Week of {data.range.start}</h1>
          <div class="sub">
            {data.range.start} → {data.range.end} · {data.timezone}
            {data.filters?.client ? ` · ${data.filters.client}` : ''}
            {data.filters?.project ? ` · ${data.filters.project}` : ''}
          </div>
        </div>
        {data.unbilled_amount > 0 && <span class="pill warn">Unbilled {money(data.unbilled_amount, data.currency)}</span>}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Total</div><div class="v">{data.total_hours}h</div></div>
        <div class="stat"><div class="k">Billable</div><div class="v">{data.billable_hours}h</div></div>
        <div class="stat"><div class="k">Billable value</div><div class="v">{money(data.billable_amount, data.currency)}</div></div>
        <div class="stat"><div class="k">Entries</div><div class="v">{data.entry_count}</div></div>
      </div>

      {rows.length === 0 ? (
        <div class="empty">No time logged in this range.</div>
      ) : (
        weeks.map((week) => (
          <div>
            <div class="grid" style={`--days:${week.length}`}>
              <div class="h" />
              {week.map((d) => {
                const l = dayLabel(d);
                return (
                  <div class={`h ${d === today ? 'today' : ''}`}>
                    {l.dow}
                    <span class="d">{l.dm}</span>
                  </div>
                );
              })}
              <div class="h right">Σ</div>
              {rows.map((r) => (
                <>
                  <div class="rowh" title={r.project}>
                    {r.project}
                    {r.client && <small>{r.client}</small>}
                  </div>
                  {week.map((d) => {
                    const h = r.cells.get(d) ?? 0;
                    const intensity = h === 0 ? 'zero' : h / maxCell > 0.66 ? 'h2' : h / maxCell > 0.33 ? 'h1' : '';
                    return (
                      <div class={`cell ${intensity}`} role={h && canSend ? 'button' : undefined} tabIndex={h && canSend ? 0 : -1} onClick={() => h && canSend && ask(d, r.project)} onKeyDown={(e) => e.key === 'Enter' && h && canSend && ask(d, r.project)}>
                        {hours(h)}
                      </div>
                    );
                  })}
                  <div class="rowtot num">{hours(r.total)}</div>
                </>
              ))}
              <div class="foot muted">Total</div>
              {week.map((d) => {
                const g = byDay.get(d);
                return (
                  <div class="tot foot" onClick={() => g?.hours && canSend && ask(d)} style={g?.hours && canSend ? 'cursor:pointer' : ''}>
                    {hours(g?.hours ?? 0)}
                  </div>
                );
              })}
              <div class="tot foot num">{hours(week.reduce((s, d) => s + (byDay.get(d)?.hours ?? 0), 0))}</div>
            </div>
          </div>
        ))
      )}

      <div class="daylist">
        {days.map((d) => {
          const g = byDay.get(d);
          if (!g || !g.hours) return null;
          const l = dayLabel(d);
          return (
            <div class="day">
              <div class="dh" onClick={() => canSend && ask(d)}>
                <span>{l.long} {d.slice(5)}</span>
                <span class="num">{hours(g.hours)}h</span>
              </div>
              {(g.projects ?? []).map((p) => (
                <div class="dp" onClick={() => canSend && ask(d, p.project)}>
                  <span>{p.project}{p.client ? ` · ${p.client}` : ''}</span>
                  <span class="num">{hours(p.hours)}h</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
