import { BillingAppKeyPurpose, BillingAssignmentScope, MembershipStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createStripePortalSession,
  getStripeSubscriptionSummary,
} from '../../src/services/billing-stripe-subscription.service.js';

const now = new Date('2026-07-20T12:00:00.000Z');
const account = {
  id: 'stripe_account_row',
  stripeAccountId: 'acct_uoa_test',
  livemode: false,
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
    version: 1,
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
  assignment: { scope: 'team' as const, id: 'assignment_1' },
  issued_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 300_000).toISOString(),
};
const credential = {
  id: 'app_key_1',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.nessie.works'],
  service: { id: 'service_1', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};

function setup(params?: { orgRole?: string; teamRole?: string }) {
  const subscription = {
    id: 'subscription_row_1',
    accountId: account.id,
    checkoutId: 'checkout_1',
    customerId: 'customer_1',
    serviceId: 'service_1',
    tariffId: 'tariff_1',
    tariffSource: 'TEAM',
    tariffAssignmentId: 'assignment_1',
    orgId: 'org_1',
    teamId: 'team_1',
    scope: BillingAssignmentScope.TEAM,
    scopeKey: 'org_1:team_1',
    stripeSubscriptionId: 'sub_123',
    stripeMonthlyItemId: 'si_monthly',
    stripeUsageItemId: 'si_usage',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    livemode: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: now,
    customer: { stripeCustomerId: 'cus_123' },
    account: {
      stripeAccountId: account.stripeAccountId,
      livemode: false,
    },
  };
  const prisma = {
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue(account) },
    billingStripeSubscription: {
      findFirst: vi.fn().mockImplementation(async () => subscription),
      findMany: vi.fn().mockImplementation(async () => [subscription]),
    },
    orgMember: {
      findUnique: vi.fn().mockResolvedValue({
        role: params?.orgRole ?? 'member',
        status: MembershipStatus.ACTIVE,
      }),
    },
    teamMember: {
      findUnique: vi.fn().mockResolvedValue({
        teamRole: params?.teamRole ?? 'member',
        status: MembershipStatus.ACTIVE,
      }),
    },
    orgAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const remoteSubscription = {
    id: 'sub_123',
    livemode: false,
    cancel_at_period_end: true,
  };
  const stripe = {
    accounts: {
      retrieveCurrent: vi.fn().mockResolvedValue({ id: account.stripeAccountId }),
    },
    subscriptions: {
      update: vi.fn().mockResolvedValue(remoteSubscription),
      retrieve: vi.fn(),
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'bps_123',
          livemode: false,
          url: 'https://billing.stripe.com/p/session/test',
        }),
      },
    },
  };
  const refreshSubscription = vi.fn().mockResolvedValue(remoteSubscription);
  return {
    prisma,
    stripe,
    refreshSubscription,
  };
}

function deps(state: ReturnType<typeof setup>) {
  return {
    prisma: state.prisma as never,
    stripe: state.stripe as never,
    stripeLivemode: false,
    resolveTariff: vi.fn().mockResolvedValue({ actor: { jti: 'actor_1' }, payload }) as never,
    refreshSubscription: state.refreshSubscription as never,
    authorizeAction: vi.fn().mockResolvedValue({ id: 'action_1' }) as never,
  };
}

