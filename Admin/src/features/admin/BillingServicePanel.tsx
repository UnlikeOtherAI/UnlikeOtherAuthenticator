import { Link } from 'react-router';
import { useBillingNavigation } from './billing-navigation';
import { billingMoney } from './billing-money';
import { BillingSubscriptionsTable } from './BillingSubscriptionsTable';
import { BillingSeatCapacityPanel } from './BillingSeatCapacityPanel';
import { BillingRecordDetail } from './BillingRecordDetail';
import { BillingLedgerRuntimeKeysPanel } from './BillingLedgerRuntimeKeysPanel';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, Td } from '../../components/ui/Table';
import { UnderlineTabs } from '../../components/ui/Tabs';
import type { BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import {
  useDeactivateBillingAdjustmentMutation,
  useRemoveBillingAssignmentMutation,
  useRevokeBillingAppKeyMutation,
  useSetDefaultBillingTariffMutation,
} from './billing-admin-queries';

type BillingTab = 'tariffs' | 'assignments' | 'adjustments' | 'app-keys' | 'subscriptions' | 'runtime-keys';

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function tariffMode(mode: string): string {
  return mode.replace('_', ' ');
}

function keyStatus(key: BillingService['app_keys'][number]): {
  label: string;
  variant: BadgeVariant;
} {
  if (key.revoked_at) return { label: 'Revoked', variant: 'red' };
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return { label: 'Expired', variant: 'slate' };
  }
  return { label: 'Active', variant: 'green' };
}

