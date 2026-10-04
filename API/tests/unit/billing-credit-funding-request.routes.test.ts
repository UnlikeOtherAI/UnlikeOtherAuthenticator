import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { billingCreditFundingRequestV1JsonSchema } from '../../src/contracts/billing-statement-v1.js';

const appKeyService = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const fundingRequestService = vi.hoisted(() => ({ createBillingCreditFundingRequest: vi.fn() }));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/billing-app-key.service.js')>(
    '../../src/services/billing-app-key.service.js',
  );
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-credit-funding-request.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-credit-funding-request.service.js')
  >('../../src/services/billing-credit-funding-request.service.js');
  return { ...actual, ...fundingRequestService };
});

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app_key_nessie',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.nessie.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.nessie.example'],
  service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' },
};
const subject = {
  product: 'nessie',
  organisation_id: 'org_example',
  team_id: 'team_example',
  user_id: 'user_example',
};
const headers = { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' };
const result = {
  schema_version: 1,
  request_id: `bfr1_${'a'.repeat(64)}`,
  recipient_user_ids: ['manager_a'],
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
  fundingRequestService.createBillingCreditFundingRequest.mockResolvedValue(result);
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

describe('billing credit funding-request route', () => {
  it('revalidates through the exact endpoint actor audience and returns only source IDs', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/funding-request',
        headers: {
          ...headers,
          'x-uoa-billing-presentation': '1.5.0',
          'x-uoa-billing-locale': 'cs',
        },
        payload: subject,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(result);
      expect(response.json()).not.toHaveProperty('sent');
      expect(fundingRequestService.createBillingCreditFundingRequest).toHaveBeenCalledWith({
        credential,
        endpoint: '/billing/v1/credits/funding-request',
        actorToken: 'signed-actor',
        request: {
          product: 'nessie',
          organisationId: 'org_example',
          teamId: 'team_example',
          userId: 'user_example',
        },
      });
    });
  });

  it('rejects recipient input, missing actors, and unsupported presentation before dispatch', async () => {
    await withApp(async (app) => {
      const callerChosenRecipients = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/funding-request',
        headers,
        payload: { ...subject, recipient_user_ids: ['attacker'] },
      });
      const missingActor = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/funding-request',
        headers: {
          'x-uoa-app-key': 'uoa_app_key',
          'x-uoa-billing-presentation': '1.5.0',
        },
        payload: subject,
      });
      const unsupportedPresentation = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/funding-request',
        headers: { ...headers, 'x-uoa-billing-presentation': '1.4.0' },
        payload: subject,
      });
      const legacy = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/funding-request',
        headers,
        payload: subject,
      });

      expect(callerChosenRecipients.statusCode).toBe(400);
      expect(missingActor.statusCode).toBe(401);
      expect(unsupportedPresentation.statusCode).toBe(400);
      expect(legacy.statusCode).toBe(400);
      expect(fundingRequestService.createBillingCreditFundingRequest).not.toHaveBeenCalled();
    });
  });

  it('publishes the strict response schema at the discovery path', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/schemas/billing-credit-funding-request-v1.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.json()).toEqual(billingCreditFundingRequestV1JsonSchema);
    });
  });
});
