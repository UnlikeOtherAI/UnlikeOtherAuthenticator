import { Link } from 'react-router';
import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingService } from '../../schemas/billing';
import { billingLabel } from './billing-format';
import { useBillingNavigation } from './billing-navigation';
import { BillingDate } from './BillingDate';

function subscriptionStatus(status: string): BadgeVariant {
  if (status === 'active' || status === 'trialing') return 'green';
  if (status === 'past_due' || status === 'unpaid') return 'amber';
  if (status === 'canceled' || status === 'incomplete_expired') return 'slate';
  return 'red';
}

export function BillingSubscriptionsTable({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  const { pageItems, pagination } = usePagination(service.stripe_subscriptions, 10, {
    key: 'subscriptions_page',
  });
  return (
    <section className="space-y-2">
      <h3 className="px-5 text-sm font-semibold text-gray-900">Stripe subscriptions</h3>
      <DataTable headers={['Subject', 'Tariff', 'Status', 'Period end', 'Mode', 'Synced']}>
        {pageItems.map((subscription) => (
          <tr key={subscription.id}>
            <Td>
              <p className="font-medium text-gray-700">
                <Link
                  className="text-blue-600 hover:underline"
                  to={`/organisations/${encodeURIComponent(subscription.organisation.id)}`}
                >
                  {subscription.organisation.name}
                </Link>
              </p>
              <span className="text-xs text-gray-500">
                {subscription.team ? (
                  <Link
                    className="text-blue-600 hover:underline"
                    to={`/organisations/${encodeURIComponent(subscription.organisation.id)}/teams/${encodeURIComponent(subscription.team.id)}`}
                  >
                    {subscription.team.name}
                  </Link>
                ) : (
                  'Entire organisation'
                )}
              </span>
            </Td>
            <Td>
              <Link className="text-blue-600 hover:underline" to={href({ record: subscription.id })}>
                {service.tariffs.find((tariff) => tariff.id === subscription.tariff_id)?.name ??
                  subscription.tariff_id}
              </Link>
              <span className="block text-xs text-gray-500">
                {subscription.tariff_source === 'service_default'
                  ? 'Product default'
                  : `${billingLabel(subscription.tariff_source)} tariff`}
              </span>
            </Td>
            <Td>
              <Badge variant={subscriptionStatus(subscription.status)}>
                {billingLabel(subscription.status)}
              </Badge>
              {subscription.cancel_at_period_end ? (
                <span className="mt-1 block text-xs text-amber-600">Cancels at period end</span>
              ) : null}
            </Td>
            <Td className="whitespace-nowrap text-xs">
              <BillingDate value={subscription.current_period_end} />
            </Td>
            <Td>
              <Badge variant={subscription.livemode ? 'red' : 'blue'}>
                {subscription.livemode ? 'Live' : 'Test'}
              </Badge>
              <code className="mt-1 block text-xs text-gray-500">{subscription.stripe_account_id}</code>
            </Td>
            <Td className="whitespace-nowrap text-xs text-gray-500">
              <BillingDate value={subscription.updated_at} />
            </Td>
          </tr>
        ))}
        {service.stripe_subscriptions.length === 0 ? (
          <tr>
            <Td colSpan={6} className="text-gray-400">This product has no Stripe subscription.</Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </section>
  );
}
