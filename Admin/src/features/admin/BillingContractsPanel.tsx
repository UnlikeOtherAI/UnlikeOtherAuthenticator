import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import type { BillingService } from '../../schemas/billing';
import {
  BillingInvoiceCalculateFormSchema,
  type BillingContract,
  type BillingContractVersion,
  type BillingInvoiceCalculateFormValues,
} from '../../schemas/billing-contracts';
import { useOrganisationsQuery } from './admin-queries';
import {
  ActivateBillingContractVersionDialog,
  AddBillingContractVersionDialog,
  CreateBillingContractDialog,
} from './BillingContractDialogs';
import {
  useBillingContractsQuery,
  useBillingInvoiceIssuersQuery,
  useBillingInvoicesQuery,
  useCalculateBillingInvoiceMutation,
} from './billing-contract-queries';
import { BillingInvoiceDetailDialog } from './BillingInvoiceDetailDialog';
import { BillingInvoiceHistory } from './BillingInvoiceHistory';
import {
  CreateBillingInvoiceIssuerDialog,
  EditBillingInvoiceBuyerDialog,
} from './BillingInvoiceProfileDialogs';

function contractVariant(status: BillingContract['status']): BadgeVariant {
  if (status === 'active') return 'green';
  if (status === 'terminated') return 'red';
  return 'slate';
}

function VersionServices({ version }: { version: BillingContractVersion }) {
  if (version.services.length === 0) return <span className="text-gray-400">Draft</span>;
  return (
    <div className="space-y-1">
      {version.services.map((service) => (
        <p key={service.service_id} className="whitespace-nowrap text-xs">
          <span className="font-medium text-gray-800">
            {service.service_name ?? service.service_identifier ?? service.service_id}
          </span>{' '}
          <span className="text-gray-500">· {service.monthly_price.display}</span>
        </p>
      ))}
    </div>
  );
}

function VersionAction({
  onActivate,
  servicesReady,
  version,
}: {
  onActivate: () => void;
  servicesReady: boolean;
  version: BillingContractVersion;
}) {
  if (version.actions.activate) {
    if (!servicesReady) return <span className="text-xs text-red-500">Services unavailable</span>;
    return (
      <Button size="sm" variant="primary" onClick={onActivate}>
        Activate
      </Button>
    );
  }
  const label = {
    active: 'Active',
    ready: 'Unavailable',
    scheduled: `Available ${version.effective_from_month}`,
    superseded: 'Frozen',
    contract_terminated: 'Contract terminated',
  }[version.actions.activation_state];
  return <span className="text-xs text-gray-400">{label}</span>;
}

function latestClosedMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

