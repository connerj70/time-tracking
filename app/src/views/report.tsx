import { hours, money, type ReportData } from '../types.js';

interface Props {
  data: ReportData;
  sendPrompt: (t: string) => Promise<void>;
  canSend: boolean;
}

export function ReportTable({ data, sendPrompt, canSend }: Props) {
  const label = data.group_by === 'client' ? 'Client' : data.group_by === 'project' ? 'Project' : 'Group';
  return (
    <div class="card">
      <div class="hdr">
        <div>
          <h1>Hours {data.range.start} → {data.range.end}</h1>
          <div class="sub">{data.timezone}{data.filters?.client ? ` · ${data.filters.client}` : ''}{data.filters?.project ? ` · ${data.filters.project}` : ''}</div>
        </div>
        {data.unbilled_amount > 0 && <span class="pill warn">Unbilled {money(data.unbilled_amount, data.currency)}</span>}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Total</div><div class="v">{data.total_hours}h</div></div>
        <div class="stat"><div class="k">Billable</div><div class="v">{data.billable_hours}h</div></div>
        <div class="stat"><div class="k">Non-billable</div><div class="v">{data.non_billable_hours}h</div></div>
        <div class="stat"><div class="k">Billable value</div><div class="v">{money(data.billable_amount, data.currency)}</div></div>
      </div>
      {data.groups.length > 0 && (
        <table>
          <thead>
            <tr><th>{label}</th><th class="r">Hours</th><th class="r hide-sm">Billable</th><th class="r">Unbilled</th></tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <tr style={canSend ? 'cursor:pointer' : ''} onClick={() => canSend && sendPrompt(`Show my entries for ${g.label} from ${data.range.start} to ${data.range.end}`)}>
                <td>{g.label}{g.client ? <span class="muted"> · {g.client}</span> : null}</td>
                <td class="r num">{hours(g.hours)}</td>
                <td class="r num hide-sm">{hours(g.billable_hours)}</td>
                <td class="r num">{g.unbilled_amount ? money(g.unbilled_amount, data.currency) : '·'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
