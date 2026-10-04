import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { BillingInvoiceCalculateFormSchema,
  type BillingContract, type BillingInvoiceIssuerProfile,
  type BillingInvoiceCalculateFormValues,
} from '../../schemas/billing-contracts';
import { useCalculateBillingInvoiceMutation } from './billing-contract-queries';

function latestClosedMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString().slice(0, 7);
}

export function BillingInvoiceCalculator({ contract, issuers, disabled, onCreated }: {
  contract: BillingContract;
  issuers: BillingInvoiceIssuerProfile[];
  disabled: boolean;
  onCreated: (invoiceId: string) => void;
}) {
  const calculate = useCalculateBillingInvoiceMutation();
  const form = useForm<BillingInvoiceCalculateFormValues>({
    resolver: zodResolver(BillingInvoiceCalculateFormSchema),
    defaultValues: { contractId: contract.id, issuerProfileId: '',
      billingMonth: latestClosedMonth(), taxTreatment: 'no_tax_charged',
      taxRatePercent: '0', taxLegalBasis: '' },
  });

  useEffect(() => {
    form.setValue('contractId', contract.id);
    const activeIssuer = issuers.find((issuer) => issuer.active);
    if (!issuers.some((issuer) => issuer.id === form.getValues('issuerProfileId') && issuer.active)) {
      form.setValue('issuerProfileId', activeIssuer?.id ?? '');
    }
  }, [contract.id, form, issuers]);

  async function submit(values: BillingInvoiceCalculateFormValues) {
    if (values.contractId !== contract.id) return;
    try {
      const invoice = await calculate.mutateAsync(values);
      onCreated(invoice.id);
    } catch {
      // Keep the attested tax terms visible for a corrected retry.
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Invoice calculator</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Create an immutable draft for a closed billing month.
          </p>
        </div>
      </CardHeader>
      <form className="grid gap-4 p-5 md:grid-cols-4" onSubmit={form.handleSubmit(submit)}>
        <input type="hidden" {...form.register('contractId')} />
        <div className="text-sm">
          <p className="font-medium text-gray-700">Contract</p>
          <p>{contract.name} · {contract.reference}</p>
        </div>
        <FieldShell label="Issuer" error={form.formState.errors.issuerProfileId?.message}>
          <SelectField className="w-full" {...form.register('issuerProfileId')}>
            <option value="">Select issuer</option>
            {issuers.filter((issuer) => issuer.active).map((issuer) => (
              <option key={issuer.id} value={issuer.id}>{issuer.legal_name}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Billing month" error={form.formState.errors.billingMonth?.message}>
          <TextField type="month" max={latestClosedMonth()} {...form.register('billingMonth')} />
        </FieldShell>
        <FieldShell label="Tax treatment" error={form.formState.errors.taxTreatment?.message}>
          <SelectField className="w-full" {...form.register('taxTreatment')}>
            <option value="no_tax_charged">No tax charged</option>
            <option value="standard_rate">Tax at selected rate</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Tax rate (%)" error={form.formState.errors.taxRatePercent?.message}>
          <TextField {...form.register('taxRatePercent')} inputMode="decimal" />
        </FieldShell>
        <FieldShell label="Tax legal basis" error={form.formState.errors.taxLegalBasis?.message}>
          <TextField {...form.register('taxLegalBasis')}
            placeholder="Enter the applicable legal basis" />
        </FieldShell>
        <div className="flex items-end">
          <Button className="w-full" type="submit" variant="primary"
            disabled={calculate.isPending || disabled}>
            {calculate.isPending ? 'Calculating...' : 'Calculate draft'}
          </Button>
        </div>
        {calculate.isError ? (
          <p className="text-sm text-red-600 md:col-span-4">
            {calculate.error instanceof Error ? calculate.error.message :
              'Invoice calculation failed.'}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
