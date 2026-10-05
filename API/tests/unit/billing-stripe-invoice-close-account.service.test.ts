import { describe, expect, it, vi } from 'vitest';
import { runStripeInvoiceCloseCycle } from '../../src/services/billing-stripe-invoice-close-scheduler.service.js';

describe('invoice catch-up Stripe account authority', () => {
  it('holds a ready invoice before any remote invoice read or finalization when the configured account changes', async () => {
    const row = { id: 'close_1', accountId: 'stored_account', stripeInvoiceId: 'in_old',
      state: 'READY', nextCheckAt: new Date('2026-10-04T00:00:00.000Z') };
    const prisma = {
      billingStripeInvoiceClose: {
        findMany: vi.fn().mockResolvedValue([row]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(row),
      },
      billingStripeAccount: { findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'stored_account', stripeAccountId: 'acct_original', livemode: false,
      }) },
    };
    const stripe = {
      accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: 'acct_replacement' }) },
      invoices: { retrieve: vi.fn(), update: vi.fn() },
    };
    const result = await runStripeInvoiceCloseCycle({ prisma: prisma as never,
      stripe: stripe as never, now: () => new Date('2026-10-04T12:00:00.000Z') });
    expect(result).toEqual({ checked: 1, held: 1, unbilled: 0 });
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.update).not.toHaveBeenCalled();
    expect(prisma.billingStripeInvoiceClose.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'READY', lastError: 'STRIPE_ACCOUNT_MISMATCH' }),
    }));
  });
});
