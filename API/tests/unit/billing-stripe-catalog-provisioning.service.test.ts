import { describe, expect, it, vi } from 'vitest';

import { provisionStripeCommercialCatalog } from '../../src/services/billing-stripe-catalog-provisioning.service.js';

const catalog = {
  stripeAccountId: 'acct_uoa',
  livemode: false,
  creditPrices: [],
  recurringAddon: {
    stripeLookupKey: 'deepwater_privacy_usd_month_v1',
    stripeProductId: 'prod_privacy',
    stripePriceId: 'price_privacy',
  },
};

describe('Stripe commercial catalog provisioning transaction', () => {
  it('keeps dry-run read-only and reports planned creation', async () => {
    const transaction = vi.fn();
    const reconcileLocal = vi
      .fn()
      .mockResolvedValue([
        { resource: 'credit_catalog', key: 'credits_usd_10/v1', outcome: 'created' },
      ]);
    const result = await provisionStripeCommercialCatalog(
      {
        stripe: {} as never,
        expectedStripeAccountId: catalog.stripeAccountId,
        expectedLivemode: false,
        dryRun: true,
      },
      {
        prisma: { $transaction: transaction } as never,
        validateRemote: vi.fn().mockResolvedValue(catalog),
        reconcileLocal,
      },
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(reconcileLocal).toHaveBeenCalledWith({
      db: expect.anything(),
      catalog,
      write: false,
    });
    expect(result).toMatchObject({ mode: 'dry-run', outcome: 'created' });
  });

  it('applies every local insert through one serializable transaction', async () => {
    const tx = { marker: 'transaction' };
    const transaction = vi.fn(async (callback: (value: unknown) => unknown, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'Serializable' });
      return callback(tx);
    });
    const reconcileLocal = vi
      .fn()
      .mockResolvedValue([{ resource: 'stripe_account', key: 'acct_uoa/test', outcome: 'no-op' }]);
    const result = await provisionStripeCommercialCatalog(
      {
        stripe: {} as never,
        expectedStripeAccountId: catalog.stripeAccountId,
        expectedLivemode: false,
        dryRun: false,
      },
      {
        prisma: { $transaction: transaction } as never,
        validateRemote: vi.fn().mockResolvedValue(catalog),
        reconcileLocal,
      },
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(reconcileLocal).toHaveBeenCalledWith({ db: tx, catalog, write: true });
    expect(result).toMatchObject({
      mode: 'apply',
      outcome: 'no-op',
      summary: { created: 0, no_op: 1 },
    });
  });
});