export function BillingServicePanel({
  onAddAppKey,
  onAddAdjustment,
  onAddAssignment,
  onAddTariff,
  service,
}: {
  onAddAppKey: () => void;
  onAddAdjustment: () => void;
  onAddAssignment: () => void;
  onAddTariff: () => void;
  service: BillingService;
}) {
  const { params, href, update } = useBillingNavigation();
  const requestedTab = params.get('tab') ?? 'tariffs';
  const tab: BillingTab = [
    'tariffs',
    'assignments',
    'adjustments',
    'app-keys',
    'subscriptions',
    'runtime-keys',
  ].includes(requestedTab)
    ? (requestedTab as BillingTab)
    : 'tariffs';
  const setDefault = useSetDefaultBillingTariffMutation(service.id);
  const removeAssignment = useRemoveBillingAssignmentMutation(service.id);
  const revokeKey = useRevokeBillingAppKeyMutation(service.id);
  const deactivateAdjustment = useDeactivateBillingAdjustmentMutation(service.id);
  const { confirm } = useAdminUi();

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{service.name}</h2>
            <Badge variant={service.active ? 'green' : 'slate'}>
              {service.active ? 'Active' : 'Inactive'}
            </Badge>
            <code className="rounded-sm bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {service.identifier}
            </code>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Team overrides organisation, which overrides the service default. Default and assignment
            changes take effect next UTC month; earlier usage keeps its effective terms.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tab === 'tariffs' ? (
            <Button icon="plus" size="sm" onClick={onAddTariff}>
              Tariff version
            </Button>
          ) : null}
          {tab === 'assignments' ? (
            <Button icon="building" size="sm" onClick={onAddAssignment}>
              Assignment
            </Button>
          ) : null}
          {tab === 'adjustments' ? (
            <Button icon="plus" size="sm" onClick={onAddAdjustment}>
              Add-on or credit
            </Button>
          ) : null}
          {tab === 'app-keys' ? (
            <Button icon="key" size="sm" variant="primary" onClick={onAddAppKey}>
              Product key
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <div className="px-5 pt-4">
        <UnderlineTabs
          value={tab}
          onChange={(value) => update({ tab: value, record: null })}
          options={[
            { label: 'Tariffs', value: 'tariffs', count: service.tariffs.length },
            { label: 'Assignments', value: 'assignments', count: service.assignments.length },
            {
              label: 'Add-ons & credits',
              value: 'adjustments',
              count: service.adjustments.length,
            },
            { label: 'App keys', value: 'app-keys', count: service.app_keys.length },
            { label: 'Ledger runtime keys', value: 'runtime-keys' },
            {
              label: 'Subscriptions',
              value: 'subscriptions',
              count: service.stripe_subscriptions.length,
            },
          ]}
        />
      </div>
      {tab === 'tariffs' ? (
        <DataTable
          headers={['Tariff', 'Mode', 'Collection', 'Markup', 'Usage', 'Monthly', 'Created', 'Default']}
        >
          {service.tariffs.map((tariff) => (
            <tr key={tariff.id}>
              <Td>
                <p className="font-medium text-gray-800">
                  <Link className="text-blue-600 hover:underline" to={href({ record: tariff.id })}>
                    {tariff.name}
                  </Link>
                </p>
                <code className="text-xs text-gray-400">
                  {tariff.key} v{tariff.version}
                </code>
              </Td>
              <Td className="capitalize">{tariffMode(tariff.mode)}</Td>
              <Td>
                <Badge
                  variant={
                    tariff.collection_mode === 'stripe'
                      ? 'purple'
                      : tariff.collection_mode === 'manual'
                        ? 'amber'
                        : 'slate'
                  }
                >
                  {tariff.collection_mode}
                </Badge>
              </Td>
              <Td>{(tariff.markup_bps / 100).toFixed(2)}%</Td>
              <Td>{tariff.usage_payment_mode === 'prepaid' ? 'Prepaid pool' : 'Pay as you go'}</Td>
              <Td>
                <span className="font-mono text-xs">
                  {billingMoney(
                    tariff.monthly_subscription.amount_minor,
                    tariff.monthly_subscription.currency,
                  )}
                </span>
                <span className="block text-xs text-gray-500">
                  {tariff.monthly_subscription.charge_basis === 'per_seat'
                    ? `per seat · ${tariff.monthly_subscription.seat_policy} · ${tariff.monthly_subscription.seat_charge_timing?.replace('_', ' ')}`
                    : 'per team or organisation'}
                </span>
              </Td>
              <Td className="text-xs text-gray-400">
                {date(tariff.created_at)}
                <span className="block">{tariff.created_by_email ?? 'system'}</span>
              </Td>
              <Td>
                {tariff.is_default ? (
                  <Badge variant="blue">Default</Badge>
                ) : (
                  <Button
                    size="sm"
                    disabled={setDefault.isPending}
                    onClick={() =>
                      confirm(
                        `Make ${tariff.name} v${tariff.version} the default?`,
                        'This becomes effective next UTC month for subjects without a team or organisation override. Active Stripe subscriptions may pin the current default.',
                        async () => {
                          await setDefault.mutateAsync(tariff.id);
                        },
                      )
                    }
                  >
                    Set default
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </DataTable>
      ) : null}

      {tab === 'assignments' ? (
        <DataTable headers={['Scope', 'Organisation', 'Team', 'Tariff', 'Updated', '']}>
          {service.assignments.map((assignment) => (
            <tr key={assignment.id}>
              <Td>
                <Badge variant={assignment.scope === 'team' ? 'purple' : 'blue'}>
                  {assignment.scope}
                </Badge>
              </Td>
              <Td>
                <Link
                  className="text-blue-600 hover:underline"
                  to={`/organisations/${encodeURIComponent(assignment.organisation.id)}`}
                >
                  {assignment.organisation.name}
                </Link>
              </Td>
              <Td>
                {assignment.team ? (
                  <Link
                    className="text-blue-600 hover:underline"
                    to={`/organisations/${encodeURIComponent(assignment.organisation.id)}/teams/${encodeURIComponent(assignment.team.id)}`}
                  >
                    {assignment.team.name}
                  </Link>
                ) : (
                  'Entire organisation'
                )}
              </Td>
              <Td>
                <p className="font-medium text-gray-700">
                  <Link
                    className="text-blue-600 hover:underline"
                    to={href({ record: assignment.id })}
                  >
                    {assignment.tariff.name}
                  </Link>
                </p>
                <code className="text-xs text-gray-400">
                  {assignment.tariff.key} v{assignment.tariff.version}
                </code>
              </Td>
              <Td className="text-xs text-gray-400">{date(assignment.updated_at)}</Td>
              <Td className="text-right">
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
              </Td>
            </tr>
          ))}
          {service.assignments.length === 0 ? (
            <tr>
              <Td colSpan={6} className="text-gray-400">
                No overrides. Every subject currently uses the service default.
              </Td>
            </tr>
          ) : null}
        </DataTable>
      ) : null}

      {tab === 'app-keys' ? (
        <DataTable
          headers={['Name', 'Prefix', 'Actor issuer / key', 'Return origins', 'Status', '']}
        >
          {service.app_keys.map((key) => {
            const status = keyStatus(key);
            return (
              <tr key={key.id}>
                <Td>
                  <p className="font-medium text-gray-700">
                    <Link className="text-blue-600 hover:underline" to={href({ record: key.id })}>
                      {key.name}
                    </Link>
                  </p>
                  <Badge
                    className="mt-1 whitespace-nowrap"
                    variant={key.purpose === 'customer_lifecycle' ? 'purple' : 'blue'}
                  >
                    {key.purpose.replace('_', ' ')}
                  </Badge>
                  <span className="mt-1 block text-xs text-gray-400">{date(key.created_at)}</span>
                </Td>
                <Td>
                  <code className="text-xs">{key.key_prefix}</code>
                </Td>
                <Td>
                  <code className="block max-w-xs truncate text-xs">{key.actor_issuer}</code>
                  <span className="text-xs text-gray-400">kid {key.actor_key_id}</span>
                </Td>
                <Td className="text-xs">
                  {key.checkout_return_origins.length > 0
                    ? key.checkout_return_origins.join(', ')
                    : 'None'}
                </Td>
                <Td>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <span className="mt-1 block text-[11px] text-gray-400">
                    last used {date(key.last_used_at)}
                  </span>
                </Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={Boolean(key.revoked_at) || revokeKey.isPending}
                    onClick={() =>
                      confirm(
                        `Revoke ${key.name}?`,
                        key.purpose === 'sms_runtime'
                          ? 'This deployment loses SMS dispatch and provider recovery access immediately. This cannot be undone.'
                          : key.purpose === 'entitlement'
                          ? 'This deployment loses effective-tariff access immediately. This cannot be undone.'
                          : 'This deployment loses Checkout, subscription, cancellation, and portal access immediately. This cannot be undone.',
                        () => revokeKey.mutateAsync(key.id),
                      )
                    }
                  >
                    Revoke
                  </Button>
                </Td>
              </tr>
            );
          })}
          {service.app_keys.length === 0 ? (
            <tr>
              <Td colSpan={6} className="text-gray-400">
                No product has been issued a billing app key.
              </Td>
            </tr>
          ) : null}
        </DataTable>
      ) : null}

      {tab === 'adjustments' ? (
        <DataTable
          headers={[
            'Scope',
            'Commercial line',
            'Kind',
            'Exact amount',
            'Effective period',
            'Status',
          ]}
        >
          {service.adjustments.map((adjustment) => (
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
                <span className="text-xs text-gray-400">
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
                  <Link
                    className="text-blue-600 hover:underline"
                    to={href({ record: adjustment.id })}
                  >
                    {adjustment.name}
                  </Link>
                </p>
                <code className="text-xs text-gray-400">{adjustment.key}</code>
              </Td>
              <Td>
                <Badge variant={adjustment.kind === 'credit' ? 'green' : 'purple'}>
                  {adjustment.kind.replace('_', '-')}
                </Badge>
                <span className="mt-1 block text-[11px] text-gray-400">
                  {adjustment.cadence.replace('_', ' ')}
                </span>
              </Td>
              <Td>
                <span className="font-mono text-xs">
                  {adjustment.kind === 'credit' ? '−' : '+'}
                  {billingMoney(adjustment.amount_minor, adjustment.currency)}
                </span>
              </Td>
              <Td className="text-xs">
                {date(adjustment.starts_at)}
                <span className="block text-[11px] text-gray-400">
                  to {date(adjustment.ends_at)}
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
              <Td colSpan={6} className="text-gray-400">
                No add-ons or credits for this product.
              </Td>
            </tr>
          ) : null}
        </DataTable>
      ) : null}

      {tab === 'subscriptions' ? <>
        <BillingSubscriptionsTable service={service} />
        <BillingSeatCapacityPanel serviceId={service.id} />
      </> : null}
      {tab === 'runtime-keys' ? (
        <BillingLedgerRuntimeKeysPanel key={service.id} service={service} />
      ) : null}
      <BillingRecordDetail service={service} />
    </Card>
  );
}
