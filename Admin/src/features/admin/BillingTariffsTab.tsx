import { useState } from 'react';
import { Link } from 'react-router';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingService, BillingTariff } from '../../schemas/billing';
import { cn } from '../../utils/cn';
import { useAdminUi } from '../shell/admin-ui';
import {
  useRestoreBillingTariffMutation,
  useRetireBillingTariffMutation,
  useSetDefaultBillingTariffMutation,
} from './billing-admin-queries';
import { billingDate, billingRefusal, billingTariffSummary } from './billing-format';
import { useBillingNavigation } from './billing-navigation';
import { BillingDate } from './BillingDate';

function byTariffOrder(a: BillingTariff, b: BillingTariff): number {
  return Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key) || b.version - a.version;
}

/** Default first, then name, key and newest version; retired versions after the active ones. */
export function orderedTariffs(tariffs: BillingTariff[], showRetired: boolean): BillingTariff[] {
  const active = tariffs.filter((tariff) => !tariff.retired_at).sort(byTariffOrder);
  const retired = tariffs.filter((tariff) => tariff.retired_at).sort(byTariffOrder);
  return showRetired ? [...active, ...retired] : active;
}

function UsedBy({ tariff, assignments, assignmentsHref }: {
  tariff: BillingTariff;
  assignments: number;
  assignmentsHref: string;
}) {
  if (tariff.retired_at) return <>Nobody</>;
  if (assignments > 0) {
    return (
      <Link className="text-blue-600 hover:underline" to={assignmentsHref}>
        {assignments} assignment{assignments === 1 ? '' : 's'}
      </Link>
    );
  }
  if (tariff.retire_blocked_by.includes('subscriptions')) return <>Active subscriptions</>;
  if (tariff.retire_blocked_by.includes('contract_terms')) return <>Active contract</>;
  if (tariff.is_default) return <>Everyone without their own tariff</>;
  return <>Nobody</>;
}

export function BillingTariffsTab({ service }: { service: BillingService }) {
  const { params, href, tabHref, update } = useBillingNavigation();
  const { confirm } = useAdminUi();
  const setDefault = useSetDefaultBillingTariffMutation(service.id);
  const retire = useRetireBillingTariffMutation(service.id);
  const restore = useRestoreBillingTariffMutation(service.id);
  const [refusal, setRefusal] = useState<string | null>(null);
  const retiredCount = service.tariffs.filter((tariff) => tariff.retired_at).length;
  const showRetired = params.get('retired') === '1' && retiredCount > 0;
  const rows = orderedTariffs(service.tariffs, showRetired);
  const { pageItems, pagination } = usePagination(rows, 10, { key: 'tariffs_page' });
  const pending = setDefault.isPending || retire.isPending || restore.isPending;

  /** Runs one change; a refusal is shown under the table in plain words. */
  async function run(change: (id: string) => Promise<unknown>, tariffId: string) {
    setRefusal(null);
    try {
      await change(tariffId);
    } catch (error) {
      setRefusal(billingRefusal(error));
    }
  }

  return (
    <>
      {retiredCount > 0 ? (
        <div className="flex justify-end px-5 pb-3">
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              checked={showRetired}
              onChange={(event) =>
                update({ retired: event.target.checked ? '1' : null, tariffs_page: null })}
            />
            Show retired ({retiredCount})
          </label>
        </div>
      ) : null}
      <DataTable headers={['Tariff', 'What customers pay', 'Used by',
        { label: 'Created', className: 'hidden md:table-cell' }, '']}>
        {pageItems.map((tariff) => {
          const retired = Boolean(tariff.retired_at);
          const assignments = service.assignments.filter(
            (assignment) => assignment.tariff_id === tariff.id,
          ).length;
          return (
            <tr key={tariff.id} className={cn(retired && 'bg-gray-50')}>
              <Td className={cn(retired && 'opacity-60')}>
                <p className="flex items-center gap-2 font-medium">
                  <Link
                    className={cn('hover:underline', retired ? 'text-gray-500' : 'text-blue-600')}
                    to={href({ record: tariff.id })}
                  >
                    {tariff.name}
                  </Link>
                  {tariff.is_default ? <Badge variant="blue">Default</Badge> : null}
                  {retired ? (
                    <Badge className="whitespace-nowrap" variant="slate">
                      Retired {billingDate(tariff.retired_at)}
                    </Badge>
                  ) : null}
                </p>
                <code className="whitespace-nowrap text-xs text-gray-400">{tariff.key} v{tariff.version}</code>
              </Td>
              <Td className={cn('min-w-56', retired && 'opacity-60')}>{billingTariffSummary(tariff)}</Td>
              <Td className={cn(retired && 'opacity-60')}>
                <UsedBy assignments={assignments} assignmentsHref={tabHref('assignments')} tariff={tariff} />
              </Td>
              <Td className={cn('hidden whitespace-nowrap md:table-cell', retired && 'opacity-60')}>
                <BillingDate value={tariff.created_at} />
              </Td>
              <Td className="text-right">
                <div className="flex justify-end gap-2 whitespace-nowrap">
                  {retired ? (
                    <Button size="sm" disabled={pending} onClick={() => void run(restore.mutateAsync, tariff.id)}>
                      Restore
                    </Button>
                  ) : null}
                  {!retired && !tariff.is_default ? (
                    <>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          confirm(
                            `Make ${tariff.name} v${tariff.version} the default?`,
                            'This becomes effective next UTC month for subjects without a team or organisation override. Active Stripe subscriptions may pin the current default.',
                            () => run(setDefault.mutateAsync, tariff.id),
                            undefined,
                            undefined,
                            'primary',
                          )
                        }
                      >
                        Set default
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending || tariff.retire_blocked_by.length > 0}
                        onClick={() =>
                          confirm(
                            `Retire ${tariff.name} · ${tariff.key} v${tariff.version}?`,
                            'Nobody can be put on this tariff any more. Its invoices, usage and history stay as they are. You can restore it later.',
                            () => run(retire.mutateAsync, tariff.id),
                          )
                        }
                      >
                        Retire
                      </Button>
                    </>
                  ) : null}
                </div>
              </Td>
            </tr>
          );
        })}
        {rows.length === 0 ? (
          <tr>
            <Td colSpan={5} className="text-gray-400">This product has no active tariff.</Td>
          </tr>
        ) : null}
      </DataTable>
      {refusal ? <p role="alert" className="px-5 py-3 text-sm text-red-600">{refusal}</p> : null}
      <PaginationFooter {...pagination} />
    </>
  );
}
