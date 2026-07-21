import { z } from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(256);
const MoneySchema = z.object({
  amount_minor: z.string().regex(/^-?(0|[1-9]\d*)$/),
  amount: z.string(),
  currency: z.string().length(3),
  display: z.string(),
});

export const InvoiceAddressSchema = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postal_code: z.string(),
  country: z.string().length(2),
});

export const BillingContractVersionSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  usage_markup_bps: z.number().int().nonnegative(),
  usage_markup_percent: z.string(),
  currency: z.string().length(3),
  payment_terms_days: z.number().int().nonnegative(),
  effective_from_month: z.string(),
  services: z.array(
    z.object({
      service_id: z.string(),
      service_identifier: z.string().nullable(),
      service_name: z.string().nullable(),
      tariff_id: z.string(),
      monthly_amount_minor: z.string(),
      monthly_price: MoneySchema,
    }),
  ),
  actions: z.object({
    activation_state: z.enum(['active', 'ready', 'scheduled', 'superseded', 'contract_terminated']),
    activate: z.boolean(),
  }),
  created_at: z.string(),
});

export const BillingContractSchema = z.object({
  id: z.string(),
  organisation_id: z.string(),
  organisation_name: z.string().nullable(),
  reference: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'active', 'terminated']),
  activated_at: z.string().nullable(),
  terminated_at: z.string().nullable(),
  versions: z.array(BillingContractVersionSchema),
  actions: z.object({ add_version: z.boolean() }),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BillingInvoiceIssuerProfileSchema = z.object({
  id: z.string(),
  key: z.string(),
  legal_name: z.string(),
  trading_name: z.string().nullable(),
  billing_email: z.string().email(),
  address: InvoiceAddressSchema,
  tax_identifier: z.string().nullable(),
  company_registration_number: z.string().nullable(),
  invoice_number_prefix: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BillingInvoiceBuyerProfileSchema = z.object({
  id: z.string(),
  organisation_id: z.string(),
  legal_name: z.string(),
  billing_email: z.string().email(),
  billing_address: InvoiceAddressSchema,
  tax_identifier: z.string().nullable(),
  purchase_order_reference: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const InvoiceIssuerPartySchema = z.object({
  profile_id: z.string(),
  legal_name: z.string(),
  trading_name: z.string().nullable(),
  billing_email: z.string().email(),
  address: InvoiceAddressSchema,
  tax_identifier: z.string().nullable(),
  company_registration_number: z.string().nullable(),
});

const InvoiceBuyerPartySchema = z.object({
  profile_id: z.string(),
  legal_name: z.string(),
  billing_email: z.string().email(),
  billing_address: InvoiceAddressSchema,
  tax_identifier: z.string().nullable(),
  purchase_order_reference: z.string().nullable(),
});

export const BillingInvoiceSchema = z.object({
  id: z.string(),
  organisation_id: z.string(),
  contract_id: z.string(),
  contract_version_id: z.string(),
  billing_month: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'issuing', 'issued', 'void']),
  invoice_number: z.string().nullable(),
  issue_date: z.string().nullable(),
  due_date: z.string().nullable(),
  issued_at: z.string().nullable(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  currency: z.string().length(3),
  issuer: InvoiceIssuerPartySchema,
  buyer: InvoiceBuyerPartySchema,
  lines: z.array(
    z.object({
      id: z.string(),
      service: z.object({ identifier: z.string(), name: z.string() }),
      price: MoneySchema,
    }),
  ),
  separately_billed_add_ons: z.array(
    z.object({
      id: z.string(),
      service: z.object({ identifier: z.string(), name: z.string() }),
      offer: z.object({ key: z.string(), name: z.string() }),
      scope: z.enum(['organisation', 'team', 'subscribing_user']),
      collection: z.literal('collected_separately'),
      monthly_price: MoneySchema,
      note: z.literal('Collected separately; not included in this invoice total.'),
    }),
  ),
  totals: z.object({
    subtotal: MoneySchema,
    tax: MoneySchema,
    total: MoneySchema,
    credits_applied: MoneySchema,
    paid: MoneySchema,
    written_off: MoneySchema,
    outstanding: MoneySchema,
  }),
  payment_status: z.enum(['open', 'partially_paid', 'paid', 'void']),
  actions: z.object({
    issue: z.enum(['issue', 'resume_issue']).nullable(),
    download_pdf: z.boolean(),
    void: z.boolean(),
    payment_limits: z.object({
      payment: MoneySchema.nullable(),
      refund: MoneySchema.nullable(),
      write_off: MoneySchema.nullable(),
    }),
  }),
  payments: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['payment', 'refund', 'write_off']),
      source: z.literal('manual'),
      amount: MoneySchema,
      reference: z.string().nullable(),
      occurred_at: z.string(),
      recorded_at: z.string(),
    }),
  ),
  created_at: z.string(),
});

const AddressFormFields = {
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120),
  postalCode: z.string().trim().min(1).max(32),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
};

export const BillingContractFormSchema = z.object({
  organisationId: IdentifierSchema,
  reference: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().trim().min(1).max(160),
});

export const BillingContractVersionFormSchema = z.object({
  usageMarkupBps: z.coerce.number().int().min(0).max(100_000),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  effectiveFromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export const BillingInvoiceIssuerFormSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  legalName: z.string().trim().min(1).max(200),
  tradingName: z.string().trim().max(200),
  billingEmail: z.string().trim().email(),
  ...AddressFormFields,
  taxIdentifier: z.string().trim().max(100),
  companyRegistrationNumber: z.string().trim().max(100),
  invoiceNumberPrefix: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
});

export const BillingInvoiceBuyerFormSchema = z.object({
  organisationId: IdentifierSchema,
  legalName: z.string().trim().min(1).max(200),
  billingEmail: z.string().trim().email(),
  ...AddressFormFields,
  taxIdentifier: z.string().trim().max(100),
  purchaseOrderReference: z.string().trim().max(120),
});

export const BillingInvoiceCalculateFormSchema = z.object({
  contractId: IdentifierSchema,
  issuerProfileId: IdentifierSchema,
  billingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export const BillingInvoicePaymentFormSchema = z.object({
  kind: z.enum(['payment', 'refund', 'write_off']),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  idempotencyKey: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(255),
  occurredAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
});

export type BillingContract = z.infer<typeof BillingContractSchema>;
export type BillingContractVersion = z.infer<typeof BillingContractVersionSchema>;
export type BillingInvoice = z.infer<typeof BillingInvoiceSchema>;
export type BillingInvoiceIssuerProfile = z.infer<typeof BillingInvoiceIssuerProfileSchema>;
export type BillingInvoiceBuyerProfile = z.infer<typeof BillingInvoiceBuyerProfileSchema>;
export type BillingContractFormValues = z.infer<typeof BillingContractFormSchema>;
export type BillingContractVersionFormValues = z.infer<typeof BillingContractVersionFormSchema>;
export type BillingInvoiceIssuerFormValues = z.infer<typeof BillingInvoiceIssuerFormSchema>;
export type BillingInvoiceBuyerFormValues = z.infer<typeof BillingInvoiceBuyerFormSchema>;
export type BillingInvoiceCalculateFormValues = z.infer<typeof BillingInvoiceCalculateFormSchema>;
export type BillingInvoicePaymentFormValues = z.infer<typeof BillingInvoicePaymentFormSchema>;
