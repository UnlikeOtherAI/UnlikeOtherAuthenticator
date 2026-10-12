import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import { SmsMonthlyPriceInputSchema, type SmsMonthlyPriceInput } from '../../schemas/billing-sms-policies';

const queryKey = ['admin', 'billing', 'sms-policies', 'monthly-price'];

/** The one flat monthly number price, shown as a value with Edit. */
export function BillingSmsMonthlyPriceCard() {
  const client = useQueryClient();
  const price = useQuery({ queryKey, queryFn: service.monthlyPrice });
  const [draft, setDraft] = useState<SmsMonthlyPriceInput | null>(null);
  const save = useMutation({ mutationFn: service.setMonthlyPrice,
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey }); } });
  const invalid = draft ? SmsMonthlyPriceInputSchema.safeParse(draft) : null;
  return <Card className="space-y-3 p-5"><h3 className="font-semibold text-gray-900">Monthly number price</h3>
    <p className="text-sm text-gray-500">Every mobile number costs this flat amount per month, in every country.
      A country whose Twilio rental reaches it at the accepted ECB rate is not offered. Changing it applies to new
      quotes only; numbers already paid for keep their price.</p>
    {price.isError ? <p role="alert" className="text-sm text-red-600">Could not load the monthly price. Reload the page to retry.</p> : null}
    {price.data && !draft ? <div className="flex flex-wrap items-center gap-3">
      <strong className="text-lg text-gray-900">{price.data.currency} {price.data.amount}</strong>
      <span className="text-xs text-gray-500">per number per month · {price.data.set_by === 'seed' ? 'initial price'
        : `set by ${price.data.set_by_user_id}`} · {new Date(price.data.set_at).toLocaleString()}</span>
      <Button onClick={() => { save.reset(); setDraft({ amount: price.data.amount, currency: price.data.currency }); }}>Edit</Button>
    </div> : null}
    {draft ? <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); if (invalid?.success) save.mutate(invalid.data);
    }}>
      <div className="w-32"><FieldShell label="Amount" error={invalid && !invalid.success ? invalid.error.issues[0]?.message : undefined}>
        <TextField value={draft.amount} inputMode="decimal" onChange={(event) => setDraft({ ...draft, amount: event.target.value })} />
      </FieldShell></div>
      <div className="w-28"><FieldShell label="Currency">
        <SelectField value={draft.currency} className="w-full"
          onChange={(event) => setDraft({ ...draft, currency: event.target.value as SmsMonthlyPriceInput['currency'] })}>
          <option value="EUR">EUR</option><option value="USD">USD</option>
        </SelectField></FieldShell></div>
      <Button type="submit" variant="primary" disabled={save.isPending || !invalid?.success}>{save.isPending ? 'Saving...' : 'Save'}</Button>
      <Button disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</Button>
    </form> : null}
    {save.isError ? <p role="alert" className="text-sm text-red-600">Could not save the price. Check it and retry.</p> : null}
  </Card>;
}
