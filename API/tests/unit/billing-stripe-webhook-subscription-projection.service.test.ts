import { describe, expect, it } from 'vitest';

import {
  setupStripeWebhookTest,
  stripeEvent,
  subscription,
} from './billing-stripe-webhook.test-fixture.js';

describe('Stripe webhook base subscription projection', () => {
  it('does not resurrect a canceled subscription when an older update arrives later', async () => {
    const state = setupStripeWebhookTest();
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
    const state = setupStripeWebhookTest();
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

  it('advances the local projection to Stripe’s next calendar-month renewal period', async () => {
    const state = setupStripeWebhookTest();
    state.seedLocal({
      currentPeriodStart: new Date('2026-07-20T12:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    });
    const renewed = subscription('active');
    renewed.items.data = renewed.items.data.map((item) => ({
      ...item,
      current_period_start: 1_785_542_400,
      current_period_end: 1_788_220_800,
    }));
    state.setRemote(renewed);
    state.setEvent(stripeEvent('evt_renewed', 'customer.subscription.updated', renewed));

    await state.call();

    expect(state.getLocal()).toMatchObject({
      status: 'active',
      currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('tombstones a missing current subscription and never trusts the stale payload', async () => {
    const state = setupStripeWebhookTest();
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
    const state = setupStripeWebhookTest();
    state.setRemote(mutate(subscription()));
    await expect(state.call()).rejects.toThrow(error);
  });

  it.each([{ customerId: 'another_customer' }, { tariffAssignmentId: 'another_assignment' }])(
    'rejects immutable local binding changes',
    async (override) => {
      const state = setupStripeWebhookTest();
      state.seedLocal(override);
      await expect(state.call()).rejects.toThrow('STRIPE_SUBSCRIPTION_REBIND_FORBIDDEN');
    },
  );
});
