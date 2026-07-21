import {
  BillingRecurringAddonCheckoutStatus,
  BillingRecurringAddonEntitlementScope,
  BillingRecurringAddonSubscriptionScope,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { applyRecurringAddonWebhook } from '../../src/services/billing-recurring-addon-webhook-apply.service.js';
import { recurringAddonMetadata } from '../../src/services/billing-recurring-addon-stripe-binding.service.js';
import { prepareRecurringAddonWebhook } from '../../src/services/billing-recurring-addon-webhook.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const account = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
  createdAt: now,
  updatedAt: now,
};
const catalog = {
  id: 'catalog_privacy',
  accountId: account.id,
  offerId: 'offer_privacy',
  currency: 'USD',
  monthlyAmountMinor: 5_000n,
  stripeProductId: 'prod_privacy',
  stripePriceId: 'price_privacy',
};
const customer = {
  id: 'customer_team',
  stripeCustomerId: 'cus_team',
};
const checkout = {
  id: 'checkout_privacy',
  accountId: account.id,
  appKeyId: 'app_key_deepwater',
  customerId: customer.id,
  catalogId: catalog.id,
  serviceId: 'service_deepwater',
  offerId: 'offer_privacy',
  offerKey: 'privacy',
  orgId: 'org_example',
  teamId: 'team_example',
  requestedTeamId: 'team_example',
  subscribingUserId: null,
  scope: BillingRecurringAddonSubscriptionScope.TEAM,
  scopeKey: 'org_example:team_example',
  actorJti: 'actor_jti',
  subjectFingerprint: 'a'.repeat(64),
  requestedByUserId: 'user_example',
  successUrlDigest: 'b'.repeat(64),
  cancelUrlDigest: 'c'.repeat(64),
  stripeCheckoutSessionId: 'cs_privacy',
  stripeSubscriptionId: null,
  completionWebhookEventId: null,
  status: BillingRecurringAddonCheckoutStatus.OPEN,
  leaseExpiresAt: now,
  expiresAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  catalog,
  customer,
};
const metadata = recurringAddonMetadata(checkout, account);

function remoteSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_privacy',
    customer: customer.stripeCustomerId,
    metadata,
    livemode: false,
    status: 'active',
    cancel_at_period_end: false,
    discounts: [],
    items: {
      data: [
        {
          id: 'si_privacy',
          quantity: 1,
          discounts: [],
          current_period_start: 1_784_630_400,
          current_period_end: 1_787_308_800,
          price: {
            id: catalog.stripePriceId,
            recurring: { interval: 'month', usage_type: 'licensed' },
          },
        },
      ],
    },
    ...overrides,
  };
}

function localSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local_sub_privacy',
    accountId: account.id,
    checkoutId: checkout.id,
    customerId: customer.id,
    catalogId: catalog.id,
    serviceId: checkout.serviceId,
    offerId: checkout.offerId,
    offerKey: checkout.offerKey,
    orgId: checkout.orgId,
    teamId: checkout.teamId,
    subscribingUserId: null,
    scope: checkout.scope,
    scopeKey: checkout.scopeKey,
    stripeSubscriptionId: 'sub_privacy',
    stripeItemId: 'si_privacy',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: now,
    currentPeriodEnd: new Date('2026-08-21T12:00:00.000Z'),
    initialInvoicePaidAt: null,
    initialInvoiceId: null,
    activationWebhookEventId: null,
    entitlementActivatedAt: null,
    entitlementDeactivatedAt: null,
    livemode: false,
    createdAt: now,
    updatedAt: now,
    checkout,
    catalog,
    customer,
    offer: {
      id: checkout.offerId,
      name: 'Private research',
      active: true,
      currency: catalog.currency,
      monthlyAmountMinor: catalog.monthlyAmountMinor,
      featurePolicies: [
        { entitlementScope: BillingRecurringAddonEntitlementScope.TEAM, active: true },
      ],
    },
    ...overrides,
  };
}

function checkoutSession() {
  return {
    id: checkout.stripeCheckoutSessionId,
    client_reference_id: checkout.id,
    customer: customer.stripeCustomerId,
    subscription: 'sub_privacy',
    metadata,
    livemode: false,
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    expires_at: 1_784_631_000,
  };
}

