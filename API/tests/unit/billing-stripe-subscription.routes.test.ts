import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const appKeyService = vi.hoisted(() => ({
  verifyBillingAppKey: vi.fn(),
}));
const subscriptionService = vi.hoisted(() => ({
  getStripeSubscriptionSummary: vi.fn(),
  createStripePortalSession: vi.fn(),
}));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-stripe-subscription.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-stripe-subscription.service.js')
  >('../../src/services/billing-stripe-subscription.service.js');
  return { ...actual, ...subscriptionService };
});

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const credential = {
  id: 'app-key-1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
  actorKeyId: 'actor-key-1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.nessie.works'],
  service: { id: 'service-1', identifier: 'deepwater', name: 'DeepWater' },
};
const subject = {
  product: 'deepwater',
  organisation_id: 'org-1',
  team_id: 'team-1',
  user_id: 'user-1',
};
const summary = {
  product: { id: 'service-1', identifier: 'deepwater' },
  subject: {
    user_id: 'user-1',
    organisation_id: 'org-1',
    team_id: 'team-1',
  },
  tariff: { id: 'tariff-1' },
  assignment: { scope: 'team', id: 'assignment-1' },
  stripe_collection_enabled: true,
  stripe_mode: 'test',
  can_manage: true,
  subscription: null,
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
  subscriptionService.getStripeSubscriptionSummary.mockResolvedValue(summary);
  subscriptionService.createStripePortalSession.mockResolvedValue({
    portal_url: 'https://billing.stripe.com/p/session/test',
  });
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

describe('Stripe customer subscription routes', () => {
  it('binds the product app key and actor to a no-store subscription summary', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/subscription-summary',
        headers: {
          'x-uoa-app-key': 'uoa_app_product-key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: subject,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(subscriptionService.getStripeSubscriptionSummary).toHaveBeenCalledWith({
        request: {
          product: 'deepwater',
          organisationId: 'org-1',
          teamId: 'team-1',
          userId: 'user-1',
        },
        actorToken: 'signed-actor',
        credential,
      });
    });
  });

  it('rejects an entitlement-only key at customer lifecycle endpoints', async () => {
    appKeyService.verifyBillingAppKey.mockResolvedValueOnce({
      ...credential,
      purpose: BillingAppKeyPurpose.ENTITLEMENT,
      checkoutReturnOrigins: [],
    });
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/subscription-summary',
        headers: {
          'x-uoa-app-key': 'uoa_app_entitlement-key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: subject,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Request failed' });
      expect(subscriptionService.getStripeSubscriptionSummary).not.toHaveBeenCalled();
    });
  });

  it('passes only the allowlist-validated portal return URL input to the service', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/portal-session',
        headers: {
          'x-uoa-app-key': 'uoa_app_product-key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: {
          ...subject,
          return_url: 'https://app.nessie.works/billing',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        portal_url: 'https://billing.stripe.com/p/session/test',
      });
      expect(subscriptionService.createStripePortalSession).toHaveBeenCalledWith({
        request: {
          product: 'deepwater',
          organisationId: 'org-1',
          teamId: 'team-1',
          userId: 'user-1',
          returnUrl: 'https://app.nessie.works/billing',
        },
        actorToken: 'signed-actor',
        credential,
      });
    });
  });

  it('does not expose the superseded one-step cancellation route', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/subscription/cancel',
        headers: { 'x-uoa-app-key': 'uoa_app_product-key' },
        payload: subject,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