describe('Stripe customer subscription lifecycle', () => {
  it('returns an account-scoped, refreshed summary without Stripe identifiers', async () => {
    const state = setup();
    const result = await getStripeSubscriptionSummary(
      { request, actorToken: 'signed-actor', credential },
      deps(state),
    );

    expect(result).toMatchObject({
      stripe_collection_enabled: true,
      stripe_mode: 'test',
      can_manage: false,
      subscription: {
        id: 'subscription_row_1',
        status: 'active',
        scope: 'team',
        billing_phase: 'calendar_month',
      },
    });
    expect(result.subscription).not.toHaveProperty('stripe_subscription_id');
    expect(state.refreshSubscription).toHaveBeenCalledWith(
      { subscriptionId: 'sub_123', account },
      expect.objectContaining({ prisma: state.prisma, stripe: state.stripe }),
    );
    expect(state.prisma.billingStripeSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountId: account.id,
          serviceId: 'service_1',
          orgId: 'org_1',
        }),
      }),
    );
  });

  it('requires a billing manager before creating a customer portal session', async () => {
    const state = setup();
    await expect(
      createStripePortalSession(
        {
          request: { ...request, returnUrl: 'https://app.nessie.works/billing' },
          actorToken: 'signed-actor',
          credential,
        },
        deps(state),
      ),
    ).rejects.toThrow('BILLING_MANAGER_REQUIRED');
    expect(state.stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('returns the last account-scoped projection with an explicit disabled flag', async () => {
    const state = setup({ orgRole: 'admin' });
    const result = await getStripeSubscriptionSummary(
      { request, actorToken: 'signed-actor', credential },
      {
        prisma: state.prisma as never,
        resolveTariff: vi.fn().mockResolvedValue({ actor: { jti: 'actor_1' }, payload }) as never,
      },
    );

    expect(result).toMatchObject({
      stripe_collection_enabled: false,
      stripe_mode: 'test',
      can_manage: true,
      subscription: {
        id: 'subscription_row_1',
        status: 'active',
        synced_at: now.toISOString(),
      },
    });
    expect(state.refreshSubscription).not.toHaveBeenCalled();
  });

  it('rejects a lifecycle key attempting to impersonate another product', async () => {
    const state = setup();
    await expect(
      getStripeSubscriptionSummary(
        {
          request: { ...request, product: 'deepsignal' },
          actorToken: 'signed-actor',
          credential,
        },
        { prisma: state.prisma as never },
      ),
    ).rejects.toThrow('BILLING_PRODUCT_MISMATCH');
  });

  it('creates an allowlisted portal session for a team admin', async () => {
    const state = setup({ teamRole: 'admin' });
    await expect(
      createStripePortalSession(
        {
          request: { ...request, returnUrl: 'https://app.nessie.works/billing' },
          actorToken: 'signed-actor',
          credential,
        },
        deps(state),
      ),
    ).resolves.toEqual({
      portal_url: 'https://billing.stripe.com/p/session/test',
    });
    expect(state.stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      {
        customer: 'cus_123',
        return_url: 'https://app.nessie.works/billing',
      },
      { idempotencyKey: 'uoa:billing-portal:action_1' },
    );
  });

  it('does not call Stripe when authority is revoked after the readable preflight', async () => {
    const state = setup({ teamRole: 'admin' });
    const dependencies = deps(state);
    dependencies.authorizeAction = vi
      .fn()
      .mockRejectedValue(new Error('customer billing authority revoked')) as never;

    await expect(
      createStripePortalSession(
        {
          request: { ...request, returnUrl: 'https://app.nessie.works/billing' },
          actorToken: 'signed-actor',
          credential,
        },
        dependencies,
      ),
    ).rejects.toThrow('customer billing authority revoked');
    expect(state.refreshSubscription).not.toHaveBeenCalled();
    expect(state.stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('reuses the claimed intent idempotency key after a lost Stripe response', async () => {
    const state = setup({ teamRole: 'admin' });
    const dependencies = deps(state);
    state.stripe.billingPortal.sessions.create
      .mockRejectedValueOnce(new Error('transport response lost'))
      .mockResolvedValue({
        id: 'bps_123',
        livemode: false,
        url: 'https://billing.stripe.com/p/session/test',
      });
    const params = {
      request: { ...request, returnUrl: 'https://app.nessie.works/billing' },
      actorToken: 'signed-actor',
      credential,
    };

    await expect(createStripePortalSession(params, dependencies)).rejects.toThrow(
      'transport response lost',
    );
    await expect(createStripePortalSession(params, dependencies)).resolves.toEqual({
      portal_url: 'https://billing.stripe.com/p/session/test',
    });
    expect(state.stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(2);
    expect(state.stripe.billingPortal.sessions.create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: 'uoa:billing-portal:action_1',
    });
    expect(state.stripe.billingPortal.sessions.create.mock.calls[1]?.[1]).toEqual({
      idempotencyKey: 'uoa:billing-portal:action_1',
    });
  });

  it('rejects a cross-origin portal redirect before calling Stripe', async () => {
    const state = setup({ teamRole: 'admin' });
    await expect(
      createStripePortalSession(
        {
          request: { ...request, returnUrl: 'https://attacker.example/billing' },
          actorToken: 'signed-actor',
          credential,
        },
        deps(state),
      ),
    ).rejects.toThrow('STRIPE_RETURN_URL_NOT_ALLOWED');
    expect(state.stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});
