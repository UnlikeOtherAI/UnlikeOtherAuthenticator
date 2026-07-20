import { useState } from 'react';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, Td } from '../../components/ui/Table';
import { UnderlineTabs } from '../../components/ui/Tabs';
import type { BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import {
  useRemoveBillingAssignmentMutation,
  useRevokeBillingAppKeyMutation,
  useSetDefaultBillingTariffMutation,
} from './billing-admin-queries';

type BillingTab = 'tariffs' | 'assignments' | 'app-keys' | 'subscriptions';

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

function subscriptionStatus(status: string): BadgeVariant {
  if (status === 'active' || status === 'trialing') return 'green';
  if (status === 'past_due' || status === 'unpaid') return 'amber';
  if (status === 'canceled' || status === 'incomplete_expired') return 'slate';
  return 'red';
}

export function BillingServicePanel({
  onAddAppKey,
  onAddAssignment,
  onAddTariff,
  service,
}: {
  onAddAppKey: () => void;
  onAddAssignment: () => void;
  onAddTariff: () => void;
  service: BillingService;
}) {
  const [tab, setTab] = useState<BillingTab>('tariffs');
  const setDefault = useSetDefaultBillingTariffMutation(service.id);
  const removeAssignment = useRemoveBillingAssignmentMutation(service.id);
  const revokeKey = useRevokeBillingAppKeyMutation(service.id);
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
            <code className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {service.identifier}
            </code>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Team overrides organisation, which overrides the immutable service default.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon="plus" size="sm" onClick={onAddTariff}>
            Tariff version
          </Button>
          <Button icon="building" size="sm" onClick={onAddAssignment}>
            Assignment
          </Button>
          <Button icon="key" size="sm" variant="primary" onClick={onAddAppKey}>
            Product key
          </Button>
        </div>
      </CardHeader>
      <div className="px-5 pt-4">
        <UnderlineTabs
          value={tab}
          onChange={setTab}
          options={[
            { label: 'Tariffs', value: 'tariffs', count: service.tariffs.length },
            { label: 'Assignments', value: 'assignments', count: service.assignments.length },
            { label: 'App keys', value: 'app-keys', count: service.app_keys.length },
            {
              label: 'Stripe subscriptions',
              value: 'subscriptions',
              count: service.stripe_subscriptions.length,
            },
          ]}
        />
      </div>
      {tab === 'tariffs' ? (
        <DataTable
          headers={['Tariff', 'Mode', 'Collection', 'Markup', 'Monthly', 'Created', 'Default']}
        >
          {service.tariffs.map((tariff) => (
            <tr key={tariff.id}>
              <Td>
                <p className="font-medium text-gray-800">{tariff.name}</p>
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
              <Td>
                <span className="font-mono text-xs">
                  {tariff.monthly_subscription.amount_minor} {tariff.monthly_subscription.currency}
                </span>
                <span className="block text-[11px] text-gray-400">minor units</span>
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
                        'Only subjects without a team or organisation override receive this tariff. Active Stripe subscriptions may pin the current default.',
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
              <Td>{assignment.organisation.name}</Td>
              <Td>{assignment.team?.name ?? 'Entire organisation'}</Td>
              <Td>
                <p className="font-medium text-gray-700">{assignment.tariff.name}</p>
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
                      'The subject will immediately fall back to the next applicable tariff. Active Stripe subscriptions may block this change.',
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
                  <p className="font-medium text-gray-700">{key.name}</p>
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
                        key.purpose === 'entitlement'
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

      {tab === 'subscriptions' ? (
        <DataTable headers={['Subject', 'Tariff', 'Status', 'Period end', 'Stripe mode', 'Synced']}>
          {service.stripe_subscriptions.map((subscription) => (
            <tr key={subscription.id}>
              <Td>
                <p className="font-medium text-gray-700">{subscription.organisation.name}</p>
                <span className="text-xs text-gray-400">
                  {subscription.team?.name ?? 'Entire organisation'} · {subscription.scope}
                </span>
              </Td>
              <Td>
                <code className="text-xs">{subscription.tariff_id}</code>
                <span className="block text-[11px] text-gray-400">
                  {subscription.tariff_source}
                </span>
              </Td>
              <Td>
                <Badge variant={subscriptionStatus(subscription.status)}>
                  {subscription.status}
                </Badge>
                {subscription.cancel_at_period_end ? (
                  <span className="mt-1 block text-[11px] text-amber-600">
                    Cancels at period end
                  </span>
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
      ) : null}
    </Card>
  );
}
