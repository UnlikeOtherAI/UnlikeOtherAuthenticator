import { BillingAssignmentScope, BillingTariffSource, MembershipStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';
import {
  account,
  credential,
  now,
  payload,
  request,
  tariff,
} from './billing-stripe-checkout.test-fixtures.js';

type MutableCheckout = {
  id: string;
  accountId: string;
  appKeyId: string;
  customerId: string;
  serviceId: string;
  tariffId: string;
  tariffSource: BillingTariffSource;
  tariffAssignmentId: string | null;
  orgId: string;
  teamId: string | null;
  scope: BillingAssignmentScope;
  scopeKey: string;
  actorJti: string;
  requestedByUserId: string;
  successUrlDigest: string;
  cancelUrlDigest: string;
  stripeCheckoutSessionId: string | null;
  status: string;
  leaseExpiresAt: Date;
  expiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function setup(orgRole = 'admin') {
  let customer = {
    id: 'customer_1',
    accountId: account.id,
    orgId: 'org_1',
    teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: 'org_1',
    stripeCustomerId: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  let catalog = {
    id: 'catalog_1',
    accountId: account.id,
    serviceId: 'service_1',
    currency: 'GBP',
    meterEventName: 'uoa_rated_hash',
    stripeProductId: null as string | null,
    stripeMeterId: null as string | null,
    stripeUsagePriceId: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  let priceMapping = {
    id: 'tariff_price_1',
    accountId: account.id,
    tariffId: 'tariff_1',
    catalogId: 'catalog_1',
    monthlyAmountMinor: 2000n,
    stripeMonthlyPriceId: null as string | null,
    createdAt: now,
  };
  const checkouts: MutableCheckout[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  let checkoutCounter = 0;
  const checkoutModel = {
    findFirst: vi
      .fn()
      .mockImplementation(async () =>
        checkouts.find((row) => ['creating', 'open'].includes(row.status)),
      ),
    create: vi.fn().mockImplementation(async ({ data }) => {
      checkoutCounter += 1;
      const row = {
        id: `checkout_${checkoutCounter}`,
        stripeCheckoutSessionId: null,
        status: 'creating',
        expiresAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      checkouts.push(row);
      return row;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }) => {
      const row = checkouts.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data, { updatedAt: now });
      return row;
    }),
    updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
      const row = checkouts.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.status === where.status &&
          candidate.stripeCheckoutSessionId === where.stripeCheckoutSessionId,
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user_1',
        email: 'owner@example.com',
        name: 'Owner',
      }),
    },
    organisation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org_1', name: 'Example Org' }),
    },
    team: { findUnique: vi.fn() },
    orgMember: {
      findUnique: vi.fn().mockResolvedValue({
        role: orgRole,
        status: MembershipStatus.ACTIVE,
      }),
    },
    teamMember: { findUnique: vi.fn() },
    billingTariff: { findFirst: vi.fn().mockResolvedValue(tariff) },
    billingStripeSubscription: { findFirst: vi.fn().mockResolvedValue(null) },
    billingStripeCheckoutSession: checkoutModel,
    billingStripeCustomer: {
      upsert: vi.fn().mockImplementation(async () => customer),
      update: vi.fn().mockImplementation(async ({ data }) => {
        customer = { ...customer, ...data };
        return customer;
      }),
    },
    billingStripeCatalog: {
      upsert: vi.fn().mockImplementation(async () => catalog),
      update: vi.fn().mockImplementation(async ({ data }) => {
        catalog = { ...catalog, ...data };
        return catalog;
      }),
    },
    billingStripeTariffPrice: {
      upsert: vi.fn().mockImplementation(async () => priceMapping),
      update: vi.fn().mockImplementation(async ({ data }) => {
        priceMapping = { ...priceMapping, ...data };
        return priceMapping;
      }),
    },
    orgAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: typeof prisma) => unknown)(prisma);
    }),
  };

  const prices = new Map<string, Record<string, unknown>>();
  const products = new Map<string, Record<string, unknown>>();
  const meters = new Map<string, Record<string, unknown>>();
  const pricesCreate = vi.fn().mockImplementation(async (input) => {
    const id = input.recurring?.usage_type === 'metered' ? 'price_usage_1' : 'price_monthly_1';
    const row = {
      id,
      livemode: false,
      product: input.product,
      currency: input.currency,
      unit_amount_decimal: input.unit_amount_decimal ?? null,
      recurring: input.recurring,
      metadata: input.metadata,
    };
    prices.set(id, row);
    return row;
  });
  const checkoutCreate = vi.fn().mockImplementation(async (input) => {
    const session = {
      id: `cs_${sessions.size + 1}`,
      url: `https://checkout.stripe.com/c/pay/cs_${sessions.size + 1}`,
      status: 'open',
      expires_at: 1_784_470_800,
      livemode: false,
      customer: input.customer,
      client_reference_id: input.client_reference_id,
      metadata: input.metadata,
      mode: input.mode,
      subscription: null,
    };
    sessions.set(session.id, session);
    return session;
  });
  const stripe = {
    accounts: {
      retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }),
    },
    customers: {
      create: vi.fn().mockResolvedValue({
        id: 'cus_1',
        livemode: false,
        metadata: {},
      }),
      retrieve: vi.fn().mockImplementation(async () => ({
        id: 'cus_1',
        livemode: false,
        metadata: {
          uoa_scope: 'organisation',
          uoa_scope_key: 'org_1',
          uoa_organisation_id: 'org_1',
          uoa_stripe_account_id: 'acct_uoa',
          uoa_stripe_mode: 'test',
        },
      })),
    },
    products: {
      create: vi.fn().mockImplementation(async (input) => {
        const row = { id: 'prod_1', livemode: false, metadata: input.metadata };
        products.set(row.id, row);
        return row;
      }),
      retrieve: vi.fn().mockImplementation(async (id) => products.get(id)),
    },
    billing: {
      meters: {
        create: vi.fn().mockImplementation(async (input) => {
          const row = {
            id: 'mtr_1',
            livemode: false,
            event_name: input.event_name,
            default_aggregation: input.default_aggregation,
          };
          meters.set(row.id, row);
          return row;
        }),
        retrieve: vi.fn().mockImplementation(async (id) => meters.get(id)),
      },
    },
    prices: {
      create: pricesCreate,
      retrieve: vi.fn().mockImplementation(async (id) => prices.get(id)),
    },
    checkout: {
      sessions: {
        create: checkoutCreate,
        retrieve: vi.fn().mockImplementation(async (id) => sessions.get(id)),
        list: vi.fn().mockImplementation(async () => ({
          data: [...sessions.values()],
          has_more: false,
        })),
      },
    },
  };
  return { prisma, stripe, checkoutCreate, checkouts, sessions };
}

