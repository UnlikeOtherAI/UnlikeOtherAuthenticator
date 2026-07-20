import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingTariffFormSchema,
  type BillingService,
  type BillingTariffFormValues,
} from '../../schemas/billing';
import { useCreateBillingTariffMutation } from './billing-admin-queries';

const defaults: BillingTariffFormValues = {
  key: 'standard',
  name: 'Standard',
  mode: 'standard',
  collectionMode: 'none',
  markupBps: 2000,
  monthlyAmountMinor: '0',
  currency: 'GBP',
  setAsDefault: false,
};

export function BillingTariffDialog({
  onClose,
  open,
  service,
}: {
  onClose: () => void;
  open: boolean;
  service: BillingService;
}) {
  const create = useCreateBillingTariffMutation(service.id);
  const form = useForm<BillingTariffFormValues>({
    resolver: zodResolver(BillingTariffFormSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) form.reset(defaults);
  }, [form, open]);

  async function submit(values: BillingTariffFormValues) {
    await create.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Add tariff version · ${service.name}`}
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            icon="plus"
            variant="primary"
            disabled={create.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {create.isPending ? 'Creating...' : 'Create immutable version'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Tariff key"
            hint="Reusing a key increments its version."
            error={form.formState.errors.key?.message}
          >
            <TextField {...form.register('key')} className="font-mono" />
          </FieldShell>
          <FieldShell label="Name" error={form.formState.errors.name?.message}>
            <TextField {...form.register('name')} />
          </FieldShell>
          <FieldShell label="Mode" error={form.formState.errors.mode?.message}>
            <SelectField {...form.register('mode')} className="w-full">
              <option value="standard">Standard</option>
              <option value="custom">Custom</option>
              <option value="at_cost">At cost</option>
              <option value="free">Free</option>
            </SelectField>
          </FieldShell>
          <FieldShell
            label="Collection"
            hint="This controls entitlement terms; deployment still gates live Stripe calls."
            error={form.formState.errors.collectionMode?.message}
          >
            <SelectField {...form.register('collectionMode')} className="w-full">
              <option value="none">None</option>
              <option value="manual">Manual</option>
              <option value="stripe">Stripe</option>
            </SelectField>
          </FieldShell>
          <FieldShell
            label="Markup (basis points)"
            hint="100 basis points = 1%."
            error={form.formState.errors.markupBps?.message}
          >
            <TextField {...form.register('markupBps')} type="number" min="0" step="1" />
          </FieldShell>
          <FieldShell
            label="Monthly subscription"
            hint="Integer minor units plus ISO currency."
            error={
              form.formState.errors.monthlyAmountMinor?.message ??
              form.formState.errors.currency?.message
            }
          >
            <div className="flex gap-2">
              <TextField {...form.register('monthlyAmountMinor')} inputMode="numeric" />
              <TextField {...form.register('currency')} className="w-24 uppercase" maxLength={3} />
            </div>
          </FieldShell>
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4">
          <input
            {...form.register('setAsDefault')}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-700">
              Make this the service default
            </span>
            <span className="mt-0.5 block text-xs text-gray-500">
              Existing Stripe subscriptions pin their original immutable terms and may prevent a
              default change.
            </span>
          </span>
        </label>
        {create.isError ? (
          <p className="text-sm text-red-600">
            {create.error instanceof Error ? create.error.message : 'Could not create tariff.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
