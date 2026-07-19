import { describe, expect, it, vi } from 'vitest';

import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    api_version: '2026-06-30.basil',
    livemode: false,
    created: 1_784_467_200,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        metadata: {
          uoa_checkout_id: 'checkout_1',
          uoa_service_id: 'service_1',
          uoa_tariff_id: 'tariff_1',
          uoa_scope_key: 'org_1',
        },
        items: {
          data: [
            {
              id: 'si_monthly',
              price: { id: 'price_monthly_1' },
              current_period_start: 1_783_756_800,
              current_period_end: 1_786_435_200,
            },
            {
              id: 'si_usage',
              price: { id: 'price_usage_1' },
              current_period_start: 1_783_756_800,
              current_period_end: 1_786_435_200,
            },
          ],
        },
        status: 'active',
        cancel_at_period_end: false,
        livemode: false,
      },
    },
    ...overrides,
  };
}

function setup(stripeEvent = event()) {
  const webhookCreate = vi.fn().mockResolvedValue({});
  const subscriptionUpsert = vi.fn().mockResolvedValue({});
  const checkoutFind = vi.fn().mockResolvedValue({
    id: 'checkout_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    orgId: 'org_1',
    teamId: null,
    scope: 'ORGANISATION',
    scopeKey: 'org_1',
    customer: { stripeCustomerId: 'cus_1' },
    tariff: {
      stripePrice: {
        stripeMonthlyPriceId: 'price_monthly_1',
        catalog: { stripeUsagePriceId: 'price_usage_1' },
      },
    },
  });
  const tx = {
    billingStripeWebhookEvent: { create: webhookCreate },
    billingStripeCheckoutSession: {
      findUnique: checkoutFind,
      updateMany: vi.fn(),
    },
    billingStripeSubscription: { upsert: subscriptionUpsert },
  };
  const eventFind = vi.fn().mockResolvedValue(null);
  const prisma = {
    billingStripeWebhookEvent: { findUnique: eventFind },
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };
  const stripe = {
    webhooks: { constructEvent: vi.fn().mockReturnValue(stripeEvent) },
    subscriptions: { retrieve: vi.fn() },
  };
  return { prisma, stripe, webhookCreate, subscriptionUpsert, eventFind };
}

describe('Stripe webhook processing', () => {
  it('persists a verified event and binds subscription items to the exact UOA tariff', async () => {
    const { prisma, stripe, webhookCreate, subscriptionUpsert } = setup();
    const result = await handleStripeWebhook(
      { rawBody: Buffer.from('{}'), signature: 't=1,v1=valid' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        webhookSecret: 'whsec_test',
      },
    );

    expect(result).toEqual({ duplicate: false });
    expect(webhookCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'evt_1',
        type: 'customer.subscription.updated',
      }),
    });
    expect(subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          stripeSubscriptionId: 'sub_1',
          stripeMonthlyItemId: 'si_monthly',
          stripeUsageItemId: 'si_usage',
          serviceId: 'service_1',
          tariffId: 'tariff_1',
          scopeKey: 'org_1',
        }),
      }),
    );
  });

  it('acknowledges an already committed event without applying it again', async () => {
    const { prisma, stripe, subscriptionUpsert, eventFind } = setup();
    eventFind.mockResolvedValue({ id: 'evt_1' });

    await expect(
      handleStripeWebhook(
        { rawBody: Buffer.from('{}'), signature: 't=1,v1=valid' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          webhookSecret: 'whsec_test',
        },
      ),
    ).resolves.toEqual({ duplicate: true });
    expect(subscriptionUpsert).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before touching billing state', async () => {
    const { prisma, stripe, webhookCreate } = setup();
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('invalid');
    });

    await expect(
      handleStripeWebhook(
        { rawBody: Buffer.from('{}'), signature: 'invalid' },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          webhookSecret: 'whsec_test',
        },
      ),
    ).rejects.toThrow('INVALID_STRIPE_WEBHOOK_SIGNATURE');
    expect(webhookCreate).not.toHaveBeenCalled();
  });
});
