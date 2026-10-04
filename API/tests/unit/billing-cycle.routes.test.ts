import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  billingCycleDetailV1ConformanceFixture,
  billingCyclesListV1ConformanceFixture,
} from '../../src/contracts/billing-statement-v1.js';

const appKey = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const cycles = vi.hoisted(() => ({
  listBillingCycles: vi.fn(), getBillingCycleDetail: vi.fn(),
  downloadBillingCycleDocument: vi.fn(),
}));
vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKey };
});
vi.mock('../../src/services/billing-cycle-read.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-cycle-read.service.js')
  >('../../src/services/billing-cycle-read.service.js');
  return { ...actual, ...cycles };
});

const originalSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app_key_deepwater', purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1', actorPublicJwk: {}, checkoutReturnOrigins: [],
  service: { id: 'service_example', identifier: 'deepwater', name: 'DeepWater' },
};
const body = {
  product: 'deepwater', organisation_id: 'org_example',
  team_id: 'team_example', user_id: 'user_example',
};

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});
afterAll(() => {
  if (originalSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  else process.env.SHARED_SECRET = originalSecret;
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = originalDatabaseUrl;
});
beforeEach(() => {
  vi.clearAllMocks();
  appKey.verifyBillingAppKey.mockResolvedValue(credential);
  cycles.listBillingCycles.mockResolvedValue(billingCyclesListV1ConformanceFixture);
  cycles.getBillingCycleDetail.mockResolvedValue(billingCycleDetailV1ConformanceFixture);
  cycles.downloadBillingCycleDocument.mockResolvedValue({
    bytes: Buffer.from('%PDF-1.7'), contentType: 'application/pdf',
    filename: 'billing-2026-07-monthly_invoice.pdf',
  });
});

async function withApp(callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
  const app = await createApp();
  await app.ready();
  try { await callback(app); } finally { await app.close(); }
}

const headers = { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' };

describe('customer billing cycle routes', () => {
  it('publishes strict public schema, fixture, and OpenAPI without credentials', async () => {
    await withApp(async (app) => {
      const urls = ['/schemas/billing-cycles-v1.json',
        '/schemas/billing-cycles-v1.example.json',
        '/schemas/billing-cycles-v1.openapi.json'];
      const results = await Promise.all(urls.map((url) => app.inject({ method: 'GET', url })));
      expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200]);
      expect(results[0]!.json()).toMatchObject({ $id: '/schemas/billing-cycles-v1.json' });
      expect(results[1]!.json()).toMatchObject({ detail: { schema_version: 1 } });
      expect(results[2]!.json()).toMatchObject({ openapi: '3.1.0' });
    });
  });

  it('forwards exact product and actor on list/detail, with no-store responses', async () => {
    await withApp(async (app) => {
      const list = await app.inject({ method: 'POST', url: '/billing/v1/cycles/list',
        headers, payload: body });
      expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toBe('private, no-store');
      expect(cycles.listBillingCycles).toHaveBeenCalledWith(expect.objectContaining({
        credential, actorToken: 'signed-actor', endpoint: '/billing/v1/cycles/list',
        request: { product: 'deepwater', organisationId: 'org_example',
          teamId: 'team_example', userId: 'user_example' },
      }), { limit: undefined, cursor: undefined });
      const detail = await app.inject({ method: 'POST', url: '/billing/v1/cycles/detail',
        headers, payload: { ...body, cycle_id: 'cycle_example_2026_07' } });
      expect(detail.statusCode).toBe(200);
      expect(cycles.getBillingCycleDetail).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: '/billing/v1/cycles/detail',
      }), 'cycle_example_2026_07');
    });
  });

  it('rejects unscoped downloads and streams an exact server-selected document', async () => {
    await withApp(async (app) => {
      const missing = await app.inject({ method: 'POST', url: '/billing/v1/cycles/download',
        headers, payload: { ...body, document_id: 'document_monthly_example' } });
      expect(missing.statusCode).not.toBe(200);
      expect(cycles.downloadBillingCycleDocument).not.toHaveBeenCalled();
      const result = await app.inject({ method: 'POST', url: '/billing/v1/cycles/download',
        headers, payload: { ...body, cycle_id: 'cycle_example_2026_07',
          document_id: 'document_monthly_example' } });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['content-disposition']).toBe(
        'attachment; filename="billing-2026-07-monthly_invoice.pdf"');
      expect(result.body).toBe('%PDF-1.7');
    });
  });
});
