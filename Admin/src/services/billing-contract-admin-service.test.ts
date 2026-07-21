import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from './api-client';
import { billingContractAdminService } from './billing-contract-admin-service';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  getBlob: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('./api-client', () => {
  class MockApiRequestError extends Error {
    public constructor(public readonly status: number) {
      super(`Request failed with HTTP ${status}`);
    }
  }
  return { ApiRequestError: MockApiRequestError, createApiClient: () => api };
});

const address = {
  line1: '1 Example Street',
  city: 'London',
  postal_code: 'N1 1AA',
  country: 'GB',
};

const version = {
  id: 'version/1',
  version: 1,
  usage_markup_bps: 4000,
  usage_markup_percent: '40.00',
  currency: 'USD',
  payment_terms_days: 30,
  effective_from_month: '2026-07',
  services: [
    {
      service_id: 'service-1',
      service_identifier: 'deepwater',
      service_name: 'DeepWater',
      tariff_id: 'tariff-1',
      monthly_amount_minor: '5000',
      monthly_price: {
        amount_minor: '5000',
        amount: '50',
        currency: 'USD',
        display: '$50.00',
      },
    },
  ],
  actions: { activation_state: 'active', activate: false },
  created_at: '2026-07-01T00:00:00.000Z',
};

const contract = {
  id: 'contract/1',
  organisation_id: 'org/1',
  organisation_name: null,
  reference: 'MSA-2026-001',
  name: 'Enterprise AI services',
  status: 'active',
  activated_at: '2026-07-01T00:00:00.000Z',
  terminated_at: null,
  versions: [version],
  actions: { add_version: true },
  created_at: '2026-06-20T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const issuer = {
  id: 'issuer-1',
  key: 'uoa-uk',
  legal_name: 'Unlike Other AI Ltd',
  trading_name: null,
  billing_email: 'billing@unlikeotherai.com',
  address,
  tax_identifier: null,
  company_registration_number: null,
  invoice_number_prefix: 'UOA',
  active: true,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const buyer = {
  id: 'buyer-1',
  organisation_id: 'org/1',
  legal_name: 'Customer Ltd',
  billing_email: 'accounts@customer.example',
  billing_address: address,
  tax_identifier: null,
  purchase_order_reference: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

function money(amountMinor: string, display: string) {
  return {
    amount_minor: amountMinor,
    amount: String(Number(amountMinor) / 100),
    currency: 'USD',
    display,
  };
}

const invoice = {
  id: 'invoice/1',
  organisation_id: 'org/1',
  contract_id: 'contract/1',
  contract_version_id: 'version/1',
  billing_month: '2026-07',
  revision: 1,
  status: 'draft',
  invoice_number: null,
  issue_date: null,
  due_date: null,
  issued_at: null,
  voided_at: null,
  void_reason: null,
  currency: 'USD',
  issuer: {
    profile_id: issuer.id,
    legal_name: issuer.legal_name,
    trading_name: null,
    billing_email: issuer.billing_email,
    address,
    tax_identifier: null,
    company_registration_number: null,
  },
  buyer: {
    profile_id: buyer.id,
    legal_name: buyer.legal_name,
    billing_email: buyer.billing_email,
    billing_address: address,
    tax_identifier: null,
    purchase_order_reference: null,
  },
  lines: [
    {
      id: 'line-1',
      service: { identifier: 'deepwater', name: 'DeepWater' },
      price: money('6250', '$62.50'),
    },
  ],
  separately_billed_add_ons: [],
  totals: {
    subtotal: money('6250', '$62.50'),
    tax: money('0', '$0.00'),
    total: money('6250', '$62.50'),
    credits_applied: money('0', '$0.00'),
    paid: money('0', '$0.00'),
    written_off: money('0', '$0.00'),
    outstanding: money('6250', '$62.50'),
  },
  payment_status: 'open',
  actions: {
    issue: 'issue',
    download_pdf: false,
    void: false,
    payment_limits: { payment: null, refund: null, write_off: null },
  },
  payments: [],
  created_at: '2026-07-21T00:00:00.000Z',
};

describe('billingContractAdminService', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });

  it('maps contract list, create, version, and activation requests exactly', async () => {
    api.get.mockResolvedValueOnce([contract]);
    api.post
      .mockResolvedValueOnce(contract)
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(version);

    await expect(billingContractAdminService.listContracts('org/1')).resolves.toEqual([contract]);
    await billingContractAdminService.createContract({
      organisationId: 'org/1',
      reference: 'MSA-2026-001',
      name: 'Enterprise AI services',
    });
    await billingContractAdminService.createVersion('contract/1', {
      usageMarkupBps: 4000,
      currency: 'USD',
      paymentTermsDays: 30,
      effectiveFromMonth: '2026-07',
    });
    await billingContractAdminService.activateVersion('contract/1', 'version/1', [
      { serviceId: 'service-1', monthlyAmountMinor: '5000' },
    ]);

    expect(api.get).toHaveBeenCalledWith(
      '/internal/admin/billing/contracts?organisation_id=org%2F1',
    );
    expect(api.post).toHaveBeenNthCalledWith(1, '/internal/admin/billing/contracts', {
      organisation_id: 'org/1',
      reference: 'MSA-2026-001',
      name: 'Enterprise AI services',
    });
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/internal/admin/billing/contracts/contract%2F1/versions',
      {
        usage_markup_bps: 4000,
        currency: 'USD',
        payment_terms_days: 30,
        effective_from_month: '2026-07',
      },
    );
    expect(api.post).toHaveBeenNthCalledWith(
      3,
      '/internal/admin/billing/contracts/contract%2F1/versions/version%2F1/activate',
      { services: [{ service_id: 'service-1', monthly_amount_minor: '5000' }] },
    );
  });

  it('preserves nullable profile fields and maps blank optional form fields to null', async () => {
    api.get.mockResolvedValueOnce([issuer]).mockResolvedValueOnce(buyer);
    api.post.mockResolvedValueOnce(issuer);
    api.put.mockResolvedValueOnce(buyer);

    await expect(billingContractAdminService.listIssuerProfiles()).resolves.toEqual([issuer]);
    await expect(billingContractAdminService.getBuyerProfile('org/1')).resolves.toEqual(buyer);
    await billingContractAdminService.createIssuerProfile({
      key: 'uoa-uk',
      legalName: 'Unlike Other AI Ltd',
      tradingName: ' ',
      billingEmail: 'billing@unlikeotherai.com',
      line1: address.line1,
      line2: '',
      city: address.city,
      region: '',
      postalCode: address.postal_code,
      country: address.country,
      taxIdentifier: '',
      companyRegistrationNumber: '',
      invoiceNumberPrefix: 'UOA',
    });
    await billingContractAdminService.saveBuyerProfile({
      organisationId: 'org/1',
      legalName: 'Customer Ltd',
      billingEmail: 'accounts@customer.example',
      line1: address.line1,
      line2: '',
      city: address.city,
      region: '',
      postalCode: address.postal_code,
      country: address.country,
      taxIdentifier: '',
      purchaseOrderReference: '',
    });

    expect(api.get).toHaveBeenNthCalledWith(
      2,
      '/internal/admin/billing/organisations/org%2F1/invoice-profile',
    );
    expect(api.post).toHaveBeenCalledWith('/internal/admin/billing/invoice-issuer-profiles', {
      key: 'uoa-uk',
      legal_name: 'Unlike Other AI Ltd',
      trading_name: null,
      billing_email: 'billing@unlikeotherai.com',
      address,
      tax_identifier: null,
      company_registration_number: null,
      invoice_number_prefix: 'UOA',
    });
    expect(api.put).toHaveBeenCalledWith(
      '/internal/admin/billing/organisations/org%2F1/invoice-profile',
      {
        legal_name: 'Customer Ltd',
        billing_email: 'accounts@customer.example',
        billing_address: address,
        tax_identifier: null,
        purchase_order_reference: null,
      },
    );
  });

  it('treats only an explicit 404 as a missing buyer profile', async () => {
    api.get
      .mockRejectedValueOnce(new ApiRequestError(404))
      .mockRejectedValueOnce(new ApiRequestError(500));

    await expect(billingContractAdminService.getBuyerProfile('org/1')).resolves.toBeNull();
    await expect(billingContractAdminService.getBuyerProfile('org/1')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('calculates and lists only the parsed customer-safe invoice projection', async () => {
    api.post.mockResolvedValueOnce({
      ...invoice,
      raw_provider_cost: '41.12',
      usage_markup_bps: 4000,
      token_count: '987654',
    });
    api.get.mockResolvedValueOnce([invoice]);

    const calculated = await billingContractAdminService.calculateInvoice({
      contractId: 'contract/1',
      issuerProfileId: 'issuer/1',
      billingMonth: '2026-07',
    });
    await expect(billingContractAdminService.listInvoices()).resolves.toEqual([invoice]);

    expect(api.post).toHaveBeenCalledWith('/internal/admin/billing/invoices/calculate', {
      contract_id: 'contract/1',
      issuer_profile_id: 'issuer/1',
      billing_month: '2026-07',
    });
    expect(calculated).toEqual(invoice);
    expect(JSON.stringify(calculated)).not.toMatch(/provider_cost|usage_markup|token_count/);
  });

  it('maps issue, PDF, void, and payment lifecycle actions without browser-added pricing data', async () => {
    const pdf = new Blob(['%PDF']);
    api.post.mockResolvedValue(invoice);
    api.getBlob.mockResolvedValue(pdf);

    await billingContractAdminService.issueInvoice('invoice/1');
    await expect(billingContractAdminService.downloadInvoicePdf('invoice/1')).resolves.toBe(pdf);
    await billingContractAdminService.voidInvoice('invoice/1', 'Customer request');
    await billingContractAdminService.recordPayment('invoice/1', {
      kind: 'payment',
      amountMinor: '2500',
      currency: 'USD',
      idempotencyKey: 'payment-1',
      reference: '',
      occurredAt: '2026-07-21T12:30:00.000Z',
    });

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      '/internal/admin/billing/invoices/invoice%2F1/issue',
      {},
    );
    expect(api.getBlob).toHaveBeenCalledWith('/internal/admin/billing/invoices/invoice%2F1/pdf');
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/internal/admin/billing/invoices/invoice%2F1/void',
      { reason: 'Customer request' },
    );
    expect(api.post).toHaveBeenNthCalledWith(
      3,
      '/internal/admin/billing/invoices/invoice%2F1/payments',
      {
        kind: 'payment',
        amount_minor: '2500',
        currency: 'USD',
        idempotency_key: 'payment-1',
        reference: null,
        occurred_at: '2026-07-21T12:30:00.000Z',
      },
    );
    for (const [, body] of api.post.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(body).not.toHaveProperty('raw_provider_cost');
      expect(body).not.toHaveProperty('usage_markup_bps');
      expect(body).not.toHaveProperty('token_count');
    }
  });

  it('rejects malformed API responses instead of inventing invoice totals', async () => {
    api.post.mockResolvedValue({
      ...invoice,
      totals: { ...invoice.totals, total: { amount_minor: '6250', currency: 'USD' } },
    });

    await expect(
      billingContractAdminService.calculateInvoice({
        contractId: 'contract-1',
        issuerProfileId: 'issuer-1',
        billingMonth: '2026-07',
      }),
    ).rejects.toThrow();
  });
});
