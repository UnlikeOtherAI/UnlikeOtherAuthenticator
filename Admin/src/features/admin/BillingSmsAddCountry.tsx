import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField } from '../../components/ui/FormFields';
import { ApiRequestError } from '../../services/api-client';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import type { SmsCountryPreview } from '../../schemas/billing-sms-policies';
import { BillingSmsCountryReview } from './BillingSmsCountryReview';
import { SMS_COUNTRIES } from './sms-countries';

/** Add country: UOA reads the configured account's prices, applies the bound rule and asks for one Accept. */
export function BillingSmsAddCountry({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const [country, setCountry] = useState('');
  const [review, setReview] = useState<SmsCountryPreview | null>(null);
  const accept = useMutation({ mutationFn: async () => {
    if (!review) throw new Error('Review required'); return service.acceptCountry(review.preview_token);
  }, onSuccess: async () => { setReview(null); await onAccepted(); } });
  const preview = useMutation({ mutationFn: service.previewCountry,
    onSuccess: (result) => { accept.reset(); setReview(result); } });
  const code = preview.error instanceof ApiRequestError ? preview.error.code : undefined;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full sm:w-72"><FieldShell label="Country to add">
        <SelectField value={country} onChange={(event) => setCountry(event.target.value)} className="w-full">
          <option value="">Choose a country</option>
          {SMS_COUNTRIES.map((entry) => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code})</option>)}
        </SelectField></FieldShell></div>
      <Button variant="primary" disabled={!country || preview.isPending} onClick={() => preview.mutate(country)}>
        {preview.isPending ? 'Reading Twilio prices...' : 'Add country'}</Button>
    </div>
    {preview.isError ? <p role="alert" className="text-sm text-red-600">{code === 'BILLING_SMS_ROUTE_RULE_UNSUPPORTED'
      ? 'Twilio prices this country in a currency the bound rule does not cover. Enter its evidence manually.'
      : 'Could not read Twilio prices for both directions of this country. Retry, or enter its evidence manually.'}</p> : null}
    {accept.data ? <p role="status" className="text-sm text-green-700">Accepted {accept.data.routes.map((route) =>
      `${route.country} ${route.direction}`).join(' and ')}.</p> : null}
    <BillingSmsCountryReview preview={review} pending={accept.isPending} error={accept.isError}
      onClose={() => setReview(null)} onAccept={() => accept.mutate()} />
  </div>;
}
