import { describe, expect, it, vi } from 'vitest';

import {
  assertStripeObjectLivemode,
  resolveStripeAccountContext,
} from '../../src/services/billing-stripe-client.service.js';

describe('Stripe account and mode identity', () => {
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
