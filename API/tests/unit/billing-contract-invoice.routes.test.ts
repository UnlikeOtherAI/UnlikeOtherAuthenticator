import { BillingInvoiceStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const services = vi.hoisted(() => ({
  calculateBillingContractInvoice: vi.fn(),
  getBillingInvoice: vi.fn(),
  issueBillingInvoice: vi.fn(),
  listBillingInvoices: vi.fn(),
  readBillingInvoicePdf: vi.fn(),
  recordBillingInvoicePayment: vi.fn(),
  voidBillingInvoice: vi.fn(),
}));

vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (
    request: {
      headers: { authorization?: string };
      adminAccessTokenClaims?: { userId: string; email: string };
    },
    reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    request.adminAccessTokenClaims = { userId: 'admin_1', email: 'admin@example.com' };
  },
}));

vi.mock('../../src/services/billing-contract.service.js', () => ({
  activateBillingContractVersion: vi.fn(),
  createBillingContract: vi.fn(),
  createBillingContractVersion: vi.fn(),
  listBillingContracts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/billing-invoice-profile.service.js', () => ({
  createBillingInvoiceIssuerProfile: vi.fn(),
  getOrganisationInvoiceProfile: vi.fn(),
  listBillingInvoiceIssuerProfiles: vi.fn().mockResolvedValue([]),
  upsertOrganisationInvoiceProfile: vi.fn(),
}));

vi.mock('../../src/services/billing-invoice-calculation.service.js', () => ({
  calculateBillingContractInvoice: services.calculateBillingContractInvoice,
}));

vi.mock('../../src/services/billing-invoice-lifecycle.service.js', () => ({
  getBillingInvoice: services.getBillingInvoice,
  issueBillingInvoice: services.issueBillingInvoice,
  listBillingInvoices: services.listBillingInvoices,
  readBillingInvoicePdf: services.readBillingInvoicePdf,
  recordBillingInvoicePayment: services.recordBillingInvoicePayment,
  voidBillingInvoice: services.voidBillingInvoice,
}));

const now = new Date('2026-07-21T12:00:00.000Z');
const invoice = {
  id: 'invoice_1',
  orgId: 'org_1',
  contractId: 'contract_1',
  contractVersionId: 'version_1',
  billingMonth: '2026-06',
  revision: 1,
  status: BillingInvoiceStatus.DRAFT,
  invoiceNumber: null,
  issueDate: null,
  dueDate: null,
  currency: 'USD',
  subtotalMinor: 6250n,
  taxAmountMinor: 0n,
  totalMinor: 6250n,
  creditsAppliedMinor: 0n,
  issuerSnapshot: {
    profile_id: 'issuer_1',
    legal_name: 'Unlike Other AI Ltd',
    trading_name: null,
    billing_email: 'billing@example.com',
    address: { line1: '1 Example St', city: 'London', postal_code: 'N1 1AA', country: 'GB' },
    tax_identifier: null,
    company_registration_number: null,
    provider_cost: 'SECRET_PROVIDER_COST',
  },
  buyerSnapshot: {
    profile_id: 'buyer_1',
    legal_name: 'Customer Ltd',
    billing_email: 'ap@customer.example',
    billing_address: {
      line1: '2 Customer Rd',
      city: 'Bristol',
      postal_code: 'BS1 1AA',
      country: 'GB',
    },
    tax_identifier: null,
    purchase_order_reference: null,
    ledger_cursor: 'SECRET_CURSOR',
  },
  issuedAt: null,
  voidedAt: null,
  voidReason: null,
  createdAt: now,
  lines: [
    {
      id: 'line_1',
      serviceIdentifier: 'deepwater',
      serviceName: 'DeepWater',
      amountMinor: 6250n,
      currency: 'USD',
      position: 1,
    },
  ],
  paymentEvents: [],
};

describe('contract invoice admin routes', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    services.calculateBillingContractInvoice.mockResolvedValue(invoice);
    services.listBillingInvoices.mockResolvedValue([invoice]);
    services.readBillingInvoicePdf.mockResolvedValue({
      value: Buffer.from('%PDF-private-invoice'),
      filename: 'UOA-2026-000001.pdf',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSharedSecret;
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('requires a superuser before listing invoices', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/billing/invoices',
      });
      expect(response.statusCode).toBe(401);
      expect(services.listBillingInvoices).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns only final per-service prices from the calculator boundary', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/invoices/calculate',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          contract_id: 'contract_1',
          issuer_profile_id: 'issuer_1',
          billing_month: '2026-06',
        },
      });
      const body = response.json();
      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(body.lines).toEqual([
        {
          id: 'line_1',
          service: { identifier: 'deepwater', name: 'DeepWater' },
          price: { amount_minor: '6250', amount: '62.5', currency: 'USD', display: '$62.5' },
        },
      ]);
      expect(JSON.stringify(body)).not.toMatch(
        /provider_cost|SECRET_PROVIDER_COST|ledger_cursor|SECRET_CURSOR/,
      );
      expect(services.calculateBillingContractInvoice).toHaveBeenCalledWith({
        contractId: 'contract_1',
        issuerProfileId: 'issuer_1',
        billingMonth: '2026-06',
        actor: { userId: 'admin_1', email: 'admin@example.com' },
      });
    } finally {
      await app.close();
    }
  });

  it('downloads invoice PDFs privately with a sanitized attachment filename', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/billing/invoices/invoice_1/pdf',
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="UOA-2026-000001.pdf"',
      );
      expect(response.rawPayload).toEqual(Buffer.from('%PDF-private-invoice'));
    } finally {
      await app.close();
    }
  });
});
