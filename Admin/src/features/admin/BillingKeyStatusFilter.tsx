import { SegmentedTabs } from '../../components/ui/Tabs';
import { useBillingNavigation } from './billing-navigation';

export type BillingKeyStatus = 'active' | 'revoked';

/** The Active · Revoked filter above a key table, kept in `key_status`; Active by default. */
export function useBillingKeyStatus(): BillingKeyStatus {
  const { params } = useBillingNavigation();
  return params.get('key_status') === 'revoked' ? 'revoked' : 'active';
}

export function BillingKeyStatusFilter({ active, pageKey, revoked }: {
  active: number;
  pageKey: string;
  revoked: number;
}) {
  const { update } = useBillingNavigation();
  const status = useBillingKeyStatus();
  return (
    <div className="px-5 pt-4">
      <SegmentedTabs
        value={status}
        onChange={(value) => update({ key_status: value === 'revoked' ? value : null, [pageKey]: null })}
        options={[
          { label: `Active (${active})`, value: 'active' },
          { label: `Revoked (${revoked})`, value: 'revoked' },
        ]}
      />
    </div>
  );
}
