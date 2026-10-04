import { BillingAssignmentScope, BillingRecurringAddonEntitlementScope } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  ensureCatalog: vi.fn(),
  ensureCustomer: vi.fn(),
  resolveAccount: vi.fn(),
  resolveContext: vi.fn(),
  resolveViewer: vi.fn(),
}));

vi.mock('../../src/services/billing-entitlement.service.js', () => ({
  resolveEffectiveTariffContext: mocks.resolveContext,
}));
vi.mock('../../src/services/billing-funding-viewer.service.js', () => ({
  resolveBillingFundingViewer: mocks.resolveViewer,
}));
vi.mock('../../src/services/billing-customer-action-intent.service.js', () => ({
  authorizeBillingCustomerAction: mocks.authorizeAction,
  BILLING_CUSTOMER_ACTION: { RECURRING_ADDON_CHECKOUT: 'RECURRING_ADDON_CHECKOUT' },
}));
vi.mock('../../src/services/billing-stripe-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/billing-stripe-client.service.js')>();
  return { ...actual, resolveStripeAccountContext: mocks.resolveAccount };
});
vi.mock('../../src/services/billing-recurring-addon-catalog.service.js', () => ({
  ensureRecurringAddonStripeCatalog: mocks.ensureCatalog,
}));
vi.mock('../../src/services/billing-stripe-checkout-state.service.js', () => ({
  ensureStripeCustomer: mocks.ensureCustomer,
}));

import { createRecurringAddonCheckout } from '../../src/services/billing-recurring-addon-checkout.service.js';

const account = { id: 'stripe_account', stripeAccountId: 'acct_test', livemode: false };
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
  offerId: 'offer_1',
};
const credential = {
  id: 'app_key_1',
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
  checkoutReturnOrigins: ['https://product.example'],
};
const now = new Date('2026-10-04T10:00:00Z');

function setup() {
  const catalog = {
    id: 'catalog_1',
    accountId: account.id,
    serviceId: 'service_1',
    offerId: 'offer_1',
    currency: 'USD',
    monthlyAmountMinor: 5000n,
    stripeProductId: 'prod_1',
    stripePriceId: 'price_1',
  };
  const offer = {
    id: 'offer_1',
    serviceId: 'service_1',
    key: 'privacy',
    active: true,
    featurePolicies: [
      { entitlementScope: BillingRecurringAddonEntitlementScope.TEAM, active: true },
    ],
    catalogs: [catalog],
  };
  const customer = {
    id: 'customer_1',
    accountId: account.id,
    orgId: 'org_1',
    teamId: 'team_1',
    scope: BillingAssignmentScope.TEAM,
    stripeCustomerId: 'cus_1',
  };
  const checkouts: Array<Record<string, unknown>> = [];
  const checkoutCreate = vi.fn()
    .mockRejectedValueOnce(new Error('lost response'))
    .mockImplementation(async (input) => ({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      status: 'open',
      expires_at: 1_791_110_000,
      livemode: false,
      customer: input.customer,
      client_reference_id: input.client_reference_id,
      metadata: input.metadata,
      mode: input.mode,
    }));
  const checkoutModel = {
    findFirst: vi.fn().mockImplementation(async () =>
      checkouts.find((row) => ['CREATING', 'OPEN', 'NEEDS_REVIEW'].includes(String(row.status))) ?? null,
    ),
    create: vi.fn().mockImplementation(async ({ data }) => {
      const row = { id: 'checkout_1', stripeCheckoutSessionId: null, status: 'CREATING', ...data };
      checkouts.push(row);
      return row;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }) => {
      const row = checkouts.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
  };
  const prisma = {
    billingRecurringAddonOffer: { findFirst: vi.fn().mockResolvedValue(offer) },
    billingRecurringAddonSubscription: { findFirst: vi.fn().mockResolvedValue(null) },
    billingRecurringAddonCheckout: checkoutModel,
    billingStripeCustomer: { upsert: vi.fn().mockResolvedValue(customer) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user_1', email: 'a@example.com' }) },
    organisation: { findUnique: vi.fn().mockResolvedValue({ id: 'org_1', name: 'Org' }) },
    team: { findFirst: vi.fn().mockResolvedValue({ id: 'team_1', name: 'Team' }) },
    orgMember: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    teamMember: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    orgAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (input: unknown) =>
      Array.isArray(input)
        ? Promise.all(input)
        : (input as (tx: typeof prisma) => unknown)(prisma),
    ),
  };
  const stripe = {
    checkout: { sessions: { create: checkoutCreate, retrieve: vi.fn() } },
  };
  mocks.resolveContext.mockResolvedValue({ actor: { jti: 'actor_1' } });
  mocks.resolveViewer.mockResolvedValue({
    organisationRole: 'admin',
    teamRole: 'admin',
  });
  mocks.resolveAccount.mockResolvedValue(account);
  mocks.ensureCatalog.mockImplementation(async ({ catalog: value }) => value);
  mocks.ensureCustomer.mockImplementation(async ({ customer: value }) => value);
  mocks.authorizeAction.mockResolvedValue(undefined);
  return { checkouts, checkoutCreate, prisma, stripe };
}

describe('recurring add-on Checkout language retry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reuses the first language and identical Stripe request after a lost response', async () => {
    const state = setup();
    const common = {
      request,
      actorToken: 'signed-actor',
      credential: credential as never,
      endpoint: '/billing/v1/recurring-addon/checkout' as never,
      deps: undefined,
    };
    await expect(createRecurringAddonCheckout(
      { ...common, locale: 'cs' },
      { prisma: state.prisma as never, stripe: state.stripe as never, now: () => now },
    )).rejects.toThrow('lost response');
    expect(state.checkouts[0]).toMatchObject({ checkoutLocale: 'cs' });

    await createRecurringAddonCheckout(
      { ...common, locale: 'de' },
      { prisma: state.prisma as never, stripe: state.stripe as never, now: () => now },
    );

    expect(state.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(state.checkoutCreate.mock.calls[0]?.[0].locale).toBe('cs');
    expect(state.checkoutCreate.mock.calls[1]?.[0].locale).toBe('cs');
    expect(state.checkoutCreate.mock.calls[0]?.[1]).toEqual(
      state.checkoutCreate.mock.calls[1]?.[1],
    );
  });
});
