import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import type { BillingService } from '../../schemas/billing';
import {
  BillingContractFormSchema,
  BillingContractVersionFormSchema,
  type BillingContract,
  type BillingContractFormValues,
  type BillingContractVersion,
  type BillingContractVersionFormValues,
} from '../../schemas/billing-contracts';
import { useOrganisationsQuery } from './admin-queries';
import {
  useActivateBillingContractVersionMutation,
  useCreateBillingContractMutation,
  useCreateBillingContractVersionMutation,
} from './billing-contract-queries';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
}

function nextEffectiveMonth(contract: BillingContract): string {
  const latest = [...contract.versions].sort((left, right) => right.version - left.version)[0];
  if (!latest) return currentMonth();
  const afterLatest = nextMonth(latest.effective_from_month);
  return afterLatest > currentMonth() ? afterLatest : currentMonth();
}

function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-red-600">
      {error instanceof Error ? error.message : 'The billing change could not be saved.'}
    </p>
  );
}

export function CreateBillingContractDialog({
  onClose,
  open,
}: {
  onClose: () => void;
  open: boolean;
}) {
  const { data: organisations = [] } = useOrganisationsQuery();
  const create = useCreateBillingContractMutation();
  const form = useForm<BillingContractFormValues>({
    resolver: zodResolver(BillingContractFormSchema),
    defaultValues: { organisationId: '', reference: '', name: '' },
  });

  useEffect(() => {
    if (open) form.reset({ organisationId: '', reference: '', name: '' });
  }, [form, open]);

  async function submit(values: BillingContractFormValues) {
    await create.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Create organisation contract"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={form.handleSubmit(submit)}>
            {create.isPending ? 'Creating...' : 'Create contract'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Organisation" error={form.formState.errors.organisationId?.message}>
          <SelectField className="w-full" {...form.register('organisationId')}>
            <option value="">Select organisation</option>
            {organisations.map((organisation) => (
              <option key={organisation.id} value={organisation.id}>
                {organisation.name}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Contract reference" error={form.formState.errors.reference?.message}>
          <TextField {...form.register('reference')} placeholder="MSA-2026-001" />
        </FieldShell>
        <FieldShell label="Contract name" error={form.formState.errors.name?.message}>
          <TextField {...form.register('name')} placeholder="Enterprise AI services" />
        </FieldShell>
        <ErrorMessage error={create.error} />
      </form>
    </Modal>
  );
}

export function AddBillingContractVersionDialog({
  contract,
  onClose,
}: {
  contract: BillingContract | null;
  onClose: () => void;
}) {
  const create = useCreateBillingContractVersionMutation(contract?.id ?? '');
  const form = useForm<BillingContractVersionFormValues>({
    resolver: zodResolver(BillingContractVersionFormSchema),
    defaultValues: {
      usageMarkupBps: 0,
      currency: 'USD',
      paymentTermsDays: 30,
      effectiveFromMonth: currentMonth(),
    },
  });

  useEffect(() => {
    if (contract) {
      form.reset({
        usageMarkupBps: 0,
        currency: contract.versions[0]?.currency ?? 'USD',
        paymentTermsDays: contract.versions[0]?.payment_terms_days ?? 30,
        effectiveFromMonth: nextEffectiveMonth(contract),
      });
    }
  }, [contract, form]);

  async function submit(values: BillingContractVersionFormValues) {
    await create.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={Boolean(contract)}
      onClose={onClose}
      title={`Add contract terms · ${contract?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={form.handleSubmit(submit)}>
            {create.isPending ? 'Saving...' : 'Save draft terms'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Usage margin (basis points)"
            hint="2,000 basis points is 20%. Only UOA applies this margin."
            error={form.formState.errors.usageMarkupBps?.message}
          >
            <TextField {...form.register('usageMarkupBps')} inputMode="numeric" />
          </FieldShell>
          <FieldShell label="Currency" error={form.formState.errors.currency?.message}>
            <TextField {...form.register('currency')} maxLength={3} />
          </FieldShell>
          <FieldShell
            label="Payment terms (days)"
            error={form.formState.errors.paymentTermsDays?.message}
          >
            <TextField {...form.register('paymentTermsDays')} inputMode="numeric" />
          </FieldShell>
          <FieldShell
            label="Effective from"
            error={form.formState.errors.effectiveFromMonth?.message}
          >
            <TextField {...form.register('effectiveFromMonth')} type="month" />
          </FieldShell>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Saving creates immutable draft terms. Monthly service prices are frozen when you activate
          this version.
        </div>
        <ErrorMessage error={create.error} />
      </form>
    </Modal>
  );
}

type ServiceSelection = Record<string, { enabled: boolean; amount: string }>;

export function ActivateBillingContractVersionDialog({
  contract,
  onClose,
  services,
  version,
}: {
  contract: BillingContract | null;
  onClose: () => void;
  services: BillingService[];
  version: BillingContractVersion | null;
}) {
  const activate = useActivateBillingContractVersionMutation(contract?.id ?? '', version?.id ?? '');
  const activeServices = useMemo(() => services.filter((service) => service.active), [services]);
  const initialSelection = useMemo<ServiceSelection>(
    () =>
      Object.fromEntries(
        activeServices.map((service) => [service.id, { enabled: false, amount: '' }]),
      ),
    [activeServices],
  );
  const [selection, setSelection] = useState<ServiceSelection>(initialSelection);
  const [validationError, setValidationError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selectedServices = activeServices
    .filter((service) => selection[service.id]?.enabled)
    .map((service) => ({
      serviceId: service.id,
      monthlyAmountMinor: selection[service.id]?.amount ?? '',
    }));
  const selectionIsValid =
    selectedServices.length > 0 &&
    selectedServices.every((item) => /^(0|[1-9]\d*)$/.test(item.monthlyAmountMinor));

  useEffect(() => {
    if (version) {
      setSelection(initialSelection);
      setValidationError('');
      setConfirmed(false);
    }
  }, [initialSelection, version]);

  async function submit() {
    if (!selectionIsValid || !confirmed) {
      setValidationError(
        'Select at least one service, enter every monthly price, and confirm the immutable terms.',
      );
      return;
    }
    await activate.mutateAsync(selectedServices);
    onClose();
  }

  return (
    <Modal
      isOpen={Boolean(contract && version)}
      onClose={onClose}
      title={`Activate version ${version?.version ?? ''}`}
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={activate.isPending || !selectionIsValid || !confirmed}
            onClick={submit}
          >
            {activate.isPending ? 'Activating...' : 'Activate immutable terms'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Set the customer-facing monthly amount for each contracted service. Invoices show only
          these calculated prices; raw token cost and margin stay private inside UOA.
        </p>
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200">
          {activeServices.map((service) => {
            const current = selection[service.id] ?? { enabled: false, amount: '' };
            return (
              <div key={service.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <label className="flex min-w-52 flex-1 items-center gap-2 text-sm font-medium text-gray-800">
                  <input
                    type="checkbox"
                    checked={current.enabled}
                    onChange={(event) => {
                      setConfirmed(false);
                      setSelection((value) => ({
                        ...value,
                        [service.id]: { ...current, enabled: event.target.checked },
                      }));
                    }}
                  />
                  {service.name}
                  <span className="text-xs font-normal text-gray-400">{service.identifier}</span>
                </label>
                <TextField
                  aria-label={`${service.name} monthly amount in minor units`}
                  className="w-48"
                  disabled={!current.enabled}
                  inputMode="numeric"
                  value={current.amount}
                  onChange={(event) => {
                    setConfirmed(false);
                    setSelection((value) => ({
                      ...value,
                      [service.id]: { ...current, amount: event.target.value },
                    }));
                  }}
                />
              </div>
            );
          })}
          {activeServices.length === 0 ? (
            <p className="px-4 py-5 text-sm text-gray-500">
              No active billing services are available.
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
          <p className="font-medium">
            {selectedServices.length} service{selectedServices.length === 1 ? '' : 's'} selected ·{' '}
            {version?.currency ?? '—'}
          </p>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm these exact monthly prices and understand activation freezes this contract
            version.
          </label>
        </div>
        {validationError ? <p className="text-sm text-red-600">{validationError}</p> : null}
        <ErrorMessage error={activate.error} />
      </div>
    </Modal>
  );
}
