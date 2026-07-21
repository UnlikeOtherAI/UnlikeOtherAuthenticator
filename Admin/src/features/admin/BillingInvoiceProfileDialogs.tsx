import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingInvoiceBuyerFormSchema,
  BillingInvoiceIssuerFormSchema,
  type BillingInvoiceBuyerFormValues,
  type BillingInvoiceBuyerProfile,
  type BillingInvoiceIssuerFormValues,
} from '../../schemas/billing-contracts';
import {
  useBillingInvoiceBuyerQuery,
  useCreateBillingInvoiceIssuerMutation,
  useSaveBillingInvoiceBuyerMutation,
} from './billing-contract-queries';

const issuerDefaults: BillingInvoiceIssuerFormValues = {
  key: '',
  legalName: '',
  tradingName: '',
  billingEmail: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  taxIdentifier: '',
  companyRegistrationNumber: '',
  invoiceNumberPrefix: '',
};

function emptyBuyer(organisationId: string): BillingInvoiceBuyerFormValues {
  return {
    organisationId,
    legalName: '',
    billingEmail: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    taxIdentifier: '',
    purchaseOrderReference: '',
  };
}

function buyerValues(profile: BillingInvoiceBuyerProfile): BillingInvoiceBuyerFormValues {
  return {
    organisationId: profile.organisation_id,
    legalName: profile.legal_name,
    billingEmail: profile.billing_email,
    line1: profile.billing_address.line1,
    line2: profile.billing_address.line2 ?? '',
    city: profile.billing_address.city,
    region: profile.billing_address.region ?? '',
    postalCode: profile.billing_address.postal_code,
    country: profile.billing_address.country,
    taxIdentifier: profile.tax_identifier ?? '',
    purchaseOrderReference: profile.purchase_order_reference ?? '',
  };
}

function MutationError({ error, fallback }: { error: unknown; fallback: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-red-600">
      {error instanceof Error ? error.message : fallback}
    </p>
  );
}

function AddressFields({
  errors,
  fields,
}: {
  errors: Partial<Record<'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'country', string>>;
  fields: Record<
    'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'country',
    UseFormRegisterReturn
  >;
}) {
  return (
    <fieldset className="space-y-4 rounded-xl border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">Postal address</legend>
      <FieldShell label="Address line 1" error={errors.line1}>
        <TextField {...fields.line1} autoComplete="address-line1" />
      </FieldShell>
      <FieldShell label="Address line 2 (optional)" error={errors.line2}>
        <TextField {...fields.line2} autoComplete="address-line2" />
      </FieldShell>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell label="City" error={errors.city}>
          <TextField {...fields.city} autoComplete="address-level2" />
        </FieldShell>
        <FieldShell label="Region (optional)" error={errors.region}>
          <TextField {...fields.region} autoComplete="address-level1" />
        </FieldShell>
        <FieldShell label="Postal code" error={errors.postalCode}>
          <TextField {...fields.postalCode} autoComplete="postal-code" />
        </FieldShell>
        <FieldShell
          label="Country code"
          hint="Two-letter ISO code, for example GB or US."
          error={errors.country}
        >
          <TextField
            {...fields.country}
            autoComplete="country"
            className="uppercase"
            maxLength={2}
            placeholder="GB"
          />
        </FieldShell>
      </div>
    </fieldset>
  );
}

