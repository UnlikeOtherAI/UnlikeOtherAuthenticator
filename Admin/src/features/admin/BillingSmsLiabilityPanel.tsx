import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { SelectField } from '../../components/ui/FormFields';
import { createApiClient } from '../../services/api-client';

const api = createApiClient();
const Schema = z.object({ kind: z.enum(['inbound', 'outbound']), next_cursor: z.string().nullable(),
  liabilities: z.array(z.object({ id: z.string(), service_id: z.string(), number_id: z.string(),
    allocation_id: z.string(), account_sid: z.string(), message_sid: z.string().nullable(),
    organisation_id: z.string(), team_id: z.string(), state: z.string(), dispatch_id: z.string().nullable(),
    standing_hold_id: z.string().nullable(), reserved_credits: z.string().nullable(), consumed_credits: z.string().nullable(),
    uncollected_credits: z.string().nullable(), created_at: z.string(), updated_at: z.string() }).strict()),
}).strict();
export function BillingSmsLiabilityPanel() {
  const [kind, setKind] = useState<'inbound' | 'outbound'>('inbound');
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['admin', 'billing', 'sms-liabilities', kind, cursor],
    queryFn: async () => Schema.parse(await api.get<unknown>(`/internal/admin/billing/sms-policies/liabilities?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' })) });
  return <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">SMS dispatch and inbound recovery</h3>
    <p className="text-sm text-gray-500">Provider uncertainty keeps outbound funds held. Inbound charges without a
      funded standing reserve remain uncollected liability. Missing prices are unknown; reconciliation never
      grants a retry, releases a hold or silently charges the wallet.</p>
    <div className="flex flex-wrap gap-3"><SelectField aria-label="Recovery direction" value={kind}
      onChange={(event) => { setKind(event.target.value === 'outbound' ? 'outbound' : 'inbound'); setCursor(null); }}>
      <option value="inbound">Inbound liabilities</option><option value="outbound">Outbound held dispatches</option>
    </SelectField><Button onClick={() => void query.refetch()}>Reload liabilities</Button></div>
    {query.isLoading ? <p>Loading SMS liabilities...</p> : null}
    {query.isError ? <p role="alert" className="text-sm text-red-600">Could not load SMS liabilities. Reload to retry.</p> : null}
    {query.data?.liabilities.map((row) => <details key={row.id} className="rounded-lg border border-gray-200 p-3 text-sm">
      <summary className="cursor-pointer break-all font-medium">{row.state.replaceAll('_', ' ')} · {row.message_sid ?? row.dispatch_id ?? row.id}</summary>
      <div className="mt-3 space-y-1 break-all text-xs text-gray-500">
        <p>Product {row.service_id} · receipt/reservation {row.id}</p>
        <p>Number {row.number_id} · frozen allocation {row.allocation_id}</p>
        <p>Provider account {row.account_sid}</p>
        <Link className="block text-blue-600 hover:underline" to={`/organisations/${encodeURIComponent(row.organisation_id)}/teams/${encodeURIComponent(row.team_id)}`}>Organisation {row.organisation_id} · original team {row.team_id}</Link>
        <p>Held credits: {row.reserved_credits ?? 'Not applicable'}</p>
        <p>Consumed credits: {row.consumed_credits ?? 'Unknown'}</p>
        <p>Uncollected credits: {row.uncollected_credits ?? 'Unknown'}</p>
        <p>Updated {new Date(row.updated_at).toLocaleString()}</p>
        <p>Recover the original provider receipt through the approved product SMS runtime workflow.
          Review above-bound charges explicitly before any financial resolution. This operator view performs no financial write.</p>
      </div>
    </details>)}
    {query.data?.liabilities.length === 0 ? <p className="text-sm text-gray-500">No {kind} liabilities awaiting recovery.</p> : null}
    <div className="flex gap-2">{cursor ? <Button onClick={() => setCursor(null)}>First page</Button> : null}
      {query.data?.next_cursor ? <Button onClick={() => setCursor(query.data?.next_cursor ?? null)}>Older liabilities</Button> : null}</div>
  </Card>;
}