function paidInvoice(overrides: Record<string, unknown> = {}) {
  const line = {
    id: 'il_privacy',
    amount: 5_000,
    subtotal: 5_000,
    currency: 'usd',
    quantity: 1,
    discounts: [],
    discount_amounts: [],
    pretax_credit_amounts: [],
    taxes: [],
    subscription: 'sub_privacy',
    parent: {
      type: 'subscription_item_details',
      subscription_item_details: {
        proration: false,
        subscription: 'sub_privacy',
        subscription_item: 'si_privacy',
      },
    },
    pricing: {
      price_details: { price: catalog.stripePriceId },
      unit_amount_decimal: '5000',
    },
  };
  return {
    id: 'in_privacy_initial',
    customer: customer.stripeCustomerId,
    livemode: false,
    status: 'paid',
    billing_reason: 'subscription_create',
    collection_method: 'charge_automatically',
    amount_due: 5_000,
    amount_paid: 5_000,
    amount_remaining: 0,
    subtotal: 5_000,
    total: 5_000,
    currency: 'usd',
    starting_balance: 0,
    amount_shipping: 0,
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    discounts: [],
    total_discount_amounts: [],
    total_pretax_credit_amounts: [],
    total_taxes: [],
    default_tax_rates: [],
    lines: { data: [line], has_more: false },
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_privacy', metadata },
    },
    ...overrides,
  };
}

function event(type: string, object: unknown) {
  return {
    id: `evt_${type.replaceAll('.', '_')}`,
    type,
    api_version: '2026-06-24.dahlia',
    account: account.stripeAccountId,
    livemode: false,
    created: 1_784_635_200,
    data: { object },
  };
}

