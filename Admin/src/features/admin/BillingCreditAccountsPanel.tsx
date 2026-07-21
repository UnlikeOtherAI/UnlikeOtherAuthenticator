import { useMemo, useState } from 'react';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import type { BillingCreditAccount, BillingCreditAdjustment } from '../../schemas/billing-credits';
import { useBillingCreditAccountsQuery } from './billing-admin-queries';
import { BillingCreditAdjustmentDialog } from './BillingCreditAdjustmentDialog';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

type AdjustmentRow = {
  account: BillingCreditAccount;
  adjustment: BillingCreditAdjustment;
};

export function BillingCreditAccountsPanel() {
  const accountsQuery = useBillingCreditAccountsQuery();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const [selectedAccount, setSelectedAccount] = useState<BillingCreditAccount | null>(null);
  const adjustments = useMemo(
    () =>
      accounts
        .flatMap((account) =>
          account.recent_adjustments.map((adjustment) => ({ account, adjustment })),
        )
        .sort(
          (left, right) =>
            new Date(right.adjustment.created_at).getTime() -
            new Date(left.adjustment.created_at).getTime(),
        ),
    [accounts],
  );

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
        UOA owns each team&apos;s shared credit balance and immutable funding history. 1,000 credits
        = US$1.00. Product services consume this same balance through UOA.
      </div>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Team credit accounts</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Remaining customer-facing credits for each exact organisation and team.
            </p>
          </div>
          <Badge variant="blue">{accounts.length} accounts</Badge>
        </CardHeader>

        {accountsQuery.isLoading ? (
          <p className="px-5 py-8 text-sm text-gray-400">Loading team credit accounts...</p>
        ) : null}
        {accountsQuery.isError ? (
          <p className="px-5 py-8 text-sm text-red-600">Could not load team credit accounts.</p>
        ) : null}
        {!accountsQuery.isLoading && !accountsQuery.isError && accounts.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-gray-800">No team credit accounts yet</p>
            <p className="mt-1 text-sm text-gray-500">
              An account appears after a team first enters the UOA funding lifecycle.
            </p>
          </div>
        ) : null}
        {accounts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Organisation / team</th>
                  <th className="px-4 py-3 font-medium">Remaining credits</th>
                  <th className="px-4 py-3 font-medium">USD equivalent</th>
                  <th className="px-4 py-3 font-medium">Mode</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td className="px-5 py-4">
                      <p className="font-medium text-gray-900">{account.team.name}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{account.organisation.name}</p>
                    </td>
                    <td className="px-4 py-4 font-semibold text-gray-900">
                      {account.remaining_credits.display}
                    </td>
                    <td className="px-4 py-4 text-gray-600">
                      {account.remaining_credits.usd_equivalent.display}
                    </td>
                    <td className="px-4 py-4">
                      <Badge variant={account.mode === 'live' ? 'green' : 'amber'}>
                        {account.mode === 'live' ? 'Live' : 'Test'}
                      </Badge>
                    </td>
                    <td className="px-4 py-4 text-xs text-gray-500">
                      {formatDate(account.updated_at)}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Button size="sm" onClick={() => setSelectedAccount(account)}>
                        Adjust
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Recent adjustments</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Append-only superuser entries with their operator and request reference.
            </p>
          </div>
        </CardHeader>
        {adjustments.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-500">No credit adjustments have been posted.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Posted</th>
                  <th className="px-4 py-3 font-medium">Organisation / team</th>
                  <th className="px-4 py-3 font-medium">Credit change</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-5 py-3 font-medium">Audit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adjustments.map(({ account, adjustment }: AdjustmentRow) => (
                  <tr key={adjustment.id}>
                    <td className="whitespace-nowrap px-5 py-4 text-xs text-gray-500">
                      {formatDate(adjustment.created_at)}
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-medium text-gray-900">{account.team.name}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{account.organisation.name}</p>
                    </td>
                    <td className="px-4 py-4">
                      <p
                        className={
                          adjustment.signed_credits.credits.startsWith('-')
                            ? 'font-semibold text-red-700'
                            : 'font-semibold text-green-700'
                        }
                      >
                        {adjustment.signed_credits.display}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {adjustment.signed_credits.usd_equivalent.display} equivalent
                      </p>
                    </td>
                    <td className="max-w-sm px-4 py-4 text-gray-700">{adjustment.reason}</td>
                    <td className="px-5 py-4">
                      <p className="text-xs text-gray-700">{adjustment.created_by.email}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-gray-400">
                        {adjustment.idempotency_key}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedAccount ? (
        <BillingCreditAdjustmentDialog
          account={selectedAccount}
          open
          onClose={() => setSelectedAccount(null)}
        />
      ) : null}
    </div>
  );
}
