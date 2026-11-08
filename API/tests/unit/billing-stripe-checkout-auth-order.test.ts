import { describe, expect, it, vi } from 'vitest';
import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';
import { AppError } from '../../src/utils/errors.js';
import { credential, request } from './billing-stripe-checkout.test-fixtures.js';

describe('Checkout actor authentication boundary', () => {
  it('refuses an invalid signed actor before role lookup, account reads or provider resources', async () => {
    const user = vi.fn(), account = vi.fn(), resolveTariff = vi.fn(async () => {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_BILLING_ACTOR');
    });
    await expect(createStripeCheckoutSession({ request, actorToken: 'invalid', credential,
      endpoint: '/billing/v1/stripe/checkout-session' }, { prisma: { user: { findUnique: user } } as never,
      stripe: { accounts: { retrieveCurrent: account } } as never, resolveTariff: resolveTariff as never }))
      .rejects.toMatchObject({ statusCode: 401, message: 'INVALID_BILLING_ACTOR' });
    expect(user).not.toHaveBeenCalled(); expect(account).not.toHaveBeenCalled();
  });
});
