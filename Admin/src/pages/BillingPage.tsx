import { useEffect, useMemo, useState } from 'react';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { UnderlineTabs } from '../components/ui/Tabs';
import { BillingAdjustmentDialog } from '../features/admin/BillingAdjustmentDialog';
import { BillingAppKeyDialog } from '../features/admin/BillingAppKeyDialog';
import { BillingAssignmentDialog } from '../features/admin/BillingAssignmentDialog';
import { useBillingServicesQuery } from '../features/admin/billing-admin-queries';
import { BillingKeyRevealDialog } from '../features/admin/BillingKeyRevealDialog';
import { BillingServiceDialog } from '../features/admin/BillingServiceDialog';
import { BillingServicePanel } from '../features/admin/BillingServicePanel';
import { BillingTariffDialog } from '../features/admin/BillingTariffDialog';
import { BillingContractsPanel } from '../features/admin/BillingContractsPanel';
import { BillingCreditAccountsPanel } from '../features/admin/BillingCreditAccountsPanel';
import type { CreatedBillingAppKey } from '../schemas/billing';

export function BillingPage() {
  const { data: services = [], isError, isLoading } = useBillingServicesQuery();
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [createServiceOpen, setCreateServiceOpen] = useState(false);
  const [tariffOpen, setTariffOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [appKeyOpen, setAppKeyOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedBillingAppKey | null>(null);
  const [section, setSection] = useState<'products' | 'credits' | 'contracts'>('products');

  useEffect(() => {
    if (services.length > 0 && !services.some((service) => service.id === selectedServiceId)) {
      setSelectedServiceId(services[0]?.id ?? '');
    }
  }, [selectedServiceId, services]);

  const selectedService = useMemo(
    () => services.find((service) => service.id === selectedServiceId) ?? null,
    [selectedServiceId, services],
  );
  const activeSubscriptions = services
    .flatMap((service) => service.stripe_subscriptions)
    .filter(
      (subscription) => !['canceled', 'incomplete_expired'].includes(subscription.status),
    ).length;

  return (
    <>
      <PageHeader
        title="Billing"
        description="Global product tariffs, shared team credits, contracts, and Stripe lifecycle."
        badges={
          <>
            <Badge variant="blue">{services.length} services</Badge>
            <Badge variant={activeSubscriptions > 0 ? 'purple' : 'slate'}>
              {activeSubscriptions} active subscriptions
            </Badge>
          </>
        }
        actions={
          section === 'products' ? (
            <Button icon="plus" variant="primary" onClick={() => setCreateServiceOpen(true)}>
              Add service
            </Button>
          ) : undefined
        }
      />

      <UnderlineTabs
        value={section}
        onChange={setSection}
        options={[
          { label: 'Product billing', value: 'products', count: services.length },
          { label: 'Team credits', value: 'credits' },
          { label: 'Contracts & invoices', value: 'contracts' },
        ]}
      />

      {section === 'products' ? (
        <>
          <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            Tariffs here are the source of truth shared by every product API. A tariff can describe
            markup and monthly value while collection remains <strong>none</strong>. Live Stripe
            calls require a separate deployment gate.
          </div>

          {isLoading ? (
            <Card className="px-5 py-8 text-sm text-gray-400">
              Loading billing control plane...
            </Card>
          ) : null}
          {isError ? (
            <Card className="border-red-200 px-5 py-8 text-sm text-red-600">
              Could not load billing services.
            </Card>
          ) : null}
          {!isLoading && !isError && services.length === 0 ? (
            <Card className="px-5 py-10 text-center">
              <p className="text-sm font-semibold text-gray-800">No billing services yet</p>
              <p className="mt-1 text-sm text-gray-500">
                Add a product and its safe initial tariff to establish the shared control plane.
              </p>
              <Button
                className="mt-4"
                icon="plus"
                variant="primary"
                onClick={() => setCreateServiceOpen(true)}
              >
                Add first service
              </Button>
            </Card>
          ) : null}

          {selectedService ? (
            <div className="space-y-4">
              <Card className="p-4">
                <FieldShell
                  label="Product service"
                  hint="Select a service to manage its immutable terms and credentials."
                >
                  <SelectField
                    aria-label="Product service"
                    className="w-full max-w-xl"
                    value={selectedService.id}
                    onChange={(event) => setSelectedServiceId(event.target.value)}
                  >
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name} · {service.identifier}
                      </option>
                    ))}
                  </SelectField>
                </FieldShell>
              </Card>
              <BillingServicePanel
                service={selectedService}
                onAddTariff={() => setTariffOpen(true)}
                onAddAssignment={() => setAssignmentOpen(true)}
                onAddAppKey={() => setAppKeyOpen(true)}
                onAddAdjustment={() => setAdjustmentOpen(true)}
              />
            </div>
          ) : null}
        </>
      ) : section === 'credits' ? (
        <BillingCreditAccountsPanel />
      ) : (
        <BillingContractsPanel
          services={services}
          servicesError={isError}
          servicesLoading={isLoading}
        />
      )}

      <BillingServiceDialog open={createServiceOpen} onClose={() => setCreateServiceOpen(false)} />
      {selectedService ? (
        <>
          <BillingTariffDialog
            open={tariffOpen}
            service={selectedService}
            onClose={() => setTariffOpen(false)}
          />
          <BillingAssignmentDialog
            open={assignmentOpen}
            service={selectedService}
            onClose={() => setAssignmentOpen(false)}
          />
          <BillingAppKeyDialog
            open={appKeyOpen}
            service={selectedService}
            onClose={() => setAppKeyOpen(false)}
            onCreated={(key) => {
              setAppKeyOpen(false);
              setCreatedKey(key);
            }}
          />
          <BillingAdjustmentDialog
            open={adjustmentOpen}
            service={selectedService}
            onClose={() => setAdjustmentOpen(false)}
          />
        </>
      ) : null}
      <BillingKeyRevealDialog createdKey={createdKey} onClose={() => setCreatedKey(null)} />
    </>
  );
}
