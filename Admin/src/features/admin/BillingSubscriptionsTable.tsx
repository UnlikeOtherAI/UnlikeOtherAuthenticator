import { Link } from 'react-router';
import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { DataTable, Td } from '../../components/ui/Table';
import type { BillingService } from '../../schemas/billing';
import { useBillingNavigation } from './billing-navigation';

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '�';
}

function subscriptionStatus(status: string): BadgeVariant {
  if (status === 'active' || status === 'trialing') return 'green';
  if (status === 'past_due' || status === 'unpaid') return 'amber';
  if (status === 'canceled' || status === 'incomplete_expired') return 'slate';
  return 'red';
}

export function BillingSubscriptionsTable({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  return (
    <DataTable headers={['Subject', 'Tariff', 'Status', 'Period end', 'Stripe mode', 'Synced']}>
      {service.stripe_subscriptions.map((subscription) => (
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
            <span className="text-xs text-gray-400">
              {subscription.team ? (
                <Link
                  className="text-blue-600 hover:underline"
                  to={`/organisations/${encodeURIComponent(subscription.organisation.id)}/teams/${encodeURIComponent(subscription.team.id)}`}
                >
                  {subscription.team.name}
                </Link>
              ) : (
                'Entire organisation'
              )}{' '}
              · {subscription.scope}
            </span>
          </Td>
          <Td>
            <Link className="text-blue-600 hover:underline" to={href({ record: subscription.id })}>
              {service.tariffs.find((tariff) => tariff.id === subscription.tariff_id)?.name ??
                subscription.tariff_id}
            </Link>
            <span className="block text-[11px] text-gray-400">{subscription.tariff_source}</span>
          </Td>
          <Td>
            <Badge variant={subscriptionStatus(subscription.status)}>{subscription.status}</Badge>
            {subscription.cancel_at_period_end ? (
              <span className="mt-1 block text-[11px] text-amber-600">Cancels at period end</span>
            ) : null}
          </Td>
          <Td className="text-xs">{date(subscription.current_period_end)}</Td>
          <Td>
            <Badge variant={subscription.livemode ? 'red' : 'blue'}>
              {subscription.livemode ? 'Live' : 'Test'}
            </Badge>
            <code className="mt-1 block text-[11px] text-gray-400">
              {subscription.stripe_account_id}
            </code>
          </Td>
          <Td className="text-xs text-gray-400">{date(subscription.updated_at)}</Td>
        </tr>
      ))}
      {service.stripe_subscriptions.length === 0 ? (
        <tr>
          <Td colSpan={6} className="text-gray-400">
            No Stripe subscription projections for this service.
          </Td>
        </tr>
      ) : null}
    </DataTable>
  );
}
