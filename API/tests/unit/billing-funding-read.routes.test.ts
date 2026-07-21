import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  billingCreditsV1ConformanceFixture,
  billingRecurringAddonV1ConformanceFixtures,
} from '../../src/contracts/billing-statement-v1.js';

const appKeyService = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const creditsService = vi.hoisted(() => ({ getBillingCredits: vi.fn() }));
const addonsService = vi.hoisted(() => ({ getBillingRecurringAddons: vi.fn() }));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-credits.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/billing-credits.service.js')>(
    '../../src/services/billing-credits.service.js',
  );
  return { ...actual, ...creditsService };
});
vi.mock('../../src/services/billing-recurring-addons.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-recurring-addons.service.js')
  >('../../src/services/billing-recurring-addons.service.js');
  return { ...actual, ...addonsService };
});

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
const body = {
  product: 'deepwater',
  organisation_id: 'org_example',
  team_id: 'team_example',
  user_id: 'user_example',
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
  creditsService.getBillingCredits.mockResolvedValue(billingCreditsV1ConformanceFixture);
  addonsService.getBillingRecurringAddons.mockResolvedValue(
    billingRecurringAddonV1ConformanceFixtures.recurring_addons,
  );
});

async function withApp(
  callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
): Promise<void> {
  const app = await createApp();
  await app.ready();
  try {
    await callback(app);
  } finally {
    await app.close();
  }
}

describe('shared credits and recurring add-on read routes', () => {
  it('publishes both protocol schema, fixture, and OpenAPI artifacts without credentials', async () => {
    await withApp(async (app) => {
      const urls = [
        '/schemas/billing-credits-v1.json',
        '/schemas/billing-credits-v1.example.json',
        '/schemas/billing-credits-v1.openapi.json',
        '/schemas/billing-recurring-addons-v1.json',
        '/schemas/billing-recurring-addons-v1.example.json',
        '/schemas/billing-recurring-addons-v1.openapi.json',
      ];
      const responses = await Promise.all(
        urls.map((url) => app.inject({ method: 'GET', url })),
      );

      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(responses.every((response) => response.headers['cache-control'] === 'public, max-age=300'))
        .toBe(true);
      expect(responses[0].json()).toMatchObject({ $id: '/schemas/billing-credits-v1.json' });
      expect(responses[1].json()).toMatchObject({
        schema_version: 1,
        credit_balance: { label: 'Remaining credits' },
      });
      expect(responses[2].json()).toMatchObject({ openapi: '3.1.0' });
      expect(responses[3].json()).toMatchObject({
        $id: '/schemas/billing-recurring-addons-v1.json',
      });
      expect(responses[4].json()).toMatchObject({
        recurring_addons: { schema_version: 1 },
        recurring_addons_member: { viewer: { role: 'member' } },
      });
      expect(responses[5].json()).toMatchObject({ openapi: '3.1.0' });
    });
  });

  it('binds the exact lifecycle credential, actor, user, organisation, and team for credits', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits',
        headers: { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({ credit_balance: { label: 'Remaining credits' } });
      expect(creditsService.getBillingCredits).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: {
          product: 'deepwater',
          organisationId: 'org_example',
          teamId: 'team_example',
          userId: 'user_example',
        },
      });
    });
  });

  it('returns the display-ready exact-scope recurring add-on projection', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/recurring-addons',
        headers: { authorization: 'Bearer uoa_app_key', 'x-uoa-actor': 'signed-actor' },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        viewer: { role: 'billing_manager' },
        offers: [{ key: 'privacy', monthly_price: { amount_minor: '5000' } }],
      });
      expect(addonsService.getBillingRecurringAddons).toHaveBeenCalledWith(
        expect.objectContaining({ actorToken: 'signed-actor', credential }),
      );
    });
  });

  it('fails closed when the required actor assertion is missing', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits',
        headers: { 'x-uoa-app-key': 'uoa_app_key' },
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      expect(creditsService.getBillingCredits).not.toHaveBeenCalled();
    });
  });

  it('rejects a service response that violates the public privacy contract', async () => {
    creditsService.getBillingCredits.mockResolvedValueOnce({ schema_version: 1 });
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits',
        headers: { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' },
        payload: body,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: 'Request failed' });
    });
  });
});
