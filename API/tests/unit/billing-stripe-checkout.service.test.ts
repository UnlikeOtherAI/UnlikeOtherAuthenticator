import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
  MembershipStatus,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createStripeCheckoutSession } from '../../src/services/billing-stripe-checkout.service.js';

const now = new Date('2026-07-19T12:00:00.000Z');
const tariff = {
  id: 'tariff_1',
  serviceId: 'service_1',
  key: 'standard',
  version: 2,
  name: 'Standard',
  mode: BillingTariffMode.STANDARD,
  collectionMode: BillingCollectionMode.STRIPE,
  markupBps: 2000,
  monthlyAmountMinor: 2000n,
  currency: 'GBP',
  isDefault: true,
  createdByUserId: 'admin_1',
  createdByEmail: 'admin@example.com',
  createdAt: now,
};

const payload = {
  schema_version: 1 as const,
  snapshot_id: 'snapshot_1',
  product: { id: 'service_1', identifier: 'deepwater' },
  authorized_party: { app_key_id: 'app_key_1' },
  subject: {
    user_id: 'user_1',
    organisation_id: 'org_1',
    team_id: 'team_1',
  },
  tariff: {
    id: 'tariff_1',
    key: 'standard',
    version: 2,
    mode: 'standard' as const,
    collection_mode: 'stripe' as const,
    markup_bps: 2000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12000,
    monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
    usage_billing_enabled: true,
    payment_collection_enabled: true,
    raw_usage_preserved: true as const,
  },
  assignment: { scope: 'service_default' as const, id: null },
  issued_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 300_000).toISOString(),
};

const credential = {
  id: 'app_key_1',
  actorIssuer: 'https://ledger.example.com',
  actorAudience: 'https://auth.example.com/billing/v1/effective-tariff',
  actorKeyId: 'key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.nessie.works'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};

function setup(orgRole = 'admin') {
  let catalog = {
    id: 'catalog_1',
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
    tariffId: 'tariff_1',
    catalogId: 'catalog_1',
    monthlyAmountMinor: 2000n,
    stripeMonthlyPriceId: null as string | null,
    createdAt: now,
  };
  const customer = {
    id: 'customer_1',
    orgId: 'org_1',
    teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: 'org_1',
    stripeCustomerId: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  const checkout = {
    id: 'checkout_1',
    appKeyId: 'app_key_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    orgId: 'org_1',
    teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    scopeKey: 'org_1',
    actorJti: 'actor_jti_1',
    requestedByUserId: 'user_1',
    successUrlDigest: '',
    cancelUrlDigest: '',
    stripeCheckoutSessionId: null,
    status: 'creating',
    expiresAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const prisma = {
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
    billingStripeCheckoutSession: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => {
        Object.assign(checkout, data);
        return checkout;
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    billingStripeCustomer: {
      upsert: vi.fn().mockResolvedValue(customer),
      update: vi.fn().mockImplementation(({ data }) => {
        Object.assign(customer, data);
        return customer;
      }),
    },
    billingStripeCatalog: {
      upsert: vi.fn().mockResolvedValue(catalog),
      update: vi.fn().mockImplementation(({ data }) => {
        catalog = { ...catalog, ...data };
        return catalog;
      }),
    },
    billingStripeTariffPrice: {
      upsert: vi.fn().mockResolvedValue(priceMapping),
      update: vi.fn().mockImplementation(({ data }) => {
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

  const pricesCreate = vi.fn().mockImplementation(async (input) => ({
    id:
      input.recurring?.usage_type === 'metered'
        ? 'price_usage_1'
        : 'price_monthly_1',
  }));
  const checkoutCreate = vi.fn().mockResolvedValue({
    id: 'cs_1',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
    status: 'open',
    expires_at: 1_784_470_800,
  });
  const stripe = {
    customers: { create: vi.fn().mockResolvedValue({ id: 'cus_1' }) },
    products: { create: vi.fn().mockResolvedValue({ id: 'prod_1' }) },
    billing: { meters: { create: vi.fn().mockResolvedValue({ id: 'mtr_1' }) } },
    prices: { create: pricesCreate },
    checkout: {
      sessions: {
        create: checkoutCreate,
        retrieve: vi.fn(),
      },
    },
  };
  return { prisma, stripe, checkoutCreate };
}

describe('Stripe Checkout authorization and composition', () => {
  it('uses the authenticated product key and exact tariff for monthly plus rated usage', async () => {
    const { prisma, stripe, checkoutCreate } = setup();
    const result = await createStripeCheckoutSession(
      {
        request: {
          product: 'deepwater',
          organisationId: 'org_1',
          teamId: 'team_1',
          userId: 'user_1',
          successUrl: 'https://app.nessie.works/billing/success',
          cancelUrl: 'https://app.nessie.works/billing/cancel',
        },
        actorToken: 'signed-actor',
        credential,
      },
      {
        prisma: prisma as never,
        stripe: stripe as never,
        resolveTariff: vi.fn().mockResolvedValue({
          actor: { jti: 'actor_jti_1' },
          payload,
        }) as never,
        now: () => now,
      },
    );

    expect(result).toMatchObject({
      checkout_session_id: 'cs_1',
      tariff: { id: 'tariff_1', collection_mode: 'stripe' },
    });
    const checkoutInput = checkoutCreate.mock.calls[0]?.[0];
    expect(checkoutInput.line_items).toEqual([
      { price: 'price_monthly_1', quantity: 1 },
      { price: 'price_usage_1' },
    ]);
    expect(checkoutInput.subscription_data.metadata).toMatchObject({
      uoa_service_id: 'service_1',
      uoa_tariff_id: 'tariff_1',
      uoa_scope_key: 'org_1',
    });
    expect(checkoutInput.subscription_data).toMatchObject({
      billing_cycle_anchor: 1_785_542_400,
      proration_behavior: 'none',
    });
    expect(prisma.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'user_1',
          metadata: expect.objectContaining({ app_key_id: 'app_key_1' }),
        }),
      }),
    );
  });

  it('rejects a plain member before creating any Stripe resource', async () => {
    const { prisma, stripe } = setup('member');
    await expect(
      createStripeCheckoutSession(
        {
          request: {
            product: 'deepwater',
            organisationId: 'org_1',
            teamId: 'team_1',
            userId: 'user_1',
            successUrl: 'https://app.nessie.works/billing/success',
            cancelUrl: 'https://app.nessie.works/billing/cancel',
          },
          actorToken: 'signed-actor',
          credential,
        },
        {
          prisma: prisma as never,
          stripe: stripe as never,
          resolveTariff: vi.fn().mockResolvedValue({
            actor: { jti: 'actor_jti_1' },
            payload,
          }) as never,
        },
      ),
    ).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
