import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingAssignment, BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import { useRemoveBillingAssignmentMutation } from './billing-admin-queries';
import { billingActor, billingMonthIsFuture, billingMonthStart } from './billing-format';
import { useBillingNavigation } from './billing-navigation';
import { BillingDate } from './BillingDate';

function Starts({ month }: { month: string | null }) {
  if (!month) return <>—</>;
  if (billingMonthIsFuture(month)) {
    return <span className="text-amber-600">{billingMonthStart(month)}</span>;
  }
  return <>In effect</>;
}

function byScope(a: BillingAssignment, b: BillingAssignment): number {
  return a.organisation.name.localeCompare(b.organisation.name) ||
    Number(Boolean(a.team)) - Number(Boolean(b.team)) ||
    (a.team?.name ?? '').localeCompare(b.team?.name ?? '');
}

export function BillingAssignmentsTab({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  const { confirm } = useAdminUi();
  const removeAssignment = useRemoveBillingAssignmentMutation(service.id);
  const rows = [...service.assignments].sort(byScope);
  const { pageItems, pagination } = usePagination(rows, 10, { key: 'assignments_page' });
  return (
    <>
      <DataTable headers={['Applies to', 'Tariff', 'Starts', 'Changed', '']}>
        {pageItems.map((assignment) => {
          const organisationPath = `/organisations/${encodeURIComponent(assignment.organisation.id)}`;
          return (
            <tr key={assignment.id}>
              <Td>
                <Link className="font-medium text-blue-600 hover:underline" to={organisationPath}>
                  {assignment.organisation.name}
                </Link>
                <span className="block text-xs text-gray-500">
                  {assignment.team ? (
                    <Link
                      className="text-blue-600 hover:underline"
                      to={`${organisationPath}/teams/${encodeURIComponent(assignment.team.id)}`}
                    >
                      {assignment.team.name}
                    </Link>
                  ) : (
                    'Entire organisation'
                  )}
                </span>
              </Td>
              <Td>
                <Link
                  className="font-medium text-blue-600 hover:underline"
                  to={href({ record: assignment.id })}
                >
                  {assignment.tariff.name}
                </Link>
                <code className="block text-xs text-gray-400">
                  {assignment.tariff.key} v{assignment.tariff.version}
                </code>
              </Td>
              <Td className="whitespace-nowrap"><Starts month={assignment.effective_from_month} /></Td>
              <Td className="whitespace-nowrap text-xs text-gray-500">
                <BillingDate value={assignment.updated_at} />
                <span className="block">{billingActor(assignment.created_by_email)}</span>
              </Td>
              <Td className="text-right">
                <div className="flex flex-wrap justify-end gap-2">
                  <Link
                    className="inline-flex h-8 items-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    to={`/billing?${new URLSearchParams({
                      section: 'organisations',
                      organisation: assignment.organisation.id,
                      product: service.id,
                    })}`}
                  >
                    Edit
                  </Link>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={removeAssignment.isPending}
                    onClick={() =>
                      confirm(
                        'Remove tariff assignment?',
                        'The subject falls back to the next applicable tariff next UTC month. Active Stripe subscriptions may block this change.',
                        () => removeAssignment.mutateAsync(assignment.id),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              </Td>
            </tr>
          );
        })}
        {rows.length === 0 ? (
          <tr>
            <Td colSpan={5} className="text-gray-400">
              No organisation or team has its own tariff; everyone uses the product default.
            </Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </>
  );
}
