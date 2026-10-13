import { useState } from 'react';
import type { BillingService } from '../../schemas/billing';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField } from '../../components/ui/FormFields';
import { billingMoney } from './billing-money';
import { useSeatOffers, usePublishSeatOffer, useWithdrawSeatOffer } from './billing-commercial-queries';

export function BillingSeatOffersPanel({ service }: { service: BillingService }) {
  const [selected, setSelected] = useState('');
  const list = useSeatOffers(service.id), publish = usePublishSeatOffer(service.id), withdraw = useWithdrawSeatOffer(service.id);
  const tariffs = service.tariffs.filter((row) => row.mode === 'standard' && row.usage_currency === 'USD');
  return <section className="space-y-3 border-t border-gray-200 pt-4">
    <h3 className="font-semibold text-gray-900">Public Standard seat plans</h3>
    <p className="text-sm text-gray-500">Publish an immutable automatic, prorated, prepaid Standard tariff: EUR 2.99, GBP 2.99 or USD 3.99 per human monthly, with separate USD usage valuation and 30% markup. Publishing does not assign companies or change defaults.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={async (event) => {
      event.preventDefault(); try { await publish.mutateAsync(selected); } catch { /* Retain selection for correction. */ }
    }}>
      <FieldShell label="Immutable Standard tariff"><SelectField value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Select a tariff version</option>
        {tariffs.map((row) => <option key={row.id} value={row.id}>{row.name} v{row.version} · {billingMoney(row.monthly_subscription.amount_minor, row.monthly_subscription.currency)}</option>)}
      </SelectField></FieldShell>
      <Button type="submit" disabled={!selected || publish.isPending}>Publish Standard plan</Button>
    </form>
    {publish.isError ? <p role="alert" className="text-sm text-red-600">Publication failed. Verify the exact Standard seat price, automatic/prorated policy, prepaid USD usage and 30% markup.</p> : null}
    {withdraw.isError ? <p role="alert" className="text-sm text-red-600">Withdrawal failed. Retry.</p> : null}
    {list.isError ? <p role="alert">Could not load published plans. <Button onClick={() => void list.refetch()}>Retry</Button></p> : null}
    <ul className="space-y-3">
      {(list.data ?? []).map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-3">
        <dl className="flex flex-wrap gap-6 text-sm">
          <div><dt className="text-gray-500">Monthly seat price</dt><dd>{billingMoney(row.unit_amount_minor, row.currency)}</dd></div>
          <div><dt className="text-gray-500">Usage currency</dt><dd>{row.usage_currency}</dd></div>
          <div><dt className="text-gray-500">Published</dt><dd>{new Date(row.published_at).toLocaleString()}</dd></div>
        </dl>
        {row.withdrawn_at ? <span>Withdrawn</span> : <Button disabled={withdraw.isPending}
          onClick={() => void withdraw.mutateAsync(row.id).catch(() => undefined)}>Withdraw new purchases</Button>}
      </li>)}
    </ul>
    {list.data?.length === 0 ? <p className="text-sm text-gray-500">No public Standard plans. Create compatible immutable tariff versions on the Tariffs tab, then publish them here.</p> : null}
    <p className="text-sm text-gray-500">Withdrawal stops new selections; accepted agreements and completed purchases keep their frozen terms.</p>
  </section>;
}
