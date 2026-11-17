import { useState } from 'react';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingCreditAmount } from '../../schemas/billing-credit-grants';
import { BillingCreditGrantDialog } from './BillingCreditGrantDialog';
import { BillingDate } from './BillingDate';
import { billingActor } from './billing-format';
import { useBillingCreditGrants } from './billing-credit-grant-queries';
import { creditGrantCredits, creditGrantUsd } from './billing-credit-grant-format';

function Figure({ label, amount }: { label: string; amount: BillingCreditAmount }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-semibold text-gray-900">{creditGrantCredits(amount)}</p>
      <p className="text-xs text-gray-500">{creditGrantUsd(amount)}</p>
    </div>
  );
}

/** The organisation's prepaid wallet in its current mode, the grants made to it, and the way to make one. */
export function OrganisationCreditGrantsPanel({ organisationId }: { organisationId: string }) {
  const query = useBillingCreditGrants(organisationId);
  const [open, setOpen] = useState(false);
  const data = query.data;
  const { pageItems, pagination } = usePagination(data?.grants ?? [], 10, { key: 'credit_grants_page' });
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Prepaid credits</h2>
          {data ? <Badge variant={data.mode === 'sandbox' ? 'amber' : 'green'}>
            {data.mode === 'sandbox' ? 'Sandbox billing' : 'Live billing'}</Badge> : null}
        </div>
        <Button icon="plus" variant="primary" size="sm" disabled={!data} onClick={() => setOpen(true)}>
          Grant credits
        </Button>
      </CardHeader>
      <div className="space-y-4 p-5">
        <p className="max-w-2xl text-sm text-gray-600">
          The organisation&apos;s shared wallet. Prepaid usage in every product and team spends from it. Granting
          credits adds to it without a payment.
        </p>
        {query.isLoading ? <p className="text-sm text-gray-500">Loading credits…</p> : null}
        {query.isError ? <div role="alert" className="text-sm text-red-600">Could not load credits.{' '}
          <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></div> : null}
        {data ? (
          <div className="grid max-w-xl grid-cols-3 gap-4">
            <Figure label="Balance" amount={data.balance.confirmed} />
            <Figure label="Held for work in progress" amount={data.balance.reserved} />
            <Figure label="Spendable now" amount={data.balance.spendable} />
          </div>
        ) : null}
      </div>
      {data ? (
        <>
          <DataTable headers={['Granted', 'Credits', 'Reason', { label: 'By', className: 'hidden md:table-cell' },
            { label: 'Mode', className: 'hidden md:table-cell' }]}>
            {pageItems.length === 0 ? (
              <tr><Td colSpan={5} className="text-gray-400">No credits have been granted to this organisation.</Td></tr>
            ) : pageItems.map((grant) => (
              <tr key={grant.id}>
                <Td><BillingDate value={grant.granted_at} /></Td>
                <Td className="whitespace-nowrap">{creditGrantCredits(grant.amount)}
                  <span className="block text-xs text-gray-500">{creditGrantUsd(grant.amount)}</span></Td>
                <Td className="max-w-md break-words">{grant.reason}</Td>
                <Td className="hidden md:table-cell">{billingActor(grant.granted_by)}</Td>
                <Td className="hidden md:table-cell">{grant.mode === 'sandbox' ? 'Sandbox' : 'Live'}</Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...pagination} />
          {data.has_more ? <p className="px-5 pb-4 text-xs text-gray-500">Showing the latest 50 grants.</p> : null}
          <BillingCreditGrantDialog data={data} open={open} onClose={() => setOpen(false)} />
        </>
      ) : null}
    </Card>
  );
}
