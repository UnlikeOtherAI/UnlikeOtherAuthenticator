import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, TextAreaField } from '../../components/ui/FormFields';
import { ApiRequestError } from '../../services/api-client';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import type { SmsFxPreview } from '../../schemas/billing-sms-policies';

/** The ECB card: one Refresh and accept, with the reviewed manual flow kept behind a disclosure. */
export function BillingSmsFxCard({ onAccepted, onReview }: {
  onAccepted: () => Promise<void>; onReview: (preview: SmsFxPreview) => void;
}) {
  const [xml, setXml] = useState('');
  const accept = useMutation({ mutationFn: () => service.refreshAcceptFx(), onSuccess: onAccepted });
  const review = useMutation({ mutationFn: service.previewFx, onSuccess: onReview });
  const code = accept.error instanceof ApiRequestError ? accept.error.code : undefined;
  return <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">Dated ECB reference rate</h3>
    <p className="text-sm text-gray-500">Refresh and accept fetches the official ECB daily USD-per-EUR document and,
      when it is within the renewal band of the last accepted rate, accepts it under your UOA subject as the
      commercial conversion. Validity stays seven days from the ECB source date; refreshing cannot extend it.</p>
    <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
      {accept.isPending ? 'Accepting...' : 'Refresh and accept'}</Button>
    {accept.data ? <p role="status" className="text-sm text-green-700">Accepted ECB {accept.data.rate_date} · USD/EUR {accept.data.usd_per_eur},
      valid until {new Date(accept.data.expires_at).toLocaleString()}.</p> : null}
    {accept.isError ? <p role="alert" className="text-sm text-red-600">{refusal(code)}</p> : null}
    <details><summary className="cursor-pointer text-sm text-blue-600">Review manually</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-gray-500">For the first rate, or a rate outside the band: review its date, hash and
          expiry, then accept it with your own reason.</p>
        <Button disabled={review.isPending} onClick={() => review.mutate(undefined)}>
          {review.isPending ? 'Fetching evidence...' : 'Refresh ECB evidence'}</Button>
        <FieldShell label="ECB daily XML">
          <TextAreaField value={xml} onChange={(event) => setXml(event.target.value)} maxLength={100_000} rows={5} />
        </FieldShell>
        <Button disabled={!xml.trim() || review.isPending} onClick={() => review.mutate(xml)}>Review imported ECB evidence</Button>
        {review.isError ? <p role="alert" className="text-sm text-red-600">Could not validate fresh ECB evidence. Retry refresh or import a current source document.</p> : null}
      </div></details>
  </Card>;
}

function refusal(code?: string): string {
  if (code === 'BILLING_SMS_FX_OUTSIDE_BAND') {
    return 'The new ECB rate is outside the renewal band of the last accepted rate, so it was not accepted. Review it manually.';
  }
  if (code === 'BILLING_SMS_FX_BASELINE_REQUIRED') return 'No ECB rate has been accepted yet. Review and accept the first one manually.';
  return 'Could not fetch or accept fresh ECB evidence. Retry, or review it manually.';
}
