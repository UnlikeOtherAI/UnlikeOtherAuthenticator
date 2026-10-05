import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  billingCustomerInvoiceDetailV1ConformanceFixture,
  billingCustomerInvoicesListV1ConformanceFixture,
} from '../../src/contracts/billing-statement-v1.js';

const appKey = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const invoices = vi.hoisted(() => ({ listCustomerInvoices: vi.fn(),
  getCustomerInvoiceDetail: vi.fn(), downloadCustomerInvoice: vi.fn() }));
vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKey };
});
vi.mock('../../src/services/billing-customer-invoice-read.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-customer-invoice-read.service.js')
  >('../../src/services/billing-customer-invoice-read.service.js');
  return { ...actual, ...invoices };
});

const previousSecret = process.env.SHARED_SECRET;
const previousDatabaseUrl = process.env.DATABASE_URL;
const credential = { id: 'app_key_nessie', purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://nessie.example', actorAudience: 'https://uoa.example',
  actorKeyId: 'actor_key', actorPublicJwk: {}, checkoutReturnOrigins: [],
  service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' } };
const body = { product: 'nessie', organisation_id: 'org_example',
  team_id: 'team_example', user_id: 'user_example' };
const headers = { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' };

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});
afterAll(() => {
  if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  else process.env.SHARED_SECRET = previousSecret;
  if (previousDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
beforeEach(() => {
  vi.clearAllMocks();
  appKey.verifyBillingAppKey.mockResolvedValue(credential);
  invoices.listCustomerInvoices.mockResolvedValue(billingCustomerInvoicesListV1ConformanceFixture);
  invoices.getCustomerInvoiceDetail.mockResolvedValue(billingCustomerInvoiceDetailV1ConformanceFixture);
  invoices.downloadCustomerInvoice.mockResolvedValue({ bytes: Buffer.from('%PDF-1.7'),
    contentType: 'application/pdf', filename: 'invoice-UOA-1.pdf' });
});

async function withApp(callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
  const app = await createApp();
  await app.ready();
  try { await callback(app); } finally { await app.close(); }
}

describe('actual customer charge invoice routes', () => {
  it('negotiates display locale without changing the exact signed subject', async () => {
    await withApp(async (app) => {
      const reply = await app.inject({ method: 'POST', url: '/billing/v1/invoices/detail',
        headers: { ...headers, 'x-uoa-billing-presentation': '1.5.0', 'x-uoa-billing-locale': 'cs' },
        payload: { ...body, invoice_id: 'prepaid:one' } });
      expect(reply.statusCode).toBe(200);
      expect(invoices.getCustomerInvoiceDetail.mock.calls[0]?.[0]).toMatchObject({ locale: 'cs',
        request: { product: body.product, organisationId: body.organisation_id,
          teamId: body.team_id, userId: body.user_id } });
      const invalid = await app.inject({ method: 'POST', url: '/billing/v1/invoices/detail',
        headers: { ...headers, 'x-uoa-billing-presentation': '1.5.0', 'x-uoa-billing-locale': 'invalid' },
        payload: { ...body, invoice_id: 'prepaid:one' } });
      expect(invalid.statusCode).toBe(400);
    });
  });

  it('publishes the canonical contract and forwards exact actor audience per action', async () => {
    await withApp(async (app) => {
      for (const url of ['/schemas/billing-customer-invoices-v1.json',
        '/schemas/billing-customer-invoices-v1.example.json',
        '/schemas/billing-customer-invoices-v1.openapi.json']) {
        const reply = await app.inject({ method: 'GET', url });
        expect(reply.statusCode).toBe(200);
      }
      const list = await app.inject({ method: 'POST', url: '/billing/v1/invoices/list',
        headers, payload: { ...body, charge_month: '2026-10' } });
      expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toBe('private, no-store');
      expect(invoices.listCustomerInvoices).toHaveBeenCalledWith(expect.objectContaining({
        credential, actorToken: 'signed-actor', endpoint: '/billing/v1/invoices/list',
        request: { product: 'nessie', organisationId: 'org_example',
          teamId: 'team_example', userId: 'user_example' },
      }), { chargeMonth: '2026-10', limit: undefined, cursor: undefined });
      const detail = await app.inject({ method: 'POST', url: '/billing/v1/invoices/detail',
        headers, payload: { ...body, invoice_id: 'prepaid:one' } });
      expect(detail.statusCode).toBe(200);
      expect(invoices.getCustomerInvoiceDetail).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: '/billing/v1/invoices/detail' }),
        'prepaid:one', { chargeMonth: undefined });
      const selected = await app.inject({ method: 'POST', url: '/billing/v1/invoices/detail',
        headers, payload: { ...body, invoice_id: 'prepaid:one', charge_month: '2026-10' } });
      expect(selected.statusCode).toBe(200);
      expect(invoices.getCustomerInvoiceDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({ endpoint: '/billing/v1/invoices/detail' }),
        'prepaid:one', { chargeMonth: '2026-10' });
    });
  });

  it('requires an exact document ID and validates customer-safe response', async () => {
    await withApp(async (app) => {
      const missing = await app.inject({ method: 'POST', url: '/billing/v1/invoices/download',
        headers, payload: { ...body, invoice_id: 'prepaid:one' } });
      expect(missing.statusCode).not.toBe(200);
      expect(invoices.downloadCustomerInvoice).not.toHaveBeenCalled();
      const document = await app.inject({ method: 'POST', url: '/billing/v1/invoices/download',
        headers, payload: { ...body, invoice_id: 'prepaid:one', document_id: 'prepaid:one' } });
      expect(document.statusCode).toBe(200);
      expect(document.body).toBe('%PDF-1.7');
      invoices.getCustomerInvoiceDetail.mockResolvedValueOnce({
        ...billingCustomerInvoiceDetailV1ConformanceFixture, provider_cost: '10',
      });
      const unsafe = await app.inject({ method: 'POST', url: '/billing/v1/invoices/detail',
        headers, payload: { ...body, invoice_id: 'prepaid:one' } });
      expect(unsafe.statusCode).toBe(503);
    });
  });
});
