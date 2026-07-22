import { BillingInvoiceStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const services = vi.hoisted(() => ({
  listBillingContracts: vi.fn(),
  resolveBillingInvoiceIssueActions: vi.fn(),
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
      adminAccessTokenClaims?: { userId: string; email: string; tokenVersion: number };
    },
    reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== 'Bearer admin-token') {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    request.adminAccessTokenClaims = {
      userId: 'admin_1',
      email: 'admin@example.com',
      tokenVersion: 3,
    };
  },
}));

vi.mock('../../src/services/billing-contract.service.js', () => ({
  activateBillingContractVersion: vi.fn(),
  createBillingContract: vi.fn(),
  createBillingContractVersion: vi.fn(),
  listBillingContracts: services.listBillingContracts,
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

vi.mock('../../src/services/billing-invoice-action-readiness.service.js', () => ({
  resolveBillingInvoiceIssueActions: services.resolveBillingInvoiceIssueActions,
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
  pdfObjectKey: null,
  pdfSha256: null,
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
  addonLines: [],
  paymentEvents: [],
  issuerProfile: { active: true },
  _count: { creditSettlementRefs: 0 },
};

describe('contract invoice admin routes', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    services.calculateBillingContractInvoice.mockResolvedValue(invoice);
    services.resolveBillingInvoiceIssueActions.mockImplementation(
      async (invoices: Array<{ id: string; status: BillingInvoiceStatus }>) =>
        new Map(
          invoices.map((value) => [
            value.id,
            value.status === BillingInvoiceStatus.DRAFT ? 'issue' : null,
          ]),
        ),
    );
    services.listBillingContracts.mockResolvedValue([]);
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

  it('projects exact contract and version action readiness from authoritative state', async () => {
    const baseVersion = {
      usageMarkupBps: 4000,
      currency: 'USD',
      paymentTermsDays: 30,
      createdAt: now,
      serviceTerms: [],
    };
    services.listBillingContracts.mockResolvedValue([
      {
        id: 'contract_1',
        orgId: 'org_1',
        reference: 'msa-1',
        name: 'Active contract',
        status: 'ACTIVE',
        activatedAt: now,
        terminatedAt: null,
        createdAt: now,
        updatedAt: now,
        org: { name: 'Acme' },
        versions: [
          {
            ...baseVersion,
            id: 'version_future',
            version: 4,
            effectiveFromMonth: '9999-12',
          },
          {
            ...baseVersion,
            id: 'version_ready',
            version: 3,
            effectiveFromMonth: '2000-03',
          },
          {
            ...baseVersion,
            id: 'version_active',
            version: 2,
            effectiveFromMonth: '2000-02',
            serviceTerms: [
              {
                serviceId: 'service_1',
                tariffId: 'tariff_1',
                monthlyAmountMinor: 5000n,
                service: { identifier: 'deepwater', name: 'DeepWater' },
              },
            ],
          },
          {
            ...baseVersion,
            id: 'version_old',
            version: 1,
            effectiveFromMonth: '2000-01',
            serviceTerms: [
              {
                serviceId: 'service_1',
                tariffId: 'tariff_old',
                monthlyAmountMinor: 2500n,
                service: { identifier: 'deepwater', name: 'DeepWater' },
              },
            ],
          },
        ],
      },
      {
        id: 'contract_terminated',
        orgId: 'org_2',
        reference: 'msa-2',
        name: 'Terminated contract',
        status: 'TERMINATED',
        activatedAt: now,
        terminatedAt: now,
        createdAt: now,
        updatedAt: now,
        org: { name: 'Former customer' },
        versions: [
          {
            ...baseVersion,
            id: 'version_terminated_draft',
            version: 1,
            effectiveFromMonth: '2000-01',
          },
        ],
      },
    ]);

    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/billing/contracts',
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body[0].actions).toEqual({ add_version: true });
      expect(
        Object.fromEntries(
          body[0].versions.map((version: { id: string; actions: unknown }) => [
            version.id,
            version.actions,
          ]),
        ),
      ).toEqual({
        version_future: { activation_state: 'scheduled', activate: false },
        version_ready: { activation_state: 'ready', activate: true },
        version_active: { activation_state: 'active', activate: false },
        version_old: { activation_state: 'superseded', activate: false },
      });
      expect(body[1].actions).toEqual({ add_version: false });
      expect(body[1].versions[0].actions).toEqual({
        activation_state: 'contract_terminated',
        activate: false,
      });
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
      expect(body.actions.issue).toBe('issue');
      expect(services.resolveBillingInvoiceIssueActions).toHaveBeenCalledWith([invoice]);
      expect(JSON.stringify(body)).not.toMatch(
        /provider_cost|SECRET_PROVIDER_COST|ledger_cursor|SECRET_CURSOR/,
      );
      expect(services.calculateBillingContractInvoice).toHaveBeenCalledWith({
        contractId: 'contract_1',
        issuerProfileId: 'issuer_1',
        billingMonth: '2026-06',
        actor: { userId: 'admin_1', tokenVersion: 3, email: 'admin@example.com' },
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
