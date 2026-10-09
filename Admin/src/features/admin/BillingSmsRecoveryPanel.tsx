import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { createApiClient } from '../../services/api-client';
import { BillingSmsRefundVerificationForm } from './BillingSmsRefundVerificationForm';

const api = createApiClient(); const base = '/internal/admin/billing/sms-policies/recovery';
const Resource = z.object({ id: z.string(), service_id: z.string(), organisation_id: z.string(),
  phone_number: z.string(), country: z.string(), state: z.string(), recovery_reason: z.string().nullable() });
const List = z.object({ resources: z.array(Resource.extend({ created_at: z.string(), updated_at: z.string() }).strict()),
  next_cursor: z.string().nullable() }).strict();
const Detail = Resource.extend({ account_sid: z.string().nullable(), phone_number_sid: z.string().nullable(),
  quote: z.object({ id: z.string(), final_amount: z.string(), final_currency: z.string(),
    expires_at: z.string(), created_at: z.string() }).strict(),
  subscriptions: z.array(z.object({ id: z.string(), stripe_account_id: z.string(), stripe_subscription_id: z.string(),
    initial_invoice_id: z.string().nullable(), initial_invoice_paid_at: z.string().nullable(),
    status: z.string(), livemode: z.boolean(), cancel_at_period_end: z.boolean() }).strict()),
  refund_action_available: z.boolean(), operator_next_step: z.string(),
}).strict();
export function BillingSmsRecoveryPanel() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(''); const [lookup, setLookup] = useState('');
  const rows = useQuery({ queryKey: ['admin', 'billing', 'sms-recovery', cursor],
    queryFn: async () => List.parse(await api.get<unknown>(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' })) });
  const detail = useQuery({ queryKey: ['admin', 'billing', 'sms-recovery-detail', selected], enabled: Boolean(selected),
    queryFn: async () => Detail.parse(await api.get<unknown>(`${base}/${encodeURIComponent(selected)}`, { cache: 'no-store' })) });
  return <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">Number payment recovery</h3>
    <p className="text-sm text-gray-500">Review resources awaiting cancellation, acquisition recovery or refund.
      A paid unavailable number stays bound to its original payment. Refund required is unresolved;
      only verified complete original refunds can finish recovery. This screen cannot issue a Stripe refund.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setSelected(lookup.trim()); }}>
      <FieldShell label="Exact resource ID"><TextField value={lookup} onChange={(event) => setLookup(event.target.value)} maxLength={160} /></FieldShell>
      <Button type="submit" disabled={!lookup.trim()}>Open resource</Button>
      <Button onClick={() => void rows.refetch()}>Reload recovery</Button>
    </form>
    {rows.isLoading ? <p className="text-sm text-gray-500">Loading recovery resources...</p> : null}
    {rows.isError ? <p role="alert" className="text-sm text-red-600">Could not load recovery resources. Reload to retry.</p> : null}
    {rows.data?.resources.map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-sm">
      <div><p className="font-medium">{row.phone_number} · {row.country} · {row.state.replaceAll('_', ' ')}</p>
        <p className="break-all text-xs text-gray-500">{row.id} · {row.recovery_reason ?? 'Reason unavailable'}</p></div>
      <Button onClick={() => setSelected(row.id)}>Review resource</Button>
    </div>)}
    {rows.data?.resources.length === 0 ? <p className="text-sm text-gray-500">No resources awaiting recovery.</p> : null}
    <div className="flex gap-2">{cursor ? <Button onClick={() => setCursor(null)}>First page</Button> : null}
      {rows.data?.next_cursor ? <Button onClick={() => setCursor(rows.data?.next_cursor ?? null)}>Older resources</Button> : null}</div>
    <Modal isOpen={Boolean(selected)} onClose={() => setSelected('')} title="SMS number recovery" widthClassName="max-w-2xl">
      {detail.isLoading ? <p>Loading exact resource...</p> : null}
      {detail.isError ? <p role="alert" className="text-sm text-red-600">Resource unavailable. <Button onClick={() => void detail.refetch()}>Retry</Button></p> : null}
      {detail.data ? <div className="space-y-3 text-sm">
        <p className="font-medium">{detail.data.phone_number} · {detail.data.state.replaceAll('_', ' ')}</p>
        <p className="break-all font-mono text-xs">Resource {detail.data.id}</p>
        <Link className="text-blue-600 hover:underline" to={`/organisations/${encodeURIComponent(detail.data.organisation_id)}`}>
          Organisation {detail.data.organisation_id}</Link>
        <p>{detail.data.recovery_reason ?? 'No recovery reason recorded'}</p>
        <p>Frozen customer quote: {detail.data.quote.final_currency} {detail.data.quote.final_amount} per month</p>
        <p className="break-all text-xs">Provider account {detail.data.account_sid ?? 'Not attached'} · number SID {detail.data.phone_number_sid ?? 'Not attached'}</p>
        {detail.data.subscriptions.map((item) => <div key={item.id} className="space-y-1 rounded-lg border border-gray-200 p-3 text-xs">
          <p>{item.livemode ? 'Live' : 'Test'} Stripe account {item.stripe_account_id}</p>
          <p className="break-all">Subscription {item.stripe_subscription_id} · {item.status} · cancellation at period end {item.cancel_at_period_end ? 'yes' : 'no'}</p>
          <p className="break-all">Initial invoice {item.initial_invoice_id ?? 'Unavailable'} · paid {item.initial_invoice_paid_at ?? 'Unverified'}</p>
        </div>)}
        {detail.data.subscriptions.length === 0 ? <p>Verified payment references unavailable.</p> : null}
        <p className="rounded-lg bg-amber-50 p-3 text-amber-900">{detail.data.operator_next_step}</p>
        {detail.data.refund_action_available ? <BillingSmsRefundVerificationForm key={detail.data.id}
          resourceId={detail.data.id} subscriptions={detail.data.subscriptions}
          onVerified={() => { void detail.refetch(); void rows.refetch(); }} /> : null}
      </div> : null}
    </Modal>
  </Card>;
}
