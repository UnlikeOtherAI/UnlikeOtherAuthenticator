import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import { BillingServiceFormSchema, type BillingServiceFormValues } from '../../schemas/billing';
import { useCreateBillingServiceMutation } from './billing-admin-queries';

const defaults: BillingServiceFormValues = {
  identifier: '',
  serviceName: '',
  key: 'at-cost',
  name: 'At cost',
  mode: 'at_cost',
  collectionMode: 'none',
  markupBps: 0,
  monthlyAmountMinor: '0',
  currency: 'GBP',
};

export function BillingServiceDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const create = useCreateBillingServiceMutation();
  const form = useForm<BillingServiceFormValues>({
    resolver: zodResolver(BillingServiceFormSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) form.reset(defaults);
  }, [form, open]);

  async function submit(values: BillingServiceFormValues) {
    await create.mutateAsync(values);
    onClose();
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Add billing service"
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
            {create.isPending ? 'Creating...' : 'Create service'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={form.handleSubmit(submit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Product identifier"
            hint="Permanent machine identifier, for example deepwater."
            error={form.formState.errors.identifier?.message}
          >
            <TextField
              {...form.register('identifier')}
              className="font-mono"
              placeholder="deepwater"
            />
          </FieldShell>
          <FieldShell label="Display name" error={form.formState.errors.serviceName?.message}>
            <TextField {...form.register('serviceName')} placeholder="DeepWater" />
          </FieldShell>
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm font-semibold text-gray-900">Initial immutable tariff</p>
          <p className="mt-1 text-xs text-gray-500">
            This becomes version 1 and the service default. New terms are added as later versions.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <FieldShell label="Tariff key" error={form.formState.errors.key?.message}>
              <TextField {...form.register('key')} className="font-mono" />
            </FieldShell>
            <FieldShell label="Tariff name" error={form.formState.errors.name?.message}>
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
              hint="None is the safe default; Stripe must also be enabled at deployment."
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
              hint="2,000 = 20%; 4,000 = 40%."
              error={form.formState.errors.markupBps?.message}
            >
              <TextField {...form.register('markupBps')} type="number" min="0" step="1" />
            </FieldShell>
            <FieldShell
              label="Monthly amount (minor units)"
              hint="For GBP, 2000 means £20.00."
              error={form.formState.errors.monthlyAmountMinor?.message}
            >
              <div className="flex gap-2">
                <TextField {...form.register('monthlyAmountMinor')} inputMode="numeric" />
                <TextField
                  {...form.register('currency')}
                  className="w-24 uppercase"
                  maxLength={3}
                />
              </div>
            </FieldShell>
          </div>
        </div>
        {create.isError ? (
          <p className="text-sm text-red-600">
            {create.error instanceof Error ? create.error.message : 'Could not create service.'}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
