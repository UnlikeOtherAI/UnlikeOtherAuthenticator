import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import { billingMajorToMinor } from './billing-money';
import type { BillingService } from '../../schemas/billing';
import {
  BillingContractFormSchema,
  BillingContractServiceActivationSchema,
  BillingContractVersionFormSchema,
  type BillingContract,
  type BillingContractFormValues,
  type BillingContractVersion,
  type BillingContractVersionFormValues,
} from '../../schemas/billing-contracts';
import {
  BillingContractServiceTermsRow, defaultServiceSelection,
  type ServiceSelection,
} from './BillingContractServiceTermsRow';
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
  if (!latest) return nextMonth(currentMonth());
  const afterLatest = nextMonth(latest.effective_from_month);
  const next = nextMonth(currentMonth());
  return afterLatest > next ? afterLatest : next;
}

function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-red-600">
      {error instanceof Error ? error.message : 'The billing change could not be saved.'}
    </p>
  );
}

function monthlyAmountMinor(amount: string, currency: string): string {
  try {
    return billingMajorToMinor(amount, currency);
  } catch {
    return ''; // Invalid form value stays local; the activation schema rejects it.
  }
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
    try {
      await create.mutateAsync(values);
      onClose();
    } catch {
      /* Preserve the form and mutation error for retry. */
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      isPending={create.isPending}
      isDirty={form.formState.isDirty}
      title="Create organisation contract"
      footer={
        <>
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
      usageMarkupPercent: '30.00',
      currency: 'USD',
      paymentTermsDays: 30,
      effectiveFromMonth: nextMonth(currentMonth()),
    },
  });

  useEffect(() => {
    if (contract) {
      form.reset({
        usageMarkupPercent: '30.00',
        currency: contract.versions[0]?.currency ?? 'USD',
        paymentTermsDays: contract.versions[0]?.payment_terms_days ?? 30,
        effectiveFromMonth: nextEffectiveMonth(contract),
      });
    }
  }, [contract, form]);

  async function submit(values: BillingContractVersionFormValues) {
    if (values.effectiveFromMonth <= currentMonth()) {
      form.setError('effectiveFromMonth', {
        type: 'manual', message: 'Choose a future billing month.',
      });
      return;
    }
    try {
      await create.mutateAsync(values);
      onClose();
    } catch {
      /* Preserve the form and mutation error for retry. */
    }
  }

  return (
    <Modal
      isOpen={Boolean(contract)}
      onClose={onClose}
      isPending={create.isPending}
      isDirty={form.formState.isDirty}
      title={`Add contract terms · ${contract?.name ?? ''}`}
      footer={
        <>
          <Button variant="primary" disabled={create.isPending} onClick={form.handleSubmit(submit)}>
            {create.isPending ? 'Saving...' : 'Save draft terms'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Usage markup (%)"
            hint="30.00% is the standard rate. Only UOA applies this markup."
            error={form.formState.errors.usageMarkupPercent?.message}
          >
            <TextField {...form.register('usageMarkupPercent')} inputMode="decimal" />
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
            <TextField {...form.register('effectiveFromMonth')}
              type="month" min={nextMonth(currentMonth())} />
          </FieldShell>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Choose a future billing month. Saving creates draft terms; activation freezes monthly
          service prices for that month and later months.
        </div>
        <ErrorMessage error={create.error} />
      </form>
    </Modal>
  );
}

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
  const initialSelection = useMemo<Record<string, ServiceSelection>>(
    () =>
      Object.fromEntries(
        activeServices.map((service) => [service.id, defaultServiceSelection()]),
      ),
    [activeServices],
  );
  const [selection, setSelection] = useState<Record<string, ServiceSelection>>(initialSelection);
  const [validationError, setValidationError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selectedInputs = activeServices
    .filter((service) => selection[service.id]?.enabled)
    .map((service) => {
      const value = selection[service.id];
      return {
        serviceId: service.id,
        monthlyAmountMinor: monthlyAmountMinor(value.amount, version?.currency ?? ''),
        monthlyChargeBasis: value.monthlyChargeBasis,
        ...(value.monthlyChargeBasis === 'per_seat'
          ? { seatPolicy: value.seatPolicy, seatChargeTiming: value.seatChargeTiming }
          : {}),
        usagePaymentMode: value.usagePaymentMode,
        ...(value.monthlyChargeBasis === 'per_seat' && value.seatPolicy === 'fixed'
          ? { fixedSeatQuantity: Number(value.fixedSeatQuantity) } : {}),
      };
    });
  const parsedSelection = BillingContractServiceActivationSchema.array().min(1)
    .safeParse(selectedInputs);
  const selectionIsValid = parsedSelection.success;

  useEffect(() => {
    if (version) {
      setSelection(initialSelection);
      setValidationError('');
      setConfirmed(false);
    }
  }, [initialSelection, version]);

  async function submit() {
    if (!parsedSelection.success || !confirmed) {
      setValidationError(
        'Select services, enter each monthly price and required seat quantity, then confirm.',
      );
      return;
    }
    try {
      await activate.mutateAsync(parsedSelection.data);
      onClose();
    } catch {
      /* Preserve selected services and show the mutation error. */
    }
  }

  return (
    <Modal
      isOpen={Boolean(contract && version)}
      onClose={onClose}
      isPending={activate.isPending}
      isDirty={selectedInputs.length > 0}
      title={`Activate version ${version?.version ?? ''}`}
      widthClassName="max-w-2xl"
      footer={
        <>
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
          Set each flat monthly fee or price per seat in {version?.currency ?? 'the chosen currency'},
          seat policy, and usage payment mode.
          Invoices show the calculated customer prices; raw token cost stays private inside UOA.
        </p>
        <p className="text-sm text-gray-600">
          These terms start in {version?.effective_from_month ?? 'the chosen future month'}.
          Current and earlier billing months keep their existing prices.
        </p>
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200">
          {activeServices.map((service) => (
            <BillingContractServiceTermsRow key={service.id} service={service}
              value={selection[service.id] ?? defaultServiceSelection()}
              currency={version?.currency ?? ''}
              onChange={(patch) => {
                setConfirmed(false);
                setSelection((value) => ({ ...value,
                  [service.id]: { ...(value[service.id] ?? defaultServiceSelection()), ...patch },
                }));
              }} />
          ))}
          {activeServices.length === 0 ? (
            <p className="px-4 py-5 text-sm text-gray-500">
              No active billing services are available.
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
          <p className="font-medium">
            {selectedInputs.length} service{selectedInputs.length === 1 ? '' : 's'} selected ·{' '}
            {version?.currency ?? '—'}
          </p>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm these exact subscription and usage payment terms. Fixed seat capacity
            applies when activated, even if billing starts in a future month.
          </label>
        </div>
        {validationError ? <p className="text-sm text-red-600">{validationError}</p> : null}
        <ErrorMessage error={activate.error} />
      </div>
    </Modal>
  );
}
