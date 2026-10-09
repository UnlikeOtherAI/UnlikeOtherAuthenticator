import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextAreaField } from '../../components/ui/FormFields';
import { createApiClient } from '../../services/api-client';

const api = createApiClient();
const Result = z.object({ resource_id: z.string(), state: z.literal('ended'),
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/), refunded_at: z.string().datetime() }).strict();
export function BillingSmsRefundVerificationForm({ resourceId, subscriptions, onVerified }: {
  resourceId: string; subscriptions: Array<{ id: string; stripe_subscription_id: string; initial_invoice_id: string | null }>;
  onVerified: () => void;
}) {
  const [subscriptionId, setSubscriptionId] = useState(subscriptions.length === 1 ? subscriptions[0]?.id ?? '' : '');
  const [ids, setIds] = useState(''); const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const refundIds = ids.trim().split(/\s+/).filter(Boolean);
  const valid = subscriptionId && refundIds.length >= 1 && refundIds.length <= 20 &&
    new Set(refundIds).size === refundIds.length && refundIds.every((id) => /^re_[a-zA-Z0-9]+$/.test(id)) &&
    reason.trim().length >= 8 && confirmed;
  const verification = useMutation({ mutationFn: async () => Result.parse(await api.post<unknown>(
    `/internal/admin/billing/sms-policies/recovery/${encodeURIComponent(resourceId)}/verify-refund`, {
      subscription_id: subscriptionId, refund_ids: refundIds, reason: reason.trim(), verify_existing_refunds: true,
    }, { cache: 'no-store' })), onSuccess: () => { onVerified(); } });
  return <form className="space-y-3 rounded-lg border border-gray-200 p-3" onSubmit={(event) => {
    event.preventDefault(); if (valid && !verification.isPending) verification.mutate();
  }}>
    <h4 className="font-semibold">Verify existing Stripe refund</h4>
    <p className="text-xs text-gray-500">First issue the refund in the authorized Stripe workflow. This action only
      reads Stripe evidence and records completion after the full original cash payment was refunded and the subscription is canceled.
      Additional paid or collectible invoices require separate reconciliation and prevent this completion.</p>
    <FieldShell label="Original paid subscription"><SelectField className="w-full" value={subscriptionId}
      onChange={(event) => setSubscriptionId(event.target.value)} disabled={verification.isPending}>
      <option value="">Select the original subscription</option>{subscriptions.map((item) =>
        <option key={item.id} value={item.id}>{item.stripe_subscription_id} · {item.initial_invoice_id ?? 'invoice unavailable'}</option>)}
    </SelectField></FieldShell>
    <FieldShell label="Existing Stripe refund IDs" hint="One re_… identifier per line, covering the complete original payment.">
      <TextAreaField value={ids} onChange={(event) => setIds(event.target.value)} rows={3} maxLength={5000} disabled={verification.isPending} />
    </FieldShell>
    <FieldShell label="Refund verification reason"><TextAreaField value={reason} onChange={(event) => setReason(event.target.value)}
      rows={2} maxLength={500} disabled={verification.isPending} /></FieldShell>
    <label className="flex items-start gap-2 text-xs text-gray-700"><input type="checkbox" checked={confirmed}
      onChange={(event) => setConfirmed(event.target.checked)} disabled={verification.isPending} />
      I selected the exact original paid subscription and existing refunds. Verify evidence and end only this resource; do not create a refund.</label>
    <Button type="submit" disabled={!valid || verification.isPending}>{verification.isPending ? 'Verifying existing refunds...' : 'Verify refund evidence'}</Button>
    {verification.isError ? <p role="alert" className="text-xs text-red-600">Refund evidence was not accepted. Check the original account, canceled subscription and complete succeeded refunds; partial, pending or additional unreviewed invoices cannot complete recovery. Reload the resource after a lost response.</p> : null}
    {verification.data ? <p role="status" className="break-all text-xs text-green-700">Verified complete original refund.
      Resource ended. SHA-256 {verification.data.evidence_digest}</p> : null}
  </form>;
}
