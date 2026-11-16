import { Link } from 'react-router';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import type { BillingAppKey, BillingService } from '../../schemas/billing';
import { useAdminUi } from '../shell/admin-ui';
import { useRevokeBillingAppKeyMutation } from './billing-admin-queries';
import { billingDate, billingLabel } from './billing-format';
import { useBillingNavigation } from './billing-navigation';
import { BillingDate } from './BillingDate';
import { BillingKeyStatusFilter, useBillingKeyStatus } from './BillingKeyStatusFilter';

function keyStatus(key: BillingAppKey): { label: string; variant: BadgeVariant } {
  if (key.revoked_at) return { label: 'Revoked', variant: 'red' };
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return { label: 'Expired', variant: 'slate' };
  }
  return { label: 'Active', variant: 'green' };
}

/** Expired keys count as revoked: neither can authenticate any more. */
export function billingAppKeyIsActive(key: BillingAppKey): boolean {
  return keyStatus(key).label === 'Active';
}

function revokeConsequence(purpose: BillingAppKey['purpose']): string {
  if (purpose === 'browser_runtime') {
    return 'This deployment loses cloud browser admission and usage settlement immediately. Replace the runtime key before revoking it while charges are pending.';
  }
  if (purpose === 'voice_runtime') {
    return 'This deployment loses Voice call admission and settlement access immediately. This cannot be undone.';
  }
  if (purpose === 'sms_runtime') {
    return 'This deployment loses SMS dispatch and provider recovery access immediately. This cannot be undone.';
  }
  if (purpose === 'entitlement') {
    return 'This deployment loses effective-tariff access immediately. This cannot be undone.';
  }
  return 'This deployment loses Checkout, subscription, cancellation, and portal access immediately. This cannot be undone.';
}

export function BillingAppKeysTab({ service }: { service: BillingService }) {
  const { href } = useBillingNavigation();
  const { confirm } = useAdminUi();
  const revokeKey = useRevokeBillingAppKeyMutation(service.id);
  const status = useBillingKeyStatus();
  const active = service.app_keys.filter(billingAppKeyIsActive);
  const revoked = service.app_keys.filter((key) => !billingAppKeyIsActive(key));
  const rows = status === 'active' ? active : revoked;
  const { pageItems, pagination } = usePagination(rows, 10, { key: 'app_keys_page' });
  return (
    <>
      <BillingKeyStatusFilter active={active.length} revoked={revoked.length} pageKey="app_keys_page" />
      <DataTable headers={['Name', 'Prefix', 'Actor issuer / key', 'Return origins', 'Status', '']}>
        {pageItems.map((key) => {
          const keyState = keyStatus(key);
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
                  {billingLabel(key.purpose)}
                </Badge>
                <span className="mt-1 block text-xs text-gray-500">
                  <BillingDate value={key.created_at} />
                </span>
              </Td>
              <Td>
                <code className="text-xs">{key.key_prefix}</code>
              </Td>
              <Td>
                <code className="block max-w-xs truncate text-xs">{key.actor_issuer}</code>
                <span className="text-xs text-gray-500">kid {key.actor_key_id}</span>
              </Td>
              <Td className="text-xs">
                {key.checkout_return_origins.length > 0 ? key.checkout_return_origins.join(', ') : '—'}
              </Td>
              <Td>
                <Badge variant={keyState.variant}>{keyState.label}</Badge>
                <span className="mt-1 block whitespace-nowrap text-xs text-gray-500">
                  {key.last_used_at ? `Last used ${billingDate(key.last_used_at)}` : 'Never used'}
                </span>
              </Td>
              <Td className="text-right">
                {key.revoked_at ? null : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={revokeKey.isPending}
                    onClick={() =>
                      confirm(`Revoke ${key.name}?`, revokeConsequence(key.purpose),
                        () => revokeKey.mutateAsync(key.id))
                    }
                  >
                    Revoke
                  </Button>
                )}
              </Td>
            </tr>
          );
        })}
        {rows.length === 0 ? (
          <tr>
            <Td colSpan={6} className="text-gray-400">
              {status === 'active'
                ? 'This product has no active app key.'
                : 'No app key of this product has been revoked or has expired.'}
            </Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </>
  );
}