export function BillingContractsPanel({
  services,
  servicesError = false,
  servicesLoading = false,
}: {
  services: BillingService[];
  servicesError?: boolean;
  servicesLoading?: boolean;
}) {
  const contractsQuery = useBillingContractsQuery();
  const issuersQuery = useBillingInvoiceIssuersQuery();
  const invoicesQuery = useBillingInvoicesQuery();
  const { data: organisations = [] } = useOrganisationsQuery();
  const calculate = useCalculateBillingInvoiceMutation();
  const contracts = useMemo(() => contractsQuery.data ?? [], [contractsQuery.data]);
  const issuers = useMemo(() => issuersQuery.data ?? [], [issuersQuery.data]);
  const invoices = useMemo(() => invoicesQuery.data ?? [], [invoicesQuery.data]);
  const [organisationFilter, setOrganisationFilter] = useState('');
  const [selectedContractId, setSelectedContractId] = useState('');
  const [createContractOpen, setCreateContractOpen] = useState(false);
  const [versionContract, setVersionContract] = useState<BillingContract | null>(null);
  const [activation, setActivation] = useState<{
    contract: BillingContract;
    version: BillingContractVersion;
  } | null>(null);
  const [issuerOpen, setIssuerOpen] = useState(false);
  const [buyerOrganisationId, setBuyerOrganisationId] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const form = useForm<BillingInvoiceCalculateFormValues>({
    resolver: zodResolver(BillingInvoiceCalculateFormSchema),
    defaultValues: { contractId: '', issuerProfileId: '', billingMonth: latestClosedMonth() },
  });

  const visibleContracts = useMemo(
    () =>
      organisationFilter
        ? contracts.filter((contract) => contract.organisation_id === organisationFilter)
        : contracts,
    [contracts, organisationFilter],
  );
  const selectedContract =
    visibleContracts.find((contract) => contract.id === selectedContractId) ??
    visibleContracts[0] ??
    null;
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? null;

  useEffect(() => {
    if (selectedContract && selectedContract.id !== selectedContractId) {
      setSelectedContractId(selectedContract.id);
    }
  }, [selectedContract, selectedContractId]);

  useEffect(() => {
    const activeContract = contracts.find((contract) => contract.status === 'active');
    if (
      !contracts.some(
        (contract) => contract.id === form.getValues('contractId') && contract.status === 'active',
      )
    ) {
      form.setValue('contractId', activeContract?.id ?? '');
    }
    const activeIssuer = issuers.find((issuer) => issuer.active);
    if (
      !issuers.some((issuer) => issuer.id === form.getValues('issuerProfileId') && issuer.active)
    ) {
      form.setValue('issuerProfileId', activeIssuer?.id ?? '');
    }
  }, [contracts, form, issuers]);

  async function calculateInvoice(values: BillingInvoiceCalculateFormValues) {
    const invoice = await calculate.mutateAsync(values);
    setSelectedInvoiceId(invoice.id);
  }

  const loading = contractsQuery.isLoading || issuersQuery.isLoading || invoicesQuery.isLoading;
  const failed = contractsQuery.isError || issuersQuery.isError || invoicesQuery.isError;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-950">
        Contract pricing, invoice calculations, and lifecycle records live only in UOA. Customer
        invoices expose the calculated price per service—never raw token cost, token counts, or
        internal margin.
      </div>
      {servicesLoading ? (
        <p className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
          Loading billing services before contract activation...
        </p>
      ) : null}
      {servicesError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Billing services could not be loaded. Contract activation is disabled; invoice history
          remains available.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Organisation contracts</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Immutable margin terms and monthly service prices.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setIssuerOpen(true)}>Add issuer</Button>
            <Button icon="plus" variant="primary" onClick={() => setCreateContractOpen(true)}>
              Add contract
            </Button>
          </div>
        </CardHeader>
        <div className="grid gap-3 border-b border-gray-100 p-4 sm:grid-cols-2">
          <FieldShell label="Organisation filter">
            <SelectField
              className="w-full"
              value={organisationFilter}
              onChange={(event) => setOrganisationFilter(event.target.value)}
            >
              <option value="">All organisations</option>
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Selected contract">
            <SelectField
              className="w-full"
              value={selectedContract?.id ?? ''}
              onChange={(event) => setSelectedContractId(event.target.value)}
            >
              <option value="">No contract selected</option>
              {visibleContracts.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.organisation_name ?? contract.organisation_id} · {contract.reference}
                </option>
              ))}
            </SelectField>
          </FieldShell>
        </div>
        {loading ? <p className="p-5 text-sm text-gray-400">Loading contract billing...</p> : null}
        {failed ? (
          <p className="p-5 text-sm text-red-600">Could not load the contract control plane.</p>
        ) : null}
        {!loading && !failed && visibleContracts.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">
            No organisation contracts match this view.
          </p>
        ) : null}
        {selectedContract ? (
          <div className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-gray-900">{selectedContract.name}</h3>
                  <Badge variant={contractVariant(selectedContract.status)}>
                    {selectedContract.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {selectedContract.reference} ·{' '}
                  {selectedContract.organisation_name ?? selectedContract.organisation_id}
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setBuyerOrganisationId(selectedContract.organisation_id)}>
                  Buyer details
                </Button>
                {selectedContract.actions.add_version ? (
                  <Button onClick={() => setVersionContract(selectedContract)}>
                    Add terms version
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-4 space-y-3 md:hidden">
              {selectedContract.versions.map((version) => (
                <div key={version.id} className="rounded-xl border border-gray-200 p-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-gray-900">Version {version.version}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        {version.usage_markup_percent}% margin · {version.effective_from_month} ·{' '}
                        {version.currency}
                      </p>
                    </div>
                    <VersionAction
                      servicesReady={!servicesLoading && !servicesError}
                      version={version}
                      onActivate={() => setActivation({ contract: selectedContract, version })}
                    />
                  </div>
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <VersionServices version={version} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 hidden overflow-x-auto rounded-xl border border-gray-200 md:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">Version</th>
                    <th className="px-4 py-2.5">Margin</th>
                    <th className="px-4 py-2.5">Effective</th>
                    <th className="px-4 py-2.5">Services</th>
                    <th className="px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedContract.versions.map((version) => (
                    <tr key={version.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 font-medium text-gray-900">v{version.version}</td>
                      <td className="px-4 py-3">{version.usage_markup_percent}%</td>
                      <td className="px-4 py-3">{version.effective_from_month}</td>
                      <td className="px-4 py-3">
                        <VersionServices version={version} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <VersionAction
                          servicesReady={!servicesLoading && !servicesError}
                          version={version}
                          onActivate={() => setActivation({ contract: selectedContract, version })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Invoice calculator</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Freeze a draft from the active contract and Ledger-backed monthly usage.
            </p>
          </div>
          <Badge variant="blue">Customer-safe output</Badge>
        </CardHeader>
        <form
          className="grid gap-4 p-5 md:grid-cols-4"
          onSubmit={form.handleSubmit(calculateInvoice)}
        >
          <FieldShell label="Active contract" error={form.formState.errors.contractId?.message}>
            <SelectField className="w-full" {...form.register('contractId')}>
              <option value="">Select contract</option>
              {contracts
                .filter((contract) => contract.status === 'active')
                .map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    {contract.organisation_name} · {contract.reference}
                  </option>
                ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Issuer" error={form.formState.errors.issuerProfileId?.message}>
            <SelectField className="w-full" {...form.register('issuerProfileId')}>
              <option value="">Select issuer</option>
              {issuers
                .filter((issuer) => issuer.active)
                .map((issuer) => (
                  <option key={issuer.id} value={issuer.id}>
                    {issuer.legal_name}
                  </option>
                ))}
            </SelectField>
          </FieldShell>
          <FieldShell label="Billing month" error={form.formState.errors.billingMonth?.message}>
            <TextField type="month" max={latestClosedMonth()} {...form.register('billingMonth')} />
          </FieldShell>
          <div className="flex items-end">
            <Button
              className="w-full"
              type="submit"
              variant="primary"
              disabled={calculate.isPending}
            >
              {calculate.isPending ? 'Calculating...' : 'Calculate draft'}
            </Button>
          </div>
          {calculate.isError ? (
            <p className="text-sm text-red-600 md:col-span-4">
              {calculate.error instanceof Error
                ? calculate.error.message
                : 'Invoice calculation failed.'}
            </p>
          ) : null}
        </form>
      </Card>

      <BillingInvoiceHistory invoices={invoices} onSelect={setSelectedInvoiceId} />

      <CreateBillingContractDialog
        open={createContractOpen}
        onClose={() => setCreateContractOpen(false)}
      />
      <AddBillingContractVersionDialog
        contract={versionContract}
        onClose={() => setVersionContract(null)}
      />
      <ActivateBillingContractVersionDialog
        contract={activation?.contract ?? null}
        version={activation?.version ?? null}
        services={services}
        onClose={() => setActivation(null)}
      />
      <CreateBillingInvoiceIssuerDialog open={issuerOpen} onClose={() => setIssuerOpen(false)} />
      <EditBillingInvoiceBuyerDialog
        organisationId={buyerOrganisationId}
        onClose={() => setBuyerOrganisationId('')}
      />
      <BillingInvoiceDetailDialog
        invoice={selectedInvoice}
        onClose={() => setSelectedInvoiceId('')}
      />
    </div>
  );
}