export function CreateBillingInvoiceIssuerDialog({
  onClose,
  open,
}: {
  onClose: () => void;
  open: boolean;
}) {
  const create = useCreateBillingInvoiceIssuerMutation();
  const form = useForm<BillingInvoiceIssuerFormValues>({
    resolver: zodResolver(BillingInvoiceIssuerFormSchema),
    defaultValues: issuerDefaults,
  });
  const resetMutation = create.reset;

  useEffect(() => {
    if (!open) return;
    form.reset(issuerDefaults);
    resetMutation();
  }, [form, open, resetMutation]);

  function close() {
    form.reset(issuerDefaults);
    create.reset();
    onClose();
  }

  async function submit(values: BillingInvoiceIssuerFormValues) {
    await create.mutateAsync(values);
    close();
  }

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Create invoice issuer"
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={create.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {create.isPending ? 'Creating...' : 'Create issuer'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={form.handleSubmit(submit)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Issuer key"
            hint="Permanent internal identifier, for example unlikeotherai-uk."
            error={form.formState.errors.key?.message}
          >
            <TextField {...form.register('key')} placeholder="unlikeotherai-uk" />
          </FieldShell>
          <FieldShell
            label="Invoice number prefix"
            hint="Used when UOA assigns sequential invoice numbers."
            error={form.formState.errors.invoiceNumberPrefix?.message}
          >
            <TextField
              {...form.register('invoiceNumberPrefix')}
              className="uppercase"
              placeholder="UOA"
            />
          </FieldShell>
          <FieldShell label="Legal name" error={form.formState.errors.legalName?.message}>
            <TextField {...form.register('legalName')} autoComplete="organization" />
          </FieldShell>
          <FieldShell
            label="Trading name (optional)"
            error={form.formState.errors.tradingName?.message}
          >
            <TextField {...form.register('tradingName')} />
          </FieldShell>
          <FieldShell label="Billing email" error={form.formState.errors.billingEmail?.message}>
            <TextField {...form.register('billingEmail')} autoComplete="email" type="email" />
          </FieldShell>
          <FieldShell
            label="Tax identifier (optional)"
            error={form.formState.errors.taxIdentifier?.message}
          >
            <TextField {...form.register('taxIdentifier')} />
          </FieldShell>
          <FieldShell
            label="Company registration number (optional)"
            error={form.formState.errors.companyRegistrationNumber?.message}
          >
            <TextField {...form.register('companyRegistrationNumber')} />
          </FieldShell>
        </div>
        <AddressFields
          errors={{
            line1: form.formState.errors.line1?.message,
            line2: form.formState.errors.line2?.message,
            city: form.formState.errors.city?.message,
            region: form.formState.errors.region?.message,
            postalCode: form.formState.errors.postalCode?.message,
            country: form.formState.errors.country?.message,
          }}
          fields={{
            line1: form.register('line1'),
            line2: form.register('line2'),
            city: form.register('city'),
            region: form.register('region'),
            postalCode: form.register('postalCode'),
            country: form.register('country'),
          }}
        />
        <MutationError error={create.error} fallback="The invoice issuer could not be created." />
      </form>
    </Modal>
  );
}

export function EditBillingInvoiceBuyerDialog({
  organisationId,
  onClose,
}: {
  organisationId: string | null;
  onClose: () => void;
}) {
  const resolvedOrganisationId = organisationId ?? '';
  const buyer = useBillingInvoiceBuyerQuery(resolvedOrganisationId, Boolean(organisationId));
  const save = useSaveBillingInvoiceBuyerMutation();
  const form = useForm<BillingInvoiceBuyerFormValues>({
    resolver: zodResolver(BillingInvoiceBuyerFormSchema),
    defaultValues: emptyBuyer(resolvedOrganisationId),
  });
  const resetMutation = save.reset;

  useEffect(() => {
    if (!organisationId) return;
    form.reset(emptyBuyer(organisationId));
    resetMutation();
  }, [form, organisationId, resetMutation]);

  useEffect(() => {
    if (!organisationId || !buyer.data) return;
    form.reset(buyerValues(buyer.data));
  }, [buyer.data, form, organisationId]);

  function close() {
    form.reset(emptyBuyer(''));
    save.reset();
    onClose();
  }

  async function submit(values: BillingInvoiceBuyerFormValues) {
    await save.mutateAsync(values);
    close();
  }

  const loading = buyer.isPending && buyer.fetchStatus === 'fetching';

  return (
    <Modal
      isOpen={Boolean(organisationId)}
      onClose={close}
      title="Edit invoice buyer"
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            icon="check"
            variant="primary"
            disabled={loading || buyer.isError || save.isPending}
            onClick={form.handleSubmit(submit)}
          >
            {save.isPending ? 'Saving...' : 'Save buyer profile'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={form.handleSubmit(submit)}>
        <input type="hidden" {...form.register('organisationId')} />
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Organisation</p>
          <p className="mt-1 break-all font-mono text-xs text-gray-700">{organisationId}</p>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500">Loading the saved buyer profile...</p>
        ) : null}
        {buyer.data === null ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No buyer profile exists yet. Complete every required field to create one.
          </div>
        ) : null}
        {buyer.isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
            <p>
              The existing buyer profile could not be verified. Saving is disabled to prevent an
              accidental overwrite.
            </p>
            <Button className="mt-2" size="sm" onClick={() => void buyer.refetch()}>
              Retry loading
            </Button>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell label="Legal name" error={form.formState.errors.legalName?.message}>
            <TextField {...form.register('legalName')} autoComplete="organization" />
          </FieldShell>
          <FieldShell label="Billing email" error={form.formState.errors.billingEmail?.message}>
            <TextField {...form.register('billingEmail')} autoComplete="email" type="email" />
          </FieldShell>
          <FieldShell
            label="Tax identifier (optional)"
            error={form.formState.errors.taxIdentifier?.message}
          >
            <TextField {...form.register('taxIdentifier')} />
          </FieldShell>
          <FieldShell
            label="Purchase order reference (optional)"
            error={form.formState.errors.purchaseOrderReference?.message}
          >
            <TextField {...form.register('purchaseOrderReference')} />
          </FieldShell>
        </div>
        <AddressFields
          errors={{
            line1: form.formState.errors.line1?.message,
            line2: form.formState.errors.line2?.message,
            city: form.formState.errors.city?.message,
            region: form.formState.errors.region?.message,
            postalCode: form.formState.errors.postalCode?.message,
            country: form.formState.errors.country?.message,
          }}
          fields={{
            line1: form.register('line1'),
            line2: form.register('line2'),
            city: form.register('city'),
            region: form.register('region'),
            postalCode: form.register('postalCode'),
            country: form.register('country'),
          }}
        />
        <MutationError error={save.error} fallback="The buyer profile could not be saved." />
      </form>
    </Modal>
  );
}
