import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { UnderlineTabs } from '../../components/ui/Tabs';
import type { BillingService } from '../../schemas/billing';
import { useBillingLedgerRuntimeKeysQuery } from './billing-ledger-runtime-key-queries';
import { useBillingNavigation } from './billing-navigation';
import { BillingAdjustmentsTab } from './BillingAdjustmentsTab';
import { BillingAppKeysTab, billingAppKeyIsActive } from './BillingAppKeysTab';
import { BillingAssignmentsTab } from './BillingAssignmentsTab';
import { BillingBrowserPolicyPanel } from './BillingBrowserPolicyPanel';
import { BillingLedgerRuntimeKeysPanel } from './BillingLedgerRuntimeKeysPanel';
import { BillingPeriodsPanel } from './BillingPeriodsPanel';
import { BillingRecordDetail } from './BillingRecordDetail';
import { BillingSeatCapacityPanel } from './BillingSeatCapacityPanel';
import { BillingSubscriptionsTable } from './BillingSubscriptionsTable';
import { BillingTariffsTab } from './BillingTariffsTab';

const tabs = ['tariffs', 'assignments', 'adjustments', 'subscriptions', 'periods', 'browser',
  'app-keys', 'runtime-keys'] as const;
type BillingTab = (typeof tabs)[number];

/** The one sentence that explains which tariff wins and when a change starts. */
export const billingPrecedenceSentence = "A team's tariff overrides its organisation's, which " +
  'overrides the product default. Assignment changes take effect immediately.';

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
  const { params, openTab } = useBillingNavigation();
  const requested = params.get('tab') ?? 'tariffs';
  const tab: BillingTab = (tabs as readonly string[]).includes(requested)
    ? (requested as BillingTab) : 'tariffs';
  const ledgerKeys = useBillingLedgerRuntimeKeysQuery();
  const activeLedgerKeys = ledgerKeys.data
    ?.filter((key) => key.product === service.identifier && !key.revoked_at).length;
  const actions: Partial<Record<BillingTab, { label: string; onClick: () => void }>> = {
    tariffs: { label: 'New tariff', onClick: onAddTariff },
    assignments: { label: 'Assign tariff', onClick: onAddAssignment },
    adjustments: { label: 'Add add-on or credit', onClick: onAddAdjustment },
    'app-keys': { label: 'Issue app key', onClick: onAddAppKey },
  };
  const action = actions[tab];

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
          {tab === 'tariffs' || tab === 'assignments' ? (
            <p className="mt-1 text-xs text-gray-500">{billingPrecedenceSentence}</p>
          ) : null}
        </div>
        {action ? (
          <Button icon="plus" size="sm" variant="primary" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </CardHeader>
      <div className="px-5 pt-4">
        <UnderlineTabs
          value={tab}
          onChange={openTab}
          options={[
            {
              label: 'Tariffs',
              value: 'tariffs',
              count: service.tariffs.filter((tariff) => !tariff.retired_at).length,
            },
            { label: 'Assignments', value: 'assignments', count: service.assignments.length },
            { label: 'Add-ons & credits', value: 'adjustments', count: service.adjustments.length },
            {
              label: 'Subscriptions',
              value: 'subscriptions',
              count: service.stripe_subscriptions.length,
            },
            { label: 'Time periods', value: 'periods' },
            { label: 'Cloud browsers', value: 'browser' },
            {
              label: 'App keys',
              value: 'app-keys',
              count: service.app_keys.filter(billingAppKeyIsActive).length,
            },
            { label: 'Ledger keys', value: 'runtime-keys', count: activeLedgerKeys },
          ]}
        />
      </div>
      {tab === 'tariffs' ? <BillingTariffsTab service={service} /> : null}
      {tab === 'assignments' ? <BillingAssignmentsTab service={service} /> : null}
      {tab === 'adjustments' ? <BillingAdjustmentsTab service={service} /> : null}
      {tab === 'subscriptions' ? (
        <>
          <BillingSubscriptionsTable service={service} />
          <BillingSeatCapacityPanel serviceId={service.id} />
        </>
      ) : null}
      {tab === 'periods' ? <BillingPeriodsPanel service={service} /> : null}
      {tab === 'browser' ? <BillingBrowserPolicyPanel service={service} /> : null}
      {tab === 'app-keys' ? <BillingAppKeysTab service={service} /> : null}
      {tab === 'runtime-keys' ? (
        <BillingLedgerRuntimeKeysPanel key={service.id} service={service} />
      ) : null}
      <BillingRecordDetail service={service} />
    </Card>
  );
}
