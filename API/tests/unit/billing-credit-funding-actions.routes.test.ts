import { BillingAppKeyPurpose } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const appKeyService = vi.hoisted(() => ({ verifyBillingAppKey: vi.fn() }));
const topUpService = vi.hoisted(() => ({ createBillingCreditTopUpCheckout: vi.fn() }));
const setupService = vi.hoisted(() => ({ createBillingCreditAutoTopUpSetup: vi.fn() }));
const consentService = vi.hoisted(() => ({
  updateBillingCreditAutoTopUp: vi.fn(),
  disableBillingCreditAutoTopUp: vi.fn(),
}));
const recoveryService = vi.hoisted(() => ({ recoverBillingCreditAutoTopUp: vi.fn() }));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKeyService };
});
vi.mock('../../src/services/billing-credit-top-up.service.js', () => topUpService);
vi.mock('../../src/services/billing-credit-auto-top-up-setup.service.js', () => setupService);
vi.mock('../../src/services/billing-credit-auto-top-up-consent.service.js', () => consentService);
vi.mock('../../src/services/billing-credit-auto-top-up-recovery.service.js', () => recoveryService);

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
const requestSubject = {
  product: 'deepwater',
  organisationId: 'org_example',
  teamId: 'team_example',
  userId: 'user_example',
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
  topUpService.createBillingCreditTopUpCheckout.mockResolvedValue({
    redirect_url: 'https://checkout.stripe.com/c/pay/top-up',
  });
  setupService.createBillingCreditAutoTopUpSetup.mockResolvedValue({
    redirect_url: 'https://checkout.stripe.com/c/setup/auto-top-up',
  });
  recoveryService.recoverBillingCreditAutoTopUp.mockResolvedValue({
    redirect_url: 'https://hooks.stripe.com/redirect/authenticate/recovery',
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

const headers = { 'x-uoa-app-key': 'uoa_app_key', 'x-uoa-actor': 'signed-actor' };

describe('billing credit funding action routes', () => {
  it('rejects selectors above the public 256-character bound before dispatch', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/top-up-checkout',
        headers,
        payload: { ...subject, offer_id: 'x'.repeat(257) },
      });

      expect(response.statusCode).toBe(400);
      expect(topUpService.createBillingCreditTopUpCheckout).not.toHaveBeenCalled();
    });
  });

  it('relays only the exact offer to UOA-owned top-up Checkout', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/top-up-checkout',
        headers,
        payload: { ...subject, offer_id: 'offer_20k' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({
        redirect_url: 'https://checkout.stripe.com/c/pay/top-up',
      });
      expect(topUpService.createBillingCreditTopUpCheckout).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: { ...requestSubject, offerId: 'offer_20k' },
      });
    });
  });

  it('runs setup, update, disable, and recovery with frozen option/subject bodies', async () => {
    await withApp(async (app) => {
      const setup = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/auto-top-up/setup',
        headers,
        payload: { ...subject, option_id: 'option_safe' },
      });
      const update = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/auto-top-up/update',
        headers,
        payload: { ...subject, option_id: 'option_safe' },
      });
      const disable = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/auto-top-up/disable',
        headers,
        payload: subject,
      });
      const recover = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/auto-top-up/recover',
        headers,
        payload: subject,
      });

      expect([setup.statusCode, update.statusCode, disable.statusCode, recover.statusCode]).toEqual(
        [200, 204, 204, 200],
      );
      expect(setupService.createBillingCreditAutoTopUpSetup).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: { ...requestSubject, optionId: 'option_safe' },
      });
      expect(consentService.updateBillingCreditAutoTopUp).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: { ...requestSubject, optionId: 'option_safe' },
      });
      expect(consentService.disableBillingCreditAutoTopUp).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: requestSubject,
      });
      expect(recoveryService.recoverBillingCreditAutoTopUp).toHaveBeenCalledWith({
        credential,
        actorToken: 'signed-actor',
        request: requestSubject,
      });
    });
  });

  it('rejects caller-controlled price, amount, and return URL fields', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/top-up-checkout',
        headers,
        payload: {
          ...subject,
          offer_id: 'offer_20k',
          amount_minor: '1',
          price_id: 'price_attacker',
          return_url: 'https://attacker.example',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(topUpService.createBillingCreditTopUpCheckout).not.toHaveBeenCalled();
    });
  });

  it('requires a fresh actor assertion before invoking a mutation service', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/credits/auto-top-up/disable',
        headers: { 'x-uoa-app-key': 'uoa_app_key' },
        payload: subject,
      });

      expect(response.statusCode).toBe(401);
      expect(consentService.disableBillingCreditAutoTopUp).not.toHaveBeenCalled();
    });
  });
});
