import {
  BillingContractSchema,
  BillingContractVersionSchema,
  BillingInvoiceBuyerProfileSchema,
  BillingInvoiceIssuerProfileSchema,
  BillingInvoiceSchema,
  type BillingContractFormValues,
  type BillingContractVersionFormValues,
  type BillingInvoiceBuyerFormValues,
  type BillingInvoiceCalculateFormValues,
  type BillingInvoiceIssuerFormValues,
  type BillingInvoicePaymentFormValues,
} from '../schemas/billing-contracts';
import { ApiRequestError, createApiClient } from './api-client';

const api = createApiClient();

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function address(input: {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}) {
  return {
    line1: input.line1,
    ...(input.line2 ? { line2: input.line2 } : {}),
    city: input.city,
    ...(input.region ? { region: input.region } : {}),
    postal_code: input.postalCode,
    country: input.country,
  };
}

export const billingContractAdminService = {
  async listContracts(organisationId?: string) {
    const query = organisationId ? `?organisation_id=${encodeURIComponent(organisationId)}` : '';
    return BillingContractSchema.array().parse(
      await api.get<unknown>(`/internal/admin/billing/contracts${query}`),
    );
  },

  async createContract(input: BillingContractFormValues) {
    return BillingContractSchema.parse(
      await api.post<unknown>('/internal/admin/billing/contracts', {
        organisation_id: input.organisationId,
        reference: input.reference,
        name: input.name,
      }),
    );
  },

  async createVersion(contractId: string, input: BillingContractVersionFormValues) {
    return BillingContractVersionSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/contracts/${encodeURIComponent(contractId)}/versions`,
        {
          usage_markup_bps: input.usageMarkupBps,
          currency: input.currency,
          payment_terms_days: input.paymentTermsDays,
          effective_from_month: input.effectiveFromMonth,
        },
      ),
    );
  },

  async activateVersion(
    contractId: string,
    versionId: string,
    services: Array<{ serviceId: string; monthlyAmountMinor: string }>,
  ) {
    return BillingContractVersionSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}/activate`,
        {
          services: services.map((service) => ({
            service_id: service.serviceId,
            monthly_amount_minor: service.monthlyAmountMinor,
          })),
        },
      ),
    );
  },

  async listIssuerProfiles() {
    return BillingInvoiceIssuerProfileSchema.array().parse(
      await api.get<unknown>('/internal/admin/billing/invoice-issuer-profiles'),
    );
  },

  async createIssuerProfile(input: BillingInvoiceIssuerFormValues) {
    return BillingInvoiceIssuerProfileSchema.parse(
      await api.post<unknown>('/internal/admin/billing/invoice-issuer-profiles', {
        key: input.key,
        legal_name: input.legalName,
        trading_name: optional(input.tradingName),
        billing_email: input.billingEmail,
        address: address(input),
        tax_identifier: optional(input.taxIdentifier),
        company_registration_number: optional(input.companyRegistrationNumber),
        invoice_number_prefix: input.invoiceNumberPrefix,
      }),
    );
  },

  async getBuyerProfile(organisationId: string) {
    try {
      return BillingInvoiceBuyerProfileSchema.parse(
        await api.get<unknown>(
          `/internal/admin/billing/organisations/${encodeURIComponent(organisationId)}/invoice-profile`,
        ),
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  },

  async saveBuyerProfile(input: BillingInvoiceBuyerFormValues) {
    return BillingInvoiceBuyerProfileSchema.parse(
      await api.put<unknown>(
        `/internal/admin/billing/organisations/${encodeURIComponent(input.organisationId)}/invoice-profile`,
        {
          legal_name: input.legalName,
          billing_email: input.billingEmail,
          billing_address: address(input),
          tax_identifier: optional(input.taxIdentifier),
          purchase_order_reference: optional(input.purchaseOrderReference),
        },
      ),
    );
  },

  async calculateInvoice(input: BillingInvoiceCalculateFormValues) {
    return BillingInvoiceSchema.parse(
      await api.post<unknown>('/internal/admin/billing/invoices/calculate', {
        contract_id: input.contractId,
        issuer_profile_id: input.issuerProfileId,
        billing_month: input.billingMonth,
      }),
    );
  },

  async listInvoices() {
    return BillingInvoiceSchema.array().parse(
      await api.get<unknown>('/internal/admin/billing/invoices'),
    );
  },

  async issueInvoice(invoiceId: string) {
    return BillingInvoiceSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/invoices/${encodeURIComponent(invoiceId)}/issue`,
        {},
      ),
    );
  },

  async downloadInvoicePdf(invoiceId: string) {
    return api.getBlob(`/internal/admin/billing/invoices/${encodeURIComponent(invoiceId)}/pdf`);
  },

  async voidInvoice(invoiceId: string, reason: string) {
    return BillingInvoiceSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/invoices/${encodeURIComponent(invoiceId)}/void`,
        { reason },
      ),
    );
  },

  async recordPayment(invoiceId: string, input: BillingInvoicePaymentFormValues) {
    return BillingInvoiceSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/invoices/${encodeURIComponent(invoiceId)}/payments`,
        {
          kind: input.kind,
          amount_minor: input.amountMinor,
          currency: input.currency,
          idempotency_key: input.idempotencyKey,
          reference: optional(input.reference),
          occurred_at: new Date(input.occurredAt).toISOString(),
        },
      ),
    );
  },
};
