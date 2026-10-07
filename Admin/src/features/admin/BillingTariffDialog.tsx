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
  markupPercent: '30.00',
  usagePaymentMode: 'prepaid',
  monthlyChargeBasis: 'flat',
  seatPolicy: 'automatic',
  seatChargeTiming: 'prorated',
  monthlyAmount: '0.00',
  currency: 'USD',
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
      title={`Add tariff version · ${service.name}`}
      widthClassName="max-w-2xl"
      footer={
        <>
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
            label="Markup (%)"
            hint="30.00% is the standard rate."
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
            label="Monthly subscription basis"
            hint="One charge per assigned scope, or one charge per active seat."
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
            hint="Currency amount per chosen subscription basis."
            error={form.formState.errors.monthlyAmount?.message}
          >
            <TextField {...form.register('monthlyAmount')} inputMode="decimal" />
          </FieldShell>
          <FieldShell label="Currency" error={form.formState.errors.currency?.message}>
            <TextField {...form.register('currency')} className="uppercase" maxLength={3} />
          </FieldShell>
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4">
          <input
            {...form.register('setAsDefault')}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 text-indigo-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-700">
              Make this the service default
            </span>
            <span className="mt-0.5 block text-xs text-gray-500">
              The default changes next UTC month. Existing Stripe subscriptions pin their
              original immutable terms and may prevent a default change.
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
