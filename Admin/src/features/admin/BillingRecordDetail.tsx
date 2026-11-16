import { useDirectoryNavigation } from './useDirectoryNavigation';
import { Link } from 'react-router';
import { Modal } from '../../components/ui/Modal';
import type { BillingService } from '../../schemas/billing';
import { billingActor, billingDateTime, billingLabel, billingMonthStart } from './billing-format';
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
        ['Mode', billingLabel(tariff.mode)],
        ['Collection', billingLabel(tariff.collection_mode)],
        ['Markup', `${tariff.markup_bps / 100}%`],
        ['Usage payment', tariff.usage_payment_mode === 'prepaid' ? 'Prepaid pool' : 'Pay as you go'],
        ['Monthly basis', tariff.monthly_subscription.charge_basis === 'per_seat'
          ? 'Per active seat' : 'Flat per team or organisation'],
        ...(tariff.monthly_subscription.charge_basis === 'per_seat'
          ? [
              ['Seat quantity', billingLabel(tariff.monthly_subscription.seat_policy ?? '')],
              ['Seat charge timing',
                billingLabel(tariff.monthly_subscription.seat_charge_timing ?? '')],
            ] as Array<[string, string]>
          : []),
        [
          'Monthly amount',
          billingMoney(
            tariff.monthly_subscription.amount_minor,
            tariff.monthly_subscription.currency,
          ),
        ],
        ['Created', billingDateTime(tariff.created_at)],
        ['Created by', billingActor(tariff.created_by_email)],
        ...(tariff.retired_at
          ? [['Retired', billingDateTime(tariff.retired_at)]] as Array<[string, string]>
          : []),
      ]
    : key
      ? [
          ['Prefix', key.key_prefix],
          ['Purpose', billingLabel(key.purpose)],
          ['Actor issuer', key.actor_issuer],
          ['Actor audience', key.actor_audience],
          ['Signing key ID', key.actor_key_id],
          ['Return origins', key.checkout_return_origins.join(', ') || '—'],
          ['Created', billingDateTime(key.created_at)],
          ['Created by', billingActor(key.created_by_email)],
          ['Expires', billingDateTime(key.expires_at)],
          ['Last used', billingDateTime(key.last_used_at)],
          ['Revoked', billingDateTime(key.revoked_at)],
        ]
      : assignment
        ? [
            ['Scope', billingLabel(assignment.scope)],
            ['Tariff', `${assignment.tariff.name} · ${assignment.tariff.key} v${assignment.tariff.version}`],
            ['Starts', assignment.effective_from_month
              ? billingMonthStart(assignment.effective_from_month) : '—'],
            ['Created', billingDateTime(assignment.created_at)],
            ['Updated', billingDateTime(assignment.updated_at)],
            ['Created by', billingActor(assignment.created_by_email)],
          ]
        : adjustment
          ? [
              ['Key', adjustment.key],
              ['Kind', adjustment.kind === 'credit' ? 'Credit' : 'Add-on'],
              ['Cadence', billingLabel(adjustment.cadence)],
              ['Amount', billingMoney(adjustment.amount_minor, adjustment.currency)],
              ['Starts', billingDateTime(adjustment.starts_at)],
              ['Ends', billingDateTime(adjustment.ends_at)],
              ['Status', adjustment.active ? 'Active' : 'Inactive'],
              ['Created by', billingActor(adjustment.created_by_email)],
            ]
          : subscription
            ? [
                ['Status', billingLabel(subscription.status)],
                ['Mode', subscription.livemode ? 'Live' : 'Test'],
                ['Stripe account', subscription.stripe_account_id],
                ['Stripe subscription', subscription.stripe_subscription_id],
                ['Tariff source', subscription.tariff_source === 'service_default'
                  ? 'Product default' : billingLabel(subscription.tariff_source)],
                ['Period start', billingDateTime(subscription.current_period_start)],
                ['Period end', billingDateTime(subscription.current_period_end)],
                ['Cancels at period end', subscription.cancel_at_period_end ? 'Yes' : 'No'],
                ['Synced', billingDateTime(subscription.updated_at)],
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
