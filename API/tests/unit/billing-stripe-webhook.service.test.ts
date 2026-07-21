import { describe, expect, it, vi } from 'vitest';

import {
  account,
  setupStripeWebhookTest,
  stripeEvent,
  subscription,
} from './billing-stripe-webhook.test-fixture.js';

describe('Stripe webhook current-state reconciliation', () => {
  it('persists an account-scoped event and exact item projection', async () => {
    const state = setupStripeWebhookTest();
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
    const state = setupStripeWebhookTest();
    await state.call();
    await expect(state.call()).resolves.toEqual({ duplicate: true });
    expect(state.subscriptionModel.create).toHaveBeenCalledTimes(1);
  });

  it('acknowledges an unrelated account-wide subscription event without projecting it', async () => {
    const state = setupStripeWebhookTest();
    state.setRemote(subscription('active', { metadata: {} }));
    state.setEvent(
      stripeEvent(
        'evt_unrelated_subscription',
        'customer.subscription.updated',
        subscription('active', { metadata: {} }),
      ),
    );

    await expect(state.call()).resolves.toEqual({ duplicate: false });
    expect(state.stripe.subscriptions.retrieve).toHaveBeenCalledOnce();
    expect(state.subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('acknowledges an unrelated subscription Checkout session without projecting it', async () => {
    const state = setupStripeWebhookTest();
    const session = {
      id: 'cs_unrelated',
      mode: 'subscription',
      metadata: {},
      livemode: false,
      subscription: 'sub_unrelated',
    };
    state.stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    state.setEvent(
      stripeEvent('evt_unrelated_checkout', 'checkout.session.completed', session as never),
    );

    await expect(state.call()).resolves.toEqual({ duplicate: false });
    expect(state.subscriptionModel.create).not.toHaveBeenCalled();
    expect(state.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('retries instead of acknowledging a signed UOA Checkout whose binding was removed', async () => {
    const state = setupStripeWebhookTest();
    const signed = {
      id: 'cs_1',
      mode: 'subscription',
      metadata: { uoa_checkout_id: 'checkout_1' },
      livemode: false,
      subscription: 'sub_1',
    };
    state.stripe.checkout.sessions.retrieve.mockResolvedValue({
      ...signed,
      metadata: {},
    });
    state.setEvent(
      stripeEvent('evt_checkout_binding_removed', 'checkout.session.completed', signed as never),
    );

    await expect(state.call()).rejects.toThrow('STRIPE_WEBHOOK_BINDING_STATE_DRIFT');
    expect(state.subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('retries instead of acknowledging a signed UOA subscription whose binding was removed', async () => {
    const state = setupStripeWebhookTest();
    const signed = subscription();
    state.setRemote(subscription('active', { metadata: {} }));
    state.setEvent(
      stripeEvent('evt_subscription_binding_removed', 'customer.subscription.updated', signed),
    );

    await expect(state.call()).rejects.toThrow('STRIPE_WEBHOOK_BINDING_STATE_DRIFT');
    expect(state.subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('fails closed for a UOA-marked subscription with incomplete binding metadata', async () => {
    const state = setupStripeWebhookTest();
    const malformed = subscription('active', {
      metadata: { uoa_tariff_id: 'tariff_1' },
    });
    state.setRemote(malformed);
    state.setEvent(
      stripeEvent('evt_malformed_uoa_subscription', 'customer.subscription.updated', malformed),
    );

    await expect(state.call()).rejects.toThrow('STRIPE_SUBSCRIPTION_BINDING_INVALID');
    expect(state.subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before resolving a Stripe account', async () => {
    const state = setupStripeWebhookTest();
    state.stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('invalid');
    });
    await expect(state.call()).rejects.toThrow('INVALID_STRIPE_WEBHOOK_SIGNATURE');
    expect(state.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });

  it('does not commit invoice.created until post-period usage reconciliation succeeds', async () => {
    const state = setupStripeWebhookTest();
    state.setEvent({
      ...stripeEvent('evt_invoice_created'),
      type: 'invoice.created',
      data: { object: { id: 'in_renewal' } },
    } as never);
    const reconcileInvoice = vi
      .fn()
      .mockRejectedValueOnce(new Error('LEDGER_TEMPORARILY_UNAVAILABLE'))
      .mockResolvedValueOnce({
        ledgerSnapshotCursor: 'bus_post_period',
        billingMonth: '2026-07',
        exports: [],
      });

    await expect(state.call({ reconcileInvoice, collectionEnabled: true })).rejects.toThrow(
      'LEDGER_TEMPORARILY_UNAVAILABLE',
    );
    expect(state.webhookEventCreate).not.toHaveBeenCalled();

    await expect(state.call({ reconcileInvoice, collectionEnabled: true })).resolves.toEqual({
      duplicate: false,
    });
    expect(reconcileInvoice).toHaveBeenCalledTimes(2);
    expect(state.webhookEventCreate).toHaveBeenCalledOnce();
  });

  it('leaves invoice reconciliation replayable while collection is disabled', async () => {
    const state = setupStripeWebhookTest();
    state.setEvent({
      ...stripeEvent('evt_invoice_disabled'),
      type: 'invoice.created',
      data: { object: { id: 'in_disabled' } },
    } as never);
    const reconcileInvoice = vi.fn();

    await expect(state.call({ reconcileInvoice, collectionEnabled: false })).rejects.toThrow(
      'STRIPE_INVOICE_RECONCILIATION_DISABLED',
    );
    expect(reconcileInvoice).not.toHaveBeenCalled();
    expect(state.webhookEventCreate).not.toHaveBeenCalled();
  });

  it('rejects webhook events created under a different Stripe API version', async () => {
    const state = setupStripeWebhookTest();
    state.setEvent({
      ...stripeEvent('evt_wrong_api_version'),
      api_version: '2026-06-30.basil',
    });

    await expect(state.call()).rejects.toThrow('STRIPE_WEBHOOK_API_VERSION_UNSUPPORTED');
    expect(state.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });

  it.each([
    { account: 'acct_other', livemode: false },
    { account: 'acct_uoa', livemode: true },
  ])('rejects a webhook from another Stripe account or mode', async (identity) => {
    const state = setupStripeWebhookTest();
    state.setEvent({
      ...stripeEvent('evt_wrong_account'),
      ...identity,
    });

    await expect(state.call()).rejects.toThrow('STRIPE_WEBHOOK_ACCOUNT_MISMATCH');
    expect(state.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});