function deps(
  state: ReturnType<typeof setup>,
  actorJti = 'actor_jti_1',
  extra: Record<string, unknown> = {},
) {
  return {
    prisma: state.prisma as never,
    stripe: state.stripe as never,
    stripeLivemode: false,
    resolveTariff: vi.fn().mockResolvedValue({
      actor: { jti: actorJti },
      payload,
    }) as never,
    now: () => now,
    ...extra,
  };
}

describe('Stripe Checkout authorization, recovery, and account binding', () => {
  it('uses the exact account, product key, tariff, monthly item, and rated item', async () => {
    const state = setup();
    const result = await createStripeCheckoutSession(
      { request, actorToken: 'signed-actor', credential },
      deps(state),
    );
    expect(result.checkout_session_id).toBe('cs_1');
    const input = state.checkoutCreate.mock.calls[0]?.[0];
    expect(input.line_items).toEqual([
      { price: 'price_monthly_1', quantity: 1 },
      { price: 'price_usage_1' },
    ]);
    expect(input.subscription_data.metadata).toMatchObject({
      uoa_tariff_id: 'tariff_1',
      uoa_stripe_account_id: 'acct_uoa',
      uoa_stripe_mode: 'test',
    });
    expect(input.subscription_data).toMatchObject({
      billing_cycle_anchor: 1_785_542_400,
      proration_behavior: 'none',
    });
    expect(state.checkoutCreate.mock.calls[0]?.[1].idempotencyKey).toContain(
      'acct_uoa:test:checkout:',
    );
  });

  it('rejects a cross-origin checkout redirect before creating Stripe resources', async () => {
    const state = setup();
    await expect(
      createStripeCheckoutSession(
        {
          request: {
            ...request,
            successUrl: 'https://attacker.example/billing/success',
          },
          actorToken: 'signed-actor',
          credential,
        },
        deps(state),
      ),
    ).rejects.toThrow('STRIPE_RETURN_URL_NOT_ALLOWED');
    expect(state.stripe.accounts.retrieveCurrent).not.toHaveBeenCalled();
    expect(state.stripe.customers.create).not.toHaveBeenCalled();
    expect(state.checkoutCreate).not.toHaveBeenCalled();
  });

  it('rejects a plain member before creating a mutable Stripe resource', async () => {
    const state = setup('member');
    await expect(
      createStripeCheckoutSession({ request, actorToken: 'signed-actor', credential }, deps(state)),
    ).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    expect(state.stripe.customers.create).not.toHaveBeenCalled();
  });

  it('recovers an open checkout by billing scope with a fresh actor JTI', async () => {
    const state = setup();
    await createStripeCheckoutSession(
      { request, actorToken: 'actor-1', credential },
      deps(state, 'jti_1'),
    );
    const replay = await createStripeCheckoutSession(
      { request, actorToken: 'actor-2', credential },
      deps(state, 'jti_2'),
    );
    expect(replay.checkout_session_id).toBe('cs_1');
    expect(state.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(state.checkouts).toHaveLength(1);
  });

  it('recovers the scope winner when checkout lease creation races', async () => {
    const state = setup();
    state.checkouts.push({
      id: 'checkout_race_winner',
      accountId: account.id,
      appKeyId: credential.id,
      customerId: 'customer_1',
      serviceId: 'service_1',
      tariffId: 'tariff_1',
      tariffSource: BillingTariffSource.SERVICE_DEFAULT,
      tariffAssignmentId: null,
      orgId: 'org_1',
      teamId: null,
      scope: BillingAssignmentScope.ORGANISATION,
      scopeKey: 'org_1',
      actorJti: 'racing_actor',
      requestedByUserId: 'user_1',
      successUrlDigest: 'f72a19f759a9273a635f30755ce567539e7d96a3321c0a1a05ff7cf1de7fe940',
      cancelUrlDigest: 'd6686be8110ab23fd2fa6ffeabd5fec2ea532406ff777a1a6230f433adf77003',
      stripeCheckoutSessionId: null,
      status: 'creating',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      expiresAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.prisma.billingStripeCheckoutSession.findFirst.mockResolvedValueOnce(null);
    state.prisma.billingStripeCheckoutSession.create.mockRejectedValueOnce({
      code: 'P2002',
    });

    const result = await createStripeCheckoutSession(
      { request, actorToken: 'actor-racer', credential },
      deps(state, 'jti_racer'),
    );

    expect(result.checkout_session_id).toBe('cs_1');
    expect(state.checkoutCreate.mock.calls[0]?.[0].client_reference_id).toBe(
      'checkout_race_winner',
    );
    expect(state.checkouts).toHaveLength(1);
  });

  it('reconciles a crash after Stripe creation without creating a second session', async () => {
    const state = setup();
    await expect(
      createStripeCheckoutSession(
        { request, actorToken: 'actor-1', credential },
        deps(state, 'jti_1', {
          afterStripeSessionCreated: () => {
            throw new Error('kill point');
          },
        }),
      ),
    ).rejects.toThrow('kill point');
    expect(state.checkouts[0]?.stripeCheckoutSessionId).toBeNull();
    const recovered = await createStripeCheckoutSession(
      { request, actorToken: 'actor-2', credential },
      deps(state, 'jti_2'),
    );
    expect(recovered.checkout_session_id).toBe('cs_1');
    expect(state.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(state.checkouts[0]?.stripeCheckoutSessionId).toBe('cs_1');
  });

  it('abandons an expired creating lease with no Stripe session and reuses the scope', async () => {
    const state = setup();
    state.checkouts.push({
      id: 'checkout_stale',
      accountId: account.id,
      appKeyId: credential.id,
      customerId: 'customer_1',
      serviceId: 'service_1',
      tariffId: 'tariff_1',
      tariffSource: BillingTariffSource.SERVICE_DEFAULT,
      tariffAssignmentId: null,
      orgId: 'org_1',
      teamId: null,
      scope: BillingAssignmentScope.ORGANISATION,
      scopeKey: 'org_1',
      actorJti: 'old',
      requestedByUserId: 'user_1',
      successUrlDigest: 'f72a19f759a9273a635f30755ce567539e7d96a3321c0a1a05ff7cf1de7fe940',
      cancelUrlDigest: 'd6686be8110ab23fd2fa6ffeabd5fec2ea532406ff777a1a6230f433adf77003',
      stripeCheckoutSessionId: null,
      status: 'creating',
      leaseExpiresAt: new Date(now.getTime() - 1),
      expiresAt: null,
      completedAt: null,
      createdAt: new Date(now.getTime() - 3_600_000),
      updatedAt: new Date(now.getTime() - 3_600_000),
    });
    await createStripeCheckoutSession(
      { request, actorToken: 'actor-2', credential },
      deps(state, 'jti_2'),
    );
    expect(state.checkouts[0]?.status).toBe('abandoned');
    expect(state.checkouts).toHaveLength(2);
  });
});