describe('recurring add-on Stripe webhook proof', () => {
  it('creates a pending projection at Checkout completion without activating entitlement', async () => {
    const session = checkoutSession();
    const remote = remoteSubscription();
    const prisma = {
      billingRecurringAddonCheckout: {
        findUnique: vi.fn().mockResolvedValue(checkout),
        findFirst: vi.fn(),
      },
      billingRecurringAddonSubscription: { findUnique: vi.fn() },
    };
    const stripe = {
      checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } },
      subscriptions: { retrieve: vi.fn().mockResolvedValue(remote) },
      invoices: { retrieve: vi.fn() },
    };
    const prepared = await prepareRecurringAddonWebhook(
      event('checkout.session.completed', session) as never,
      stripe as never,
      account,
      prisma as never,
    );
    expect(prepared?.kind).toBe('checkout_completed');
    if (!prepared) throw new Error('Expected recurring add-on Checkout preparation');

    const tx = {
      billingRecurringAddonCheckout: { update: vi.fn(), updateMany: vi.fn() },
      billingRecurringAddonSubscription: { create: vi.fn(), update: vi.fn() },
    };
    await applyRecurringAddonWebhook(tx as never, prepared, 'webhook_checkout', account);
    expect(tx.billingRecurringAddonSubscription.create).toHaveBeenCalledOnce();
    const createCall = tx.billingRecurringAddonSubscription.create.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(createCall?.data).not.toHaveProperty('initialInvoicePaidAt');
    expect(createCall?.data).not.toHaveProperty('activationWebhookEventId');
    expect(createCall?.data).not.toHaveProperty('entitlementActivatedAt');
  });

  it('activates only after an exact paid initial invoice', async () => {
    const invoice = paidInvoice();
    const local = localSubscription();
    const remote = remoteSubscription();
    const prisma = {
      billingRecurringAddonCheckout: { findUnique: vi.fn(), findFirst: vi.fn() },
      billingRecurringAddonSubscription: { findUnique: vi.fn().mockResolvedValue(local) },
    };
    const stripe = {
      checkout: { sessions: { retrieve: vi.fn() } },
      subscriptions: { retrieve: vi.fn().mockResolvedValue(remote) },
      invoices: { retrieve: vi.fn().mockResolvedValue(invoice) },
    };
    const prepared = await prepareRecurringAddonWebhook(
      event('invoice.paid', invoice) as never,
      stripe as never,
      account,
      prisma as never,
    );
    expect(prepared?.kind).toBe('invoice_paid');
    if (!prepared) throw new Error('Expected recurring add-on invoice preparation');

    const update = vi.fn();
    const tx = {
      billingRecurringAddonCheckout: { update: vi.fn(), updateMany: vi.fn() },
      billingRecurringAddonSubscription: { create: vi.fn(), update },
    };
    await applyRecurringAddonWebhook(tx as never, prepared, 'webhook_invoice', account);
    expect(update).toHaveBeenCalledWith({
      where: { id: local.id },
      data: expect.objectContaining({
        initialInvoiceId: invoice.id,
        activationWebhookEventId: 'webhook_invoice',
        entitlementActivatedAt: new Date('2026-07-21T12:00:00.000Z'),
      }),
    });
  });

  it.each([
    ['amount drift', { amount_paid: 4_000 }],
    ['a discount', { discounts: [{ id: 'di_attacker' }] }],
  ])('rejects %s before activation', async (_label, overrides) => {
    const invoice = paidInvoice(overrides);
    const local = localSubscription();
    const prisma = {
      billingRecurringAddonCheckout: { findUnique: vi.fn(), findFirst: vi.fn() },
      billingRecurringAddonSubscription: { findUnique: vi.fn().mockResolvedValue(local) },
    };
    const stripe = {
      checkout: { sessions: { retrieve: vi.fn() } },
      subscriptions: { retrieve: vi.fn().mockResolvedValue(remoteSubscription()) },
      invoices: { retrieve: vi.fn().mockResolvedValue(invoice) },
    };

    await expect(
      prepareRecurringAddonWebhook(
        event('invoice.paid', invoice) as never,
        stripe as never,
        account,
        prisma as never,
      ),
    ).rejects.toMatchObject({ message: 'STRIPE_RECURRING_ADDON_INITIAL_INVOICE_INVALID' });
  });

  it('deactivates a terminal subscription once and never resurrects it', async () => {
    const remote = remoteSubscription({ status: 'canceled', cancel_at_period_end: true });
    const local = localSubscription({
      entitlementActivatedAt: new Date('2026-07-21T11:00:00.000Z'),
    });
    const prisma = {
      billingRecurringAddonCheckout: { findUnique: vi.fn(), findFirst: vi.fn() },
      billingRecurringAddonSubscription: { findUnique: vi.fn().mockResolvedValue(local) },
    };
    const stripe = {
      checkout: { sessions: { retrieve: vi.fn() } },
      subscriptions: { retrieve: vi.fn().mockResolvedValue(remote) },
      invoices: { retrieve: vi.fn() },
    };
    const prepared = await prepareRecurringAddonWebhook(
      event('customer.subscription.deleted', remote) as never,
      stripe as never,
      account,
      prisma as never,
    );
    expect(prepared?.kind).toBe('subscription_sync');
    if (!prepared) throw new Error('Expected terminal recurring add-on preparation');

    const update = vi.fn();
    const tx = {
      billingRecurringAddonCheckout: { update: vi.fn(), updateMany: vi.fn() },
      billingRecurringAddonSubscription: { create: vi.fn(), update },
    };
    await applyRecurringAddonWebhook(tx as never, prepared, 'webhook_terminal', account);
    expect(update).toHaveBeenCalledWith({
      where: { id: local.id },
      data: expect.objectContaining({
        status: 'canceled',
        cancelAtPeriodEnd: true,
        entitlementDeactivatedAt: new Date('2026-07-21T12:00:00.000Z'),
      }),
    });

    const terminalPrepared = {
      ...prepared,
      local: localSubscription({
        status: 'canceled',
        cancelAtPeriodEnd: true,
        entitlementActivatedAt: new Date('2026-07-21T11:00:00.000Z'),
        entitlementDeactivatedAt: new Date('2026-07-21T12:00:00.000Z'),
      }),
    };
    update.mockClear();
    await applyRecurringAddonWebhook(
      tx as never,
      terminalPrepared,
      'webhook_terminal_replay',
      account,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects signed/current metadata removal instead of acknowledging it', async () => {
    const payload = remoteSubscription();
    const remote = remoteSubscription({ metadata: {} });
    const prisma = {
      billingRecurringAddonCheckout: { findUnique: vi.fn(), findFirst: vi.fn() },
      billingRecurringAddonSubscription: {
        findUnique: vi.fn().mockResolvedValue(localSubscription()),
      },
    };
    const stripe = {
      checkout: { sessions: { retrieve: vi.fn() } },
      subscriptions: { retrieve: vi.fn().mockResolvedValue(remote) },
      invoices: { retrieve: vi.fn() },
    };

    await expect(
      prepareRecurringAddonWebhook(
        event('customer.subscription.updated', payload) as never,
        stripe as never,
        account,
        prisma as never,
      ),
    ).rejects.toMatchObject({ message: 'STRIPE_WEBHOOK_BINDING_STATE_DRIFT' });
  });
});
