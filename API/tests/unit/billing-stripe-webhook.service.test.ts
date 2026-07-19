import { BillingAssignmentScope, BillingTariffSource } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';

const now = new Date('2026-07-19T00:00:00.000Z');
const account = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
  createdAt: now,
  updatedAt: now,
};

function subscription(status = 'active', overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    metadata: {
      uoa_checkout_id: 'checkout_1',
      uoa_service_id: 'service_1',
      uoa_tariff_id: 'tariff_1',
      uoa_scope_key: 'org_1',
      uoa_stripe_account_id: 'acct_uoa',
      uoa_stripe_mode: 'test',
    },
    items: {
      data: [
        {
          id: 'si_monthly',
          quantity: 1,
          price: {
            id: 'price_monthly_1',
            recurring: { usage_type: 'licensed' },
          },
          current_period_start: 1_783_756_800,
          current_period_end: 1_786_435_200,
          discounts: [],
        },
        {
          id: 'si_usage',
          price: {
            id: 'price_usage_1',
            recurring: { usage_type: 'metered' },
          },
          current_period_start: 1_783_756_800,
          current_period_end: 1_786_435_200,
          discounts: [],
        },
      ],
    },
    discounts: [],
    status,
    cancel_at_period_end: status === 'canceled',
    livemode: false,
    ...overrides,
  };
}

function stripeEvent(id: string, type = 'customer.subscription.updated', payload = subscription()) {
  return {
    id,
    type,
    api_version: '2026-06-30.basil',
    account: 'acct_uoa',
    livemode: false,
    created: 1_784_467_200,
    data: { object: payload },
  };
}

function setup() {
  let currentEvent = stripeEvent('evt_1');
  let remoteSubscription: ReturnType<typeof subscription> | null = subscription();
  let localSubscription: Record<string, unknown> | null = null;
  const committedEvents = new Set<string>();
  const checkout = {
    id: 'checkout_1',
    accountId: account.id,
    appKeyId: 'app_key_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    tariffSource: BillingTariffSource.SERVICE_DEFAULT,
    tariffAssignmentId: null,
    orgId: 'org_1',
    teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: 'org_1',
    stripeCheckoutSessionId: 'cs_1',
    status: 'complete',
    completedAt: now,
    customer: {
      id: 'customer_1',
      accountId: account.id,
      stripeCustomerId: 'cus_1',
    },
    tariff: {
      stripePrices: [
        {
          accountId: account.id,
          stripeMonthlyPriceId: 'price_monthly_1',
          catalog: {
            accountId: account.id,
            stripeUsagePriceId: 'price_usage_1',
          },
        },
      ],
    },
  };
  const subscriptionModel = {
    findUnique: vi.fn().mockImplementation(async () => localSubscription),
    create: vi.fn().mockImplementation(async ({ data }) => {
      localSubscription = { id: 'local_sub_1', ...data };
      return localSubscription;
    }),
    update: vi.fn().mockImplementation(async ({ data }) => {
      localSubscription = { ...localSubscription, ...data };
      return localSubscription;
    }),
    updateMany: vi.fn().mockImplementation(async ({ data }) => {
      if (localSubscription) {
        localSubscription = { ...localSubscription, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    }),
  };
  const checkoutModel = {
    findUnique: vi.fn().mockResolvedValue(checkout),
    update: vi.fn().mockImplementation(async ({ data }) => {
      Object.assign(checkout, data);
      return checkout;
    }),
  };
  const eventFind = vi.fn().mockImplementation(async ({ where }) => {
    const id = where.accountId_stripeEventId.stripeEventId;
    return committedEvents.has(id) ? { id } : null;
  });
  const tx = {
    billingStripeWebhookEvent: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        committedEvents.add(data.stripeEventId);
        return data;
      }),
    },
    billingStripeCheckoutSession: checkoutModel,
    billingStripeSubscription: subscriptionModel,
  };
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    billingStripeWebhookEvent: { findUnique: eventFind },
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };
  const stripe = {
    accounts: {
      retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }),
    },
    webhooks: {
      constructEvent: vi.fn().mockImplementation(() => currentEvent),
    },
    subscriptions: {
      retrieve: vi.fn().mockImplementation(async () => {
        if (!remoteSubscription) {
          throw { code: 'resource_missing', statusCode: 404 };
        }
        return remoteSubscription;
      }),
    },
    checkout: { sessions: { retrieve: vi.fn() } },
  };
  const call = () =>
    handleStripeWebhook(
      { rawBody: Buffer.from('{}'), signature: 't=1,v1=valid' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        stripeLivemode: false,
        webhookSecret: 'whsec_test',
      },
    );
  return {
    prisma,
    stripe,
    call,
    subscriptionModel,
    eventFind,
    setEvent: (event: ReturnType<typeof stripeEvent>) => {
      currentEvent = event;
    },
    setRemote: (value: ReturnType<typeof subscription> | null) => {
      remoteSubscription = value;
    },
    getLocal: () => localSubscription,
    seedLocal: (overrides: Record<string, unknown> = {}) => {
      localSubscription = {
        id: 'local_sub_1',
        accountId: account.id,
        checkoutId: checkout.id,
        customerId: checkout.customerId,
        serviceId: checkout.serviceId,
        tariffId: checkout.tariffId,
        tariffSource: checkout.tariffSource,
        tariffAssignmentId: checkout.tariffAssignmentId,
        orgId: checkout.orgId,
        teamId: checkout.teamId,
        scope: checkout.scope,
        scopeKey: checkout.scopeKey,
        livemode: false,
        status: 'active',
        ...overrides,
      };
    },
  };
}

