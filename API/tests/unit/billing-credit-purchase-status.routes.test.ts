import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const appKeyService = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const purchaseStatusService = vi.hoisted(() => ({ getBillingCreditPurchaseStatus: vi.fn() }));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/billing-app-key.service.js')>(
    '../../src/services/billing-app-key.service.js',
  );
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-credit-purchase-status.service.js', () => purchaseStatusService);

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const subject = {
  product: 'deepwater',
  organisation_id: 'org_example',
  team_id: 'team_example',
  user_id: 'user_example',
};
const headers = { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' };
const status = {
  schema_version: 1,
  purchase_id: 'purchase_1',
  state: 'processing',
  title: 'Payment status',
  message: 'Checking payment',
  awaiting_confirmation: true,
};

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  else process.env.SHARED_SECRET = originalSharedSecret;
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  appKeyService.verifyBillingAppKey.mockResolvedValue(credential);
  purchaseStatusService.getBillingCreditPurchaseStatus.mockResolvedValue(status);
});

async function withApp(callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>): Promise<void> {
  const app = await createApp();
  await app.ready();
  try {
    await callback(app);
  } finally {
    await app.close();
  }
}

describe('billing credit purchase-status route', () => {
  it('passes the exact subject, purchase id, actor audience endpoint, and negotiated locale', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/purchase-status',
        headers: {
          ...headers,
          'x-uoa-billing-presentation': '1.5.0',
          'x-uoa-billing-locale': 'de',
        },
        payload: { ...subject, purchase_id: 'purchase_1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(status);
      expect(purchaseStatusService.getBillingCreditPurchaseStatus).toHaveBeenCalledWith({
        credential,
        endpoint: '/billing/v1/credits/purchase-status',
        actorToken: 'signed-actor',
        locale: 'de',
        request: {
          product: 'deepwater', organisationId: 'org_example', teamId: 'team_example',
          userId: 'user_example', purchaseId: 'purchase_1',
        },
      });
    });
  });

  it('keeps legacy calls in English while retaining the private no-store response', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/purchase-status',
        headers,
        payload: { ...subject, purchase_id: 'purchase_1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(purchaseStatusService.getBillingCreditPurchaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'en-US' }),
      );
    });
  });

  it.each([
    ['version without locale', { 'x-uoa-billing-presentation': '1.4.0' }],
    ['locale without version', { 'x-uoa-billing-locale': 'cs' }],
    ['unsupported locale', { 'x-uoa-billing-presentation': '1.5.0', 'x-uoa-billing-locale': 'nl' }],
  ])('rejects %s before reading status', async (_label, presentationHeaders) => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/purchase-status',
        headers: { ...headers, ...presentationHeaders },
        payload: { ...subject, purchase_id: 'purchase_1' },
      });

      expect(response.statusCode).toBe(400);
      expect(purchaseStatusService.getBillingCreditPurchaseStatus).not.toHaveBeenCalled();
    });
  });

  it('rejects extra body fields and missing actor assertions before service dispatch', async () => {
    await withApp(async (app) => {
      const extraField = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/purchase-status',
        headers,
        payload: { ...subject, purchase_id: 'purchase_1', team_scope: 'other-team' },
      });
      const missingActor = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/purchase-status',
        headers: { 'x-uoa-app-key': 'uoa_app_key' },
        payload: { ...subject, purchase_id: 'purchase_1' },
      });

      expect(extraField.statusCode).toBe(400);
      expect(missingActor.statusCode).toBe(401);
      expect(purchaseStatusService.getBillingCreditPurchaseStatus).not.toHaveBeenCalled();
    });
  });
});
