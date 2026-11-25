import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import { RentalNumberType, SmsMonthlyPriceInputSchema, type SmsMonthlyPrice } from '../../schemas/billing-sms-policies';
import { billingDateTime } from './billing-format';

const queryKey = ['admin', 'billing', 'sms-policies', 'monthly-prices'];
const regions: Record<SmsMonthlyPrice['currency'], string> = { EUR: 'Europe', GBP: 'UK', USD: 'US' };

const labels: Record<SmsMonthlyPrice['number_type'], string> = {
  mobile: 'Mobile', local: 'Local', national: 'National', 'toll-free': 'Toll-free',
};
export function BillingSmsMonthlyPriceCard() {
  const prices = useQuery({ queryKey, queryFn: service.monthlyPrices });
  return <Card className="space-y-3 p-5"><h3 className="font-semibold text-gray-900">Monthly number prices</h3>
    <p className="text-sm text-gray-500">Set a monthly price for each number type and currency. Mobile numbers use the configured markup when provider-markup pricing is enabled.</p>
    {prices.isError ? <p role="alert" className="text-sm text-red-600">Could not load the monthly prices. Reload the page to retry.</p> : null}
    {prices.data && RentalNumberType.options.map((type) => <div key={type} className="space-y-2">
      <h4 className="font-medium">{labels[type]}</h4>
      {(['EUR', 'GBP', 'USD'] as const).map((currency) => <MonthlyPriceRow key={currency}
        type={type} currency={currency} price={prices.data.find((p) => p.currency === currency && p.number_type === type)} />)}
    </div>)}
  </Card>;
}

function MonthlyPriceRow({ price, type, currency }: { price?: SmsMonthlyPrice; type: SmsMonthlyPrice['number_type']; currency: SmsMonthlyPrice['currency'] }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({ mutationFn: service.setMonthlyPrice,
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey }); } });
  const parsed = draft === null ? null : SmsMonthlyPriceInputSchema.safeParse({ amount: draft, currency, number_type: type });
  const region = `${regions[currency]} (${currency})`;
  const label = `${labels[type]} · ${region}`;
  if (draft === null) {
    return <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
      <span className="w-28 text-sm text-gray-600">{region}</span>
      <strong className="text-gray-900">{price ? `${currency} ${price.amount}` : 'Price not set'}</strong>
      {price && <span className="text-xs text-gray-500">per number per month · {price.set_by === 'seed' ? 'initial price'
        : `set by ${price.set_by_user_id}`} · {billingDateTime(price.set_at)}</span>}
      <Button aria-label={`Edit ${label} price`} onClick={() => { save.reset(); setDraft(price?.amount ?? ''); }}>Edit</Button>
    </div>;
  }
  return <form className="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-3" onSubmit={(event) => {
    event.preventDefault(); if (parsed?.success) save.mutate(parsed.data);
  }}>
    <div className="w-40"><FieldShell label={`${label} amount`}
      error={parsed && !parsed.success ? parsed.error.issues[0]?.message : undefined}>
      <TextField value={draft} inputMode="decimal" onChange={(event) => setDraft(event.target.value)} />
    </FieldShell></div>
    <Button type="submit" variant="primary" disabled={save.isPending || !parsed?.success}>{save.isPending ? 'Saving...' : 'Save'}</Button>
    <Button disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</Button>
    {save.isError ? <p role="alert" className="w-full text-sm text-red-600">Could not save the price. Check it and retry.</p> : null}
  </form>;
}
