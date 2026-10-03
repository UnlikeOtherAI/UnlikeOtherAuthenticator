import { useDirectoryNavigation } from './useDirectoryNavigation';
import { Link } from 'react-router';
import { Modal } from '../../components/ui/Modal';
import type { BillingService } from '../../schemas/billing';
import { billingMoney } from './billing-money';
import { useBillingNavigation } from './billing-navigation';

export function BillingRecordDetail({ service }: { service: BillingService }) {
  const { recordState } = useDirectoryNavigation('/billing');
  const { params, href, update } = useBillingNavigation();
  const id = params.get('record');
  if (!id) return null;
  const tariff = service.tariffs.find((entry) => entry.id === id);
  const key = service.app_keys.find((entry) => entry.id === id);
  const assignment = service.assignments.find((entry) => entry.id === id);
  const adjustment = service.adjustments.find((entry) => entry.id === id);
  const subscription = service.stripe_subscriptions.find((entry) => entry.id === id);
  const subject = assignment ?? adjustment ?? subscription;
  const title =
    tariff?.name ??
    key?.name ??
    adjustment?.name ??
    (assignment
      ? 'Tariff assignment'
      : subscription
        ? 'Stripe subscription'
        : 'Record unavailable');
  const fields: Array<[string, string | number | null]> = tariff
    ? [
        ['Key', tariff.key],
        ['Version', tariff.version],
        ['Mode', tariff.mode.replaceAll('_', ' ')],
        ['Collection', tariff.collection_mode],
        ['Markup', `${tariff.markup_bps / 100}%`],
        [
          'Monthly amount',
          billingMoney(
            tariff.monthly_subscription.amount_minor,
            tariff.monthly_subscription.currency,
          ),
        ],
        ['Created', tariff.created_at],
        ['Created by', tariff.created_by_email],
      ]
    : key
      ? [
          ['Prefix', key.key_prefix],
          ['Purpose', key.purpose.replaceAll('_', ' ')],
          ['Actor issuer', key.actor_issuer],
          ['Actor audience', key.actor_audience],
          ['Signing key ID', key.actor_key_id],
          ['Return origins', key.checkout_return_origins.join(', ') || 'None'],
          ['Created', key.created_at],
          ['Created by', key.created_by_email],
          ['Expires', key.expires_at],
          ['Last used', key.last_used_at],
          ['Revoked', key.revoked_at],
        ]
      : assignment
        ? [
            ['Scope', assignment.scope],
            ['Tariff', `${assignment.tariff.name} v${assignment.tariff.version}`],
            ['Created', assignment.created_at],
            ['Updated', assignment.updated_at],
            ['Created by', assignment.created_by_email],
          ]
        : adjustment
          ? [
              ['Key', adjustment.key],
              ['Kind', adjustment.kind.replaceAll('_', ' ')],
              ['Cadence', adjustment.cadence.replaceAll('_', ' ')],
              ['Amount', billingMoney(adjustment.amount_minor, adjustment.currency)],
              ['Starts', adjustment.starts_at],
              ['Ends', adjustment.ends_at],
              ['Status', adjustment.active ? 'Active' : 'Inactive'],
              ['Created by', adjustment.created_by_email],
            ]
          : subscription
            ? [
                ['Status', subscription.status],
                ['Mode', subscription.livemode ? 'Live' : 'Test'],
                ['Stripe account', subscription.stripe_account_id],
                ['Stripe subscription', subscription.stripe_subscription_id],
                ['Tariff source', subscription.tariff_source.replaceAll('_', ' ')],
                ['Period start', subscription.current_period_start],
                ['Period end', subscription.current_period_end],
                ['Cancels at period end', subscription.cancel_at_period_end ? 'Yes' : 'No'],
                ['Synced', subscription.updated_at],
              ]
            : [];
  return (
    <Modal isOpen title={title} onClose={() => update({ record: null })}>
      {subject ? (
        <p className="mb-4 flex flex-wrap gap-2 text-sm">
          <Link
            className="text-blue-600 hover:underline"
            state={recordState}
            to={`/organisations/${encodeURIComponent(subject.organisation.id)}`}
          >
            {subject.organisation.name}
          </Link>
          {subject.team ? (
            <Link
              className="text-blue-600 hover:underline"
              state={recordState}
              to={`/organisations/${encodeURIComponent(subject.organisation.id)}/teams/${encodeURIComponent(subject.team.id)}`}
            >
              {subject.team.name}
            </Link>
          ) : (
            <span>Entire organisation</span>
          )}
        </p>
      ) : null}
      {assignment ? (
        <Link
          className="mb-4 block text-sm text-blue-600 hover:underline"
          to={href({ tab: 'tariffs', record: assignment.tariff.id })}
        >
          View tariff
        </Link>
      ) : null}
      {subscription ? (
        <Link
          className="mb-4 block text-sm text-blue-600 hover:underline"
          to={href({ tab: 'tariffs', record: subscription.tariff_id })}
        >
          View tariff
        </Link>
      ) : null}
      <dl className="space-y-3 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="grid gap-1 sm:grid-cols-3">
            <dt className="text-gray-500">{label}</dt>
            <dd className="break-words font-medium text-gray-900 sm:col-span-2">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {!fields.length ? (
        <p className="text-sm text-gray-500">
          This record is no longer available for this product.
        </p>
      ) : null}
    </Modal>
  );
}
