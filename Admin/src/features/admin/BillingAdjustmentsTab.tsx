import { Link } from 'react-router';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import { useDeactivateBillingAdjustmentMutation } from './billing-admin-queries';
import { billingLabel } from './billing-format';
import { billingMoney } from './billing-money';
import { useBillingNavigation } from './billing-navigation';
import { BillingDate } from './BillingDate';

export function BillingAdjustmentsTab({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  const { confirm } = useAdminUi();
  const deactivateAdjustment = useDeactivateBillingAdjustmentMutation(service.id);
  const { pageItems, pagination } = usePagination(service.adjustments, 10, { key: 'adjustments_page' });
  return (
    <>
      <DataTable
        headers={['Scope', 'Commercial line', 'Kind', 'Exact amount', 'Effective period', 'Status']}
      >
        {pageItems.map((adjustment) => (
          <tr key={adjustment.id}>
            <Td>
              <p className="font-medium text-gray-700">
                <Link
                  className="text-blue-600 hover:underline"
                  to={`/organisations/${encodeURIComponent(adjustment.organisation.id)}`}
                >
                  {adjustment.organisation.name}
                </Link>
              </p>
              <span className="text-xs text-gray-500">
                {adjustment.team ? (
                  <Link
                    className="text-blue-600 hover:underline"
                    to={`/organisations/${encodeURIComponent(adjustment.organisation.id)}/teams/${encodeURIComponent(adjustment.team.id)}`}
                  >
                    {adjustment.team.name}
                  </Link>
                ) : (
                  'Entire organisation'
                )}
              </span>
            </Td>
            <Td>
              <p className="font-medium text-gray-700">
                <Link className="text-blue-600 hover:underline" to={href({ record: adjustment.id })}>
                  {adjustment.name}
                </Link>
              </p>
              <code className="text-xs text-gray-400">{adjustment.key}</code>
            </Td>
            <Td>
              <Badge variant={adjustment.kind === 'credit' ? 'green' : 'purple'}>
                {adjustment.kind === 'credit' ? 'Credit' : 'Add-on'}
              </Badge>
              <span className="mt-1 block text-xs text-gray-500">{billingLabel(adjustment.cadence)}</span>
            </Td>
            <Td>
              <span className="font-mono text-xs">
                {adjustment.kind === 'credit' ? '−' : '+'}
                {billingMoney(adjustment.amount_minor, adjustment.currency)}
              </span>
            </Td>
            <Td className="whitespace-nowrap text-xs">
              <BillingDate value={adjustment.starts_at} />
              <span className="block text-gray-500">
                to <BillingDate value={adjustment.ends_at} />
              </span>
            </Td>
            <Td>
              <Badge variant={adjustment.active ? 'blue' : 'slate'}>
                {adjustment.active ? 'Active' : 'Inactive'}
              </Badge>
              {adjustment.active ? (
                <Button
                  className="mt-2"
                  size="sm"
                  variant="danger"
                  disabled={deactivateAdjustment.isPending}
                  onClick={() =>
                    confirm(
                      `Deactivate ${adjustment.name}?`,
                      'Future statements will omit this line. Existing pinned statements remain unchanged.',
                      () => deactivateAdjustment.mutateAsync(adjustment.id),
                    )
                  }
                >
                  Deactivate
                </Button>
              ) : null}
            </Td>
          </tr>
        ))}
        {service.adjustments.length === 0 ? (
          <tr>
            <Td colSpan={6} className="text-gray-400">This product has no add-ons or credits.</Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </>
  );
}
