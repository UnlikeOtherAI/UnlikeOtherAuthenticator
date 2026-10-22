import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';

import {
  assertStripeObjectLivemode,
  resolveStripeAccountContext,
} from '../../src/services/billing-stripe-client.service.js';

describe('Stripe account and mode identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    Stripe.errors.StripeAuthenticationError,
    Stripe.errors.StripePermissionError,
    Stripe.errors.StripeConnectionError,
    Stripe.errors.StripeAPIError,
    Stripe.errors.StripeRateLimitError,
  ])('reports provider account failures without exposing credentials or changing identity', async (ProviderError) => {
    vi.stubEnv('DEBUG_ENABLED', 'false');
    const retrieveCurrent = vi.fn()
      .mockRejectedValueOnce(new ProviderError({ message: 'provider credential detail', code: 'api_key_expired' }))
      .mockResolvedValueOnce({ id: 'acct_recovered' });
    const upsert = vi.fn().mockResolvedValue({ id: 'projection', stripeAccountId: 'acct_recovered', livemode: false });
    const stripe = { accounts: { retrieveCurrent } };
    const prisma = { billingStripeAccount: { upsert } };

    const error = await resolveStripeAccountContext(stripe as never, false, prisma as never)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503, message: 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(buildPublicErrorBody({ statusCode: 503, error })).toEqual({ error: 'Request failed', code: 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(String(error)).not.toContain('provider credential detail');
    expect(error).not.toHaveProperty('cause');
    expect(upsert).not.toHaveBeenCalled();

    await expect(resolveStripeAccountContext(stripe as never, false, prisma as never))
      .resolves.toMatchObject({ stripeAccountId: 'acct_recovered', livemode: false });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('does not disguise programming or persistence failures as provider outages', async () => {
    const unexpected = new TypeError('unexpected implementation failure');
    const retrieveCurrent = vi.fn().mockRejectedValueOnce(unexpected).mockResolvedValue({ id: 'acct_uoa' });
    const persistence = new Error('database unavailable');
    const upsert = vi.fn().mockRejectedValue(persistence);
    const stripe = { accounts: { retrieveCurrent } };
    const prisma = { billingStripeAccount: { upsert } };
    await expect(resolveStripeAccountContext(stripe as never, false, prisma as never)).rejects.toBe(unexpected);
    expect(upsert).not.toHaveBeenCalled();
    await expect(resolveStripeAccountContext(stripe as never, false, prisma as never)).rejects.toBe(persistence);
  });

  it('creates distinct test and live projections for the same Stripe account', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const upsert = vi.fn().mockImplementation(async ({ where, create }) => {
      const identity = where.stripeAccountId_livemode;
      const key = `${identity.stripeAccountId}:${identity.livemode}`;
      const existing = rows.get(key);
      if (existing) return existing;
      const row = {
        id: identity.livemode ? 'account_live' : 'account_test',
        ...create,
      };
      rows.set(key, row);
      return row;
    });
    const prisma = { billingStripeAccount: { upsert } };
    const stripe = {
      accounts: {
        retrieveCurrent: vi.fn().mockResolvedValue({ id: 'acct_uoa' }),
      },
    };

    const test = await resolveStripeAccountContext(stripe as never, false, prisma as never);
    const live = await resolveStripeAccountContext(stripe as never, true, prisma as never);

    expect(test).toMatchObject({ id: 'account_test', livemode: false });
    expect(live).toMatchObject({ id: 'account_live', livemode: true });
    expect(upsert.mock.calls.map((call) => call[0].where)).toEqual([
      {
        stripeAccountId_livemode: {
          stripeAccountId: 'acct_uoa',
          livemode: false,
        },
      },
      {
        stripeAccountId_livemode: {
          stripeAccountId: 'acct_uoa',
          livemode: true,
        },
      },
    ]);
  });

  it('rejects a Stripe object returned from the opposite key mode', () => {
    expect(() => assertStripeObjectLivemode({ id: 'price_1', livemode: false }, true)).toThrow(
      'STRIPE_OBJECT_MODE_MISMATCH',
    );
    expect(() => assertStripeObjectLivemode({ id: 'price_without_mode' }, false)).toThrow(
      'STRIPE_OBJECT_MODE_MISMATCH',
    );
  });
});
