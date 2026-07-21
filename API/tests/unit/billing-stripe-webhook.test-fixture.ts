import { BillingAssignmentScope, BillingTariffSource } from '@prisma/client';
import { vi } from 'vitest';

import { handleStripeWebhook } from '../../src/services/billing-stripe-webhook.service.js';

const now = new Date('2026-07-19T00:00:00.000Z');

export const account = {
  id: 'stripe_account_test',
  stripeAccountId: 'acct_uoa',
  livemode: false,
  createdAt: now,
  updatedAt: now,
};

export function subscription(status = 'active', overrides: Record<string, unknown> = {}) {
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

export function stripeEvent(
  id: string,
  type = 'customer.subscription.updated',
  payload = subscription(),
) {
  return {
    id,
    type,
    api_version: '2026-06-24.dahlia',
    account: 'acct_uoa',
    livemode: false,
    created: 1_784_467_200,
    data: { object: payload },
  };
}

export function setupStripeWebhookTest() {
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
    billingRecurringAddonCheckout: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    billingRecurringAddonSubscription: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    billingStripeWebhookEvent: { findUnique: eventFind },
    billingRecurringAddonCheckout: tx.billingRecurringAddonCheckout,
    billingRecurringAddonSubscription: tx.billingRecurringAddonSubscription,
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
    invoices: { retrieve: vi.fn() },
  };
  const call = (overrides: Partial<NonNullable<Parameters<typeof handleStripeWebhook>[1]>> = {}) =>
    handleStripeWebhook(
      { rawBody: Buffer.from('{}'), signature: 't=1,v1=valid' },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        stripeLivemode: false,
        webhookSecret: 'whsec_test',
        ...overrides,
      },
    );
  return {
    prisma,
    stripe,
    call,
    subscriptionModel,
    eventFind,
    webhookEventCreate: tx.billingStripeWebhookEvent.create,
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
