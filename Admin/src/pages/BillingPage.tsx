import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { DataTable, Td, PaginationFooter, usePagination } from '../components/ui/Table';
import { useBillingNavigation } from '../features/admin/billing-navigation';
import { TextField } from '../components/ui/FormFields';
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
import { BillingCreditInvoiceTaxPolicyPanel } from '../features/admin/BillingCreditInvoiceTaxPolicyPanel';
import type { CreatedBillingAppKey } from '../schemas/billing';

export function BillingPage() {
  const { data: services = [], isError, isLoading, refetch } = useBillingServicesQuery();
  const { params, href, update } = useBillingNavigation();
  const selectedServiceId = params.get('product') ?? '';
  const query = params.get('q') ?? '';
  const visibleServices = services
    .filter((service) =>
      `${service.name} ${service.identifier}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const { pageItems, pagination } = usePagination(visibleServices, 10, { key: 'products_page' });
  const [createServiceOpen, setCreateServiceOpen] = useState(false);
  const [tariffOpen, setTariffOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [appKeyOpen, setAppKeyOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedBillingAppKey | null>(null);
  const section = params.get('section') === 'contracts' ? 'contracts' : 'products';
  const selectedService = useMemo(
    () => services.find((service) => service.id === selectedServiceId) ?? null,
    [selectedServiceId, services],
  );
  return (
    <>
      <PageHeader
        title="Billing"
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
        onChange={(value) => update({ section: value })}
        options={[
          { label: 'Product billing', value: 'products' },
          { label: 'Contracts & invoices', value: 'contracts' },
        ]}
      />

      {section === 'products' ? (
        <>
          {isLoading ? (
            <Card className="px-5 py-8 text-sm text-gray-400">Loading products...</Card>
          ) : null}
          {isError ? (
            <Card className="border-red-200 px-5 py-8 text-sm text-red-600">
              Could not load billing services.{' '}
              <Button className="ml-3" onClick={() => void refetch()}>
                Retry
              </Button>
            </Card>
          ) : null}
          {!isLoading && !isError && services.length === 0 ? (
            <Card className="px-5 py-10 text-center">
              <p className="text-sm font-semibold text-gray-800">No billing services yet</p>
              <p className="mt-1 text-sm text-gray-500">Add a product with its initial tariff.</p>
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

          {!isLoading && !isError && !selectedServiceId && services.length > 0 ? (
            <Card>
              <div className="p-4">
                <TextField
                  aria-label="Search billing products"
                  placeholder="Search products"
                  value={query}
                  onChange={(event) => update({ q: event.target.value, products_page: null })}
                />
              </div>
              <DataTable headers={['Product', 'Status', 'Default tariff']}>
                {pageItems.map((service) => (
                  <tr key={service.id}>
                    <Td>
                      <Link
                        className="font-medium text-blue-600 hover:underline"
                        to={href({ product: service.id, tab: null, record: null })}
                      >
                        {service.name}
                      </Link>
                      <p className="text-xs text-gray-500">{service.identifier}</p>
                    </Td>
                    <Td>
                      <Badge variant={service.active ? 'green' : 'slate'}>
                        {service.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </Td>
                    <Td>
                      {service.tariffs.find((tariff) => tariff.is_default)?.name ??
                        'No default tariff'}
                    </Td>
                  </tr>
                ))}
                {visibleServices.length === 0 ? (
                  <tr>
                    <Td colSpan={3}>No products match this search.</Td>
                  </tr>
                ) : null}
              </DataTable>
              <PaginationFooter {...pagination} />
            </Card>
          ) : null}
          {!isLoading && !isError && selectedServiceId && !selectedService ? (
            <Card className="p-5">
              Product unavailable.{' '}
              <Link
                className="text-blue-600 hover:underline"
                to={href({ product: null, tab: null, record: null })}
              >
                All products
              </Link>
            </Card>
          ) : null}
          {selectedService ? (
            <div className="space-y-4">
              <Link
                className="text-sm text-blue-600 hover:underline"
                to={href({ product: null, tab: null, record: null })}
              >
                All products
              </Link>
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
      ) : (
        <div className="space-y-4">
          <BillingContractsPanel
            services={services}
            servicesError={isError}
            servicesLoading={isLoading}
          />
          <BillingCreditInvoiceTaxPolicyPanel />
        </div>
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