describe('Stripe webhook current-state reconciliation', () => {
  it('persists an account-scoped event and exact item projection', async () => {
    const state = setup();
    await expect(state.call()).resolves.toEqual({ duplicate: false });
    expect(state.subscriptionModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: account.id,
          checkoutId: 'checkout_1',
          stripeSubscriptionId: 'sub_1',
          stripeMonthlyItemId: 'si_monthly',
          stripeUsageItemId: 'si_usage',
        }),
      }),
    );
  });

  it('acknowledges an event committed for the same Stripe account only once', async () => {
    const state = setup();
    await state.call();
    await expect(state.call()).resolves.toEqual({ duplicate: true });
    expect(state.subscriptionModel.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature before resolving a Stripe account', async () => {
    const state = setup();
    state.stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('invalid');
    });
    await expect(state.call()).rejects.toThrow('INVALID_STRIPE_WEBHOOK_SIGNATURE');
    expect(state.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });

  it.each([
    { account: 'acct_other', livemode: false },
    { account: 'acct_uoa', livemode: true },
  ])('rejects a webhook from another Stripe account or mode', async (identity) => {
    const state = setup();
    state.setEvent({
      ...stripeEvent('evt_wrong_account'),
      ...identity,
    });

    await expect(state.call()).rejects.toThrow('STRIPE_WEBHOOK_ACCOUNT_MISMATCH');
    expect(state.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('does not resurrect a canceled subscription when an older update arrives later', async () => {
    const state = setup();
    state.setRemote(subscription('canceled'));
    state.setEvent(
      stripeEvent('evt_deleted', 'customer.subscription.deleted', subscription('canceled')),
    );
    await state.call();
    state.setEvent(
      stripeEvent('evt_stale_update', 'customer.subscription.updated', subscription('active')),
    );
    await state.call();
    expect(state.getLocal()).toMatchObject({ status: 'canceled' });
  });

  it('applies a resume only when Stripe current state is active', async () => {
    const state = setup();
    state.setRemote(subscription('canceled'));
    state.setEvent(
      stripeEvent('evt_canceled', 'customer.subscription.deleted', subscription('canceled')),
    );
    await state.call();
    state.setRemote(subscription('active'));
    state.setEvent(
      stripeEvent('evt_resumed', 'customer.subscription.resumed', subscription('active')),
    );
    await state.call();
    expect(state.getLocal()).toMatchObject({ status: 'active' });
  });

  it('tombstones a missing current subscription and never trusts the stale payload', async () => {
    const state = setup();
    state.seedLocal();
    state.setRemote(null);
    state.setEvent(
      stripeEvent('evt_missing', 'customer.subscription.updated', subscription('active')),
    );
    await state.call();
    expect(state.getLocal()).toMatchObject({
      status: 'canceled',
      cancelAtPeriodEnd: true,
    });
  });

  it.each([
    {
      name: 'extra item',
      mutate: (value: ReturnType<typeof subscription>) =>
        ({
          ...value,
          items: {
            data: [
              ...value.items.data,
              {
                id: 'si_extra',
                price: {
                  id: 'price_extra',
                  recurring: { usage_type: 'licensed' },
                },
              },
            ],
          },
        }) as never,
      error: 'STRIPE_SUBSCRIPTION_ITEMS_INVALID',
    },
    {
      name: 'duplicate usage item',
      mutate: (value: ReturnType<typeof subscription>) =>
        ({
          ...value,
          items: { data: [...value.items.data, value.items.data[1]] },
        }) as never,
      error: 'STRIPE_SUBSCRIPTION_ITEMS_INVALID',
    },
    {
      name: 'monthly quantity other than one',
      mutate: (value: ReturnType<typeof subscription>) => ({
        ...value,
        items: {
          data: [{ ...value.items.data[0], quantity: 2 }, value.items.data[1]],
        },
      }),
      error: 'STRIPE_SUBSCRIPTION_ITEMS_INVALID',
    },
    {
      name: 'discount',
      mutate: (value: ReturnType<typeof subscription>) => ({
        ...value,
        discounts: ['di_unauthorized'],
      }),
      error: 'STRIPE_SUBSCRIPTION_DISCOUNT_INVALID',
    },
  ])('rejects an unauthorized $name', async ({ mutate, error }) => {
    const state = setup();
    state.setRemote(mutate(subscription()));
    await expect(state.call()).rejects.toThrow(error);
  });

  it.each([{ customerId: 'another_customer' }, { tariffAssignmentId: 'another_assignment' }])(
    'rejects immutable local binding changes',
    async (override) => {
      const state = setup();
      state.seedLocal(override);
      await expect(state.call()).rejects.toThrow('STRIPE_SUBSCRIPTION_REBIND_FORBIDDEN');
    },
  );
});
