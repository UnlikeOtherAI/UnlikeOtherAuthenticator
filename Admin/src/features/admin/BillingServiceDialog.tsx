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
  key: 'standard',
  name: 'Standard',
  mode: 'standard',
  collectionMode: 'none',
  markupPercent: '30.00',
  usagePaymentMode: 'prepaid',
  cloudBrowserMarkupPercent: '',
  monthlyChargeBasis: 'flat',
  seatPolicy: 'automatic',
  seatChargeTiming: 'prorated',
  monthlyAmount: '0.00',
  currency: 'USD',
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
    try {
      await create.mutateAsync(values);
      onClose();
    } catch {
      /* Keep values and show the mutation error for retry. */
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      isPending={create.isPending}
      isDirty={form.formState.isDirty}
      title="Add billing service"
      widthClassName="max-w-2xl"
      footer={
        <>
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
              label="Markup (%)"
              hint="30.00% is the standard rate; each tariff stores its own negotiated rate."
              error={form.formState.errors.markupPercent?.message}
            >
              <TextField {...form.register('markupPercent')} inputMode="decimal" />
            </FieldShell>
            <FieldShell
              label="Usage payment"
              hint="Prepaid draws from the customer's shared team or organisation pool."
              error={form.formState.errors.usagePaymentMode?.message}
            >
              <SelectField {...form.register('usagePaymentMode')} className="w-full">
                <option value="prepaid">Prepaid pool</option>
                <option value="pay_as_you_go">Pay as you go</option>
              </SelectField>
            </FieldShell>
            <FieldShell
              label="Cloud browser markup %"
              hint="Optional, prepaid only. Browserbase minutes metered by Ledger use this markup and show as Cloud browser."
              error={form.formState.errors.cloudBrowserMarkupPercent?.message}
            >
              <TextField {...form.register('cloudBrowserMarkupPercent')} inputMode="decimal" />
            </FieldShell>
            <FieldShell
              label="Monthly subscription basis"
              hint="One charge per team or organisation, or one charge per active seat."
              error={form.formState.errors.monthlyChargeBasis?.message}
            >
              <SelectField {...form.register('monthlyChargeBasis')} className="w-full">
                <option value="flat">Flat</option>
                <option value="per_seat">Per seat</option>
              </SelectField>
            </FieldShell>
            {form.watch('monthlyChargeBasis') === 'per_seat' ? (
              <>
                <FieldShell
                  label="Seat quantity"
                  hint="Fixed capacity is purchased for each team or organisation subscription."
                  error={form.formState.errors.seatPolicy?.message}
                >
                  <SelectField {...form.register('seatPolicy')} className="w-full">
                    <option value="automatic">Automatic active seats</option>
                    <option value="fixed">Fixed purchased capacity</option>
                  </SelectField>
                </FieldShell>
                <FieldShell
                  label="Seat charge timing"
                  error={form.formState.errors.seatChargeTiming?.message}
                >
                  <SelectField {...form.register('seatChargeTiming')} className="w-full">
                    <option value="full_month">Full month</option>
                    <option value="prorated">Prorated</option>
                  </SelectField>
                </FieldShell>
              </>
            ) : null}
            <FieldShell
              label="Monthly price"
              hint="Currency amount per chosen subscription basis, for example 20.00 GBP."
              error={form.formState.errors.monthlyAmount?.message}
            >
              <TextField {...form.register('monthlyAmount')} inputMode="decimal" />
            </FieldShell>
            <FieldShell label="Currency" error={form.formState.errors.currency?.message}>
              <TextField {...form.register('currency')} className="uppercase" maxLength={3} />
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
