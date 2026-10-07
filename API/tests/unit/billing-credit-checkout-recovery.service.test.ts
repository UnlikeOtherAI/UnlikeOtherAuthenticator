import { BillingCreditCheckoutStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { reconcileCreditCheckout } from '../../src/services/billing-credit-checkout-recovery.service.js';
import type { StripeAccountContext } from '../../src/services/billing-stripe-client.service.js';

const account: StripeAccountContext = {
  id: 'account_1',
  stripeAccountId: 'acct_1',
  livemode: false,
};
const now = new Date('2026-10-04T12:00:00.000Z');
const checkout = {
  id: 'checkout_1',
  accountId: account.id,
  creditAccountId: 'credit_account_1',
  customerId: 'customer_1',
  serviceId: 'service_1',
  appKeyId: 'app_key_1',
  status: BillingCreditCheckoutStatus.OPEN,
  stripeCheckoutSessionId: 'cs_1',
  createdAt: now,
  leaseExpiresAt: new Date(now.getTime() + 60_000),
} as never;

function session(status: 'open' | 'complete' | 'expired') {
  return {
    id: 'cs_1',
    livemode: false,
    mode: 'payment',
    status,
    url: status === 'open' ? 'https://checkout.stripe.com/c/pay/cs_1' : null,
    expires_at: Math.floor(now.getTime() / 1000) + 300,
    customer: 'cus_1',
    client_reference_id: 'checkout_1',
    metadata: {
      uoa_credit_top_up_checkout_id: 'checkout_1',
      uoa_service_id: 'service_1',
      uoa_app_key_id: 'app_key_1',
      uoa_credit_account_id: 'credit_account_1',
    },
  };
}

function dependencies(remote: ReturnType<typeof session>, updatedCount = 1) {
  const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
  const stripe = {
    checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(remote), list: vi.fn() } },
  };
  const prisma = {
    billingCreditTopUpCheckout: { updateMany },
    billingCreditEntry: { create: vi.fn() },
  };
  return { prisma, stripe, updateMany };
}

describe('credit Checkout recovery compare-and-swap', () => {
  it('keeps a webhook-completed checkout from being downgraded after a stale Stripe read', async () => {
    const deps = dependencies(session('open'), 0);

    await expect(
      reconcileCreditCheckout(
        { checkout, kind: 'top_up', customerStripeId: 'cus_1', account, now },
        deps as never,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_CREDIT_TOP_UP_PREDECESSOR_CHANGED',
    });
    expect(deps.updateMany).toHaveBeenCalledWith({
      where: {
        id: checkout.id,
        status: {
          in: [
            BillingCreditCheckoutStatus.CREATING,
            BillingCreditCheckoutStatus.OPEN,
            BillingCreditCheckoutStatus.NEEDS_REVIEW,
          ],
        },
      },
      data: {
        stripeCheckoutSessionId: 'cs_1',
        status: BillingCreditCheckoutStatus.OPEN,
        expiresAt: new Date(session('open').expires_at * 1000),
      },
    });
    expect(deps.prisma.billingCreditEntry.create).not.toHaveBeenCalled();
  });

  it('does not persist or redirect a completed Stripe snapshot before webhook proof', async () => {
    const deps = dependencies(session('complete'));

    const recovered = await reconcileCreditCheckout(
      { checkout, kind: 'top_up', customerStripeId: 'cus_1', account, now },
      deps as never,
    );

    expect(recovered.session?.status).toBe('complete');
    expect(deps.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.billingCreditEntry.create).not.toHaveBeenCalled();
  });

  it('terminalizes an exact expired session but never returns it as a continuation', async () => {
    const deps = dependencies(session('expired'));

    const recovered = await reconcileCreditCheckout(
      { checkout, kind: 'top_up', customerStripeId: 'cus_1', account, now },
      deps as never,
    );

    expect(recovered).toMatchObject({ session: { status: 'expired' }, abandoned: false });
    expect(deps.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: checkout.id,
          status: {
            in: [
              BillingCreditCheckoutStatus.CREATING,
              BillingCreditCheckoutStatus.OPEN,
              BillingCreditCheckoutStatus.NEEDS_REVIEW,
            ],
          },
        }),
        data: expect.objectContaining({ status: BillingCreditCheckoutStatus.EXPIRED }),
      }),
    );
  });
});
