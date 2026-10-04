import {
  BillingAppKeyPurpose,
  BillingCreditAutoTopUpConsentSource,
  BillingCreditAutoTopUpState,
  BillingCreditCheckoutStatus,
  type PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  disableBillingCreditAutoTopUp,
  updateBillingCreditAutoTopUp,
} from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { createBillingCreditAutoTopUpSetup } from '../../src/services/billing-credit-auto-top-up-setup.service.js';
import type { CreditFundingActionContext } from '../../src/services/billing-credit-funding-context.service.js';
import { createBillingCreditTopUpCheckout } from '../../src/services/billing-credit-top-up.service.js';

const now = new Date('2026-07-21T12:00:00.000Z');
const credential = {
  id: 'app_key_deepwater',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://api.deepwater.example',
  actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
  actorKeyId: 'actor_key_1',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://app.deepwater.example'],
  service: { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' },
};
const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'user_1',
};
const account = { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false };
const policy = {
  id: 'policy_1',
  automaticConsentVersion: 'credits-auto-2026-07',
};
const offer = {
  id: 'offer_20k',
  paymentAmountMinor: 2_000n,
  creditsReceivedMicrocredits: 20_000_000_000n,
};
const catalog = {
  id: 'catalog_20k',
  stripePriceId: 'price_20k',
  stripeProductId: 'prod_20k',
  stripeLookupKey: 'credits-20k-v1',
  paymentAmountMinor: offer.paymentAmountMinor,
};
const option = {
  id: 'option_safe',
  thresholdMicrocredits: 5_000_000_000n,
  monthlyChargeCapMinor: 10_000n,
};

function fundingMetadata(local: Record<string, string>) {
  return {
    uoa_service_id: credential.service.id,
    uoa_app_key_id: credential.id,
    uoa_credit_account_id: 'credit_account_1',
    ...local,
  };
}

function baseContext(overrides?: Record<string, unknown>) {
  const sessionsCreate = vi.fn();
  const stripe = {
    checkout: { sessions: { create: sessionsCreate, retrieve: vi.fn(), list: vi.fn() } },
    paymentMethods: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
    prices: { retrieve: vi.fn() },
    accounts: { retrieveCurrent: vi.fn() },
    customers: { create: vi.fn(), retrieve: vi.fn() },
  };
  const creditAccount = {
    id: 'credit_account_1',
    accountId: account.id,
    customerId: 'customer_1',
    orgId: request.organisationId,
    teamId: request.teamId,
    autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
    autoTopUpGeneration: 0,
    autoTopUpOptionId: null,
    autoTopUpConsentRevisionId: null,
    autoTopUpThresholdMicrocredits: null,
    autoTopUpRefillOfferId: null,
    autoTopUpMonthlyChargeCapMinor: null,
    autoTopUpConsentVersion: null,
    autoTopUpConsentedAt: null,
    autoTopUpConsentedByUserId: null,
    stripePaymentMethodId: null,
    paymentMethodSummary: null,
    ...overrides,
  };
  const customer = { id: 'customer_1', stripeCustomerId: 'cus_team_1' };
  const context = {
    actor: { jti: 'actor_jti_1', tv: 0, exp: 2_000_000_000 },
    viewer: { billingManager: true },
    account,
    creditAccount,
    customer,
    stripe,
    authorizeAction: vi.fn(),
    ensureCustomer: vi.fn().mockResolvedValue(customer),
  } as unknown as CreditFundingActionContext;
  return { context, stripe, sessionsCreate };
}

function selections() {
  return {
    offer: { policy, offer, catalog },
    option: { policy, option, offer, catalog },
  };
}

function checkoutRow(kind: 'setup' | 'top_up', actorJti = 'actor_jti_1') {
  const returnDigest = (value: string) => createHash('sha256').update(value).digest('hex');
  const common = {
    id: kind === 'top_up' ? 'checkout_topup_1' : 'checkout_setup_1',
    accountId: account.id,
    creditAccountId: 'credit_account_1',
    customerId: 'customer_1',
    serviceId: credential.service.id,
    appKeyId: credential.id,
    actorJti,
    requestedByUserId: request.userId,
    successUrlDigest: returnDigest('https://app.deepwater.example/?uoa_billing=checkout_complete'),
    cancelUrlDigest: returnDigest('https://app.deepwater.example/?uoa_billing=checkout_cancelled'),
    status: BillingCreditCheckoutStatus.CREATING,
    stripeCheckoutSessionId: null,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
  };
  return kind === 'top_up'
    ? {
        ...common,
        catalogId: catalog.id,
        offerId: offer.id,
        paymentAmountMinor: offer.paymentAmountMinor,
        creditsReceivedMicrocredits: offer.creditsReceivedMicrocredits,
      }
    : {
        ...common,
        policyId: policy.id,
        optionId: option.id,
        expectedGeneration: 0,
        expectedConsentRevisionId: null,
        consentVersion: policy.automaticConsentVersion,
        thresholdMicrocredits: option.thresholdMicrocredits,
        refillOfferId: offer.id,
        refillCreditsMicrocredits: offer.creditsReceivedMicrocredits,
        refillPaymentAmountMinor: offer.paymentAmountMinor,
        monthlyChargeCapMinor: option.monthlyChargeCapMinor,
      };
}

function openTopUpSession(
  checkout: ReturnType<typeof checkoutRow> & Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'cs_existing',
    livemode: false,
    mode: 'payment',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_existing',
    customer: 'cus_team_1',
    client_reference_id: checkout.id,
    metadata: {
      uoa_credit_top_up_checkout_id: checkout.id,
      uoa_service_id: checkout.serviceId,
      uoa_app_key_id: checkout.appKeyId,
      uoa_credit_account_id: checkout.creditAccountId,
    },
    expires_at: 2_000_000_000,
    ...overrides,
  };
}

describe('UOA credit funding mutation services', () => {
  it('persists fixed top-up intent before creating exact-price Stripe Checkout', async () => {
    const state = baseContext();
    const order: string[] = [];
    state.context.authorizeAction = vi.fn(async () => {
      order.push('authorize');
    });
    const create = vi.fn(async ({ data }) => {
      order.push('local');
      return { ...checkoutRow('top_up'), ...data, id: 'checkout_topup_1' };
    });
    const update = vi.fn();
    const prisma = {
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        update,
      },
    } as unknown as PrismaClient;
    state.sessionsCreate.mockImplementation(async (input) => {
      order.push('stripe');
      return {
        id: 'cs_topup_1',
        livemode: false,
        mode: 'payment',
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_topup_1',
        customer: input.customer,
        client_reference_id: input.client_reference_id,
        metadata: input.metadata,
        expires_at: 1_784_470_800,
      };
    });

    const result = await createBillingCreditTopUpCheckout(
      { request: { ...request, offerId: offer.id }, actorToken: 'actor', credential },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOffer: vi.fn().mockResolvedValue(selections().offer),
        validateCatalog: vi.fn(),
      },
    );

    expect(order).toEqual(['authorize', 'local', 'stripe']);
    expect(result.redirect_url).toContain('checkout.stripe.com');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogId: catalog.id,
        offerId: offer.id,
        paymentAmountMinor: 2_000n,
        creditsReceivedMicrocredits: 20_000_000_000n,
      }),
    });
    const [input, stripeOptions] = state.sessionsCreate.mock.calls[0]!;
    expect(input).toMatchObject({
      mode: 'payment',
      customer: 'cus_team_1',
      success_url: 'https://app.deepwater.example/?uoa_billing=checkout_complete',
      cancel_url: 'https://app.deepwater.example/?uoa_billing=checkout_cancelled',
      line_items: [{ price: 'price_20k', quantity: 1 }],
      metadata: fundingMetadata({ uoa_credit_top_up_checkout_id: 'checkout_topup_1' }),
      payment_intent_data: {
        metadata: fundingMetadata({ uoa_credit_top_up_checkout_id: 'checkout_topup_1' }),
      },
    });
    expect(stripeOptions.idempotencyKey).toBe('uoa:acct_uoa:test:credit:top_up:checkout_topup_1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OPEN' }) }),
    );
  });

  it('creates Setup Checkout with the same reserved binding on session and SetupIntent', async () => {
    const state = baseContext();
    const prisma = {
      billingCreditSetupCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => ({
          ...checkoutRow('setup'),
          ...data,
          id: 'checkout_setup_1',
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    state.sessionsCreate.mockImplementation(async (input) => ({
      id: 'cs_setup_1',
      livemode: false,
      mode: 'setup',
      status: 'open',
      url: 'https://checkout.stripe.com/c/setup/cs_setup_1',
      customer: input.customer,
      client_reference_id: input.client_reference_id,
      metadata: input.metadata,
      expires_at: 1_784_470_800,
    }));

    await createBillingCreditAutoTopUpSetup(
      { request: { ...request, optionId: option.id }, actorToken: 'actor', credential },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOption: vi.fn().mockResolvedValue(selections().option),
        validateCatalog: vi.fn(),
      },
    );

    const input = state.sessionsCreate.mock.calls[0]![0];
    expect(input.metadata).toMatchObject({
      uoa_credit_setup_checkout_id: 'checkout_setup_1',
      uoa_service_id: credential.service.id,
      uoa_app_key_id: credential.id,
      uoa_credit_account_id: 'credit_account_1',
    });
    expect(input.setup_intent_data.metadata).toEqual(input.metadata);
    expect(input).not.toHaveProperty('line_items');
  });

  it('pins active-card replacement to the current immutable consent predecessor', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpGeneration: 4,
      autoTopUpConsentRevisionId: 'consent_previous',
      autoTopUpOptionId: option.id,
      stripePaymentMethodId: 'pm_previous',
    });
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      ...checkoutRow('setup'),
      ...data,
      id: 'checkout_setup_replacement',
    }));
    const prisma = {
      billingCreditSetupCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    state.sessionsCreate.mockImplementation(async (input) => ({
      id: 'cs_setup_replacement',
      livemode: false,
      mode: 'setup',
      status: 'open',
      url: 'https://checkout.stripe.com/c/setup/replacement',
      customer: input.customer,
      client_reference_id: input.client_reference_id,
      metadata: input.metadata,
      expires_at: 1_784_470_800,
    }));

    await createBillingCreditAutoTopUpSetup(
      {
        request: { ...request, optionId: option.id },
        actorToken: 'actor',
        credential,
        endpoint: 'credits_auto_top_up_recover' as never,
        recovery: true,
      },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOption: vi.fn().mockResolvedValue(selections().option),
        validateCatalog: vi.fn(),
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expectedGeneration: 4,
        expectedConsentRevisionId: 'consent_previous',
        optionId: option.id,
      }),
    });
    expect(state.context.creditAccount).toMatchObject({
      autoTopUpGeneration: 4,
      autoTopUpConsentRevisionId: 'consent_previous',
      stripePaymentMethodId: 'pm_previous',
    });
  });

  it.each([false, true])('recovers the same open team Checkout across a fresh manager actor (includePurchaseId=%s)', async (includePurchaseId) => {
    const state = baseContext();
    const existing = {
      ...checkoutRow('top_up', 'actor_jti_old'),
      status: BillingCreditCheckoutStatus.OPEN,
      stripeCheckoutSessionId: 'cs_existing',
    };
    const session = openTopUpSession(existing);
    state.stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    const prisma = {
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;

    const result = await createBillingCreditTopUpCheckout(
      {
        request: { ...request, userId: 'new_manager', offerId: offer.id },
        actorToken: 'fresh-actor',
        credential,
        includePurchaseId,
      },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOffer: vi.fn().mockResolvedValue(selections().offer),
        validateCatalog: vi.fn(),
      },
    );

    expect(result).toEqual({
      redirect_url: session.url,
      ...(includePurchaseId ? { purchase_id: existing.id } : {}),
    });
    expect(state.sessionsCreate).not.toHaveBeenCalled();
    expect(state.context.authorizeAction).not.toHaveBeenCalled();
  });

  it.each([
    ['different offer', { offerId: 'offer_other' }, undefined],
    ['different app key', undefined, { appKeyId: 'app_key_other' }],
    ['different service', undefined, { serviceId: 'service_other' }],
    ['different customer', undefined, { customerId: 'customer_other' }],
    ['changed payment amount', undefined, { paymentAmountMinor: 2_001n }],
    ['changed credit quantity', undefined, { creditsReceivedMicrocredits: 20_000_000_001n }],
    ['changed success return URL', undefined, { successUrlDigest: 'e'.repeat(64) }],
    ['changed cancel return URL', undefined, { cancelUrlDigest: 'f'.repeat(64) }],
  ])('does not resume an open checkout with %s', async (_label, selectionOverride, rowOverride) => {
    const state = baseContext();
    const existing = {
      ...checkoutRow('top_up', 'actor_jti_old'),
      status: BillingCreditCheckoutStatus.OPEN,
      stripeCheckoutSessionId: 'cs_existing',
      ...rowOverride,
    };
    state.stripe.checkout.sessions.retrieve.mockResolvedValue(openTopUpSession(existing));
    const prisma = {
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;
    const selected = selectionOverride
      ? { ...selections().offer, offer: { ...offer, id: selectionOverride.offerId } }
      : selections().offer;

    await expect(
      createBillingCreditTopUpCheckout(
        {
          request: { ...request, offerId: selectionOverride?.offerId ?? offer.id },
          actorToken: 'fresh-actor',
          credential,
        },
        {
          prisma,
          now: () => now,
          resolveContext: vi.fn().mockResolvedValue(state.context),
          resolveOffer: vi.fn().mockResolvedValue(selected),
          validateCatalog: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ message: 'BILLING_CREDIT_TOP_UP_PENDING' });
    expect(state.sessionsCreate).not.toHaveBeenCalled();
    expect(prisma.billingCreditTopUpCheckout.create).not.toHaveBeenCalled();
  });

  it('returns one exact resumed Checkout to concurrent clicks without creating another session', async () => {
    const state = baseContext();
    const existing = {
      ...checkoutRow('top_up', 'actor_jti_old'),
      status: BillingCreditCheckoutStatus.OPEN,
      stripeCheckoutSessionId: 'cs_existing',
    };
    const session = openTopUpSession(existing);
    state.stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    const prisma = {
      billingCreditTopUpCheckout: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      now: () => now,
      resolveContext: vi.fn().mockResolvedValue(state.context),
      resolveOffer: vi.fn().mockResolvedValue(selections().offer),
      validateCatalog: vi.fn(),
    };

    const results = await Promise.all([
      createBillingCreditTopUpCheckout(
        { request: { ...request, offerId: offer.id }, actorToken: 'click-1', credential },
        deps,
      ),
      createBillingCreditTopUpCheckout(
        { request: { ...request, offerId: offer.id }, actorToken: 'click-2', credential },
        deps,
      ),
    ]);

    expect(results).toEqual([{ redirect_url: session.url }, { redirect_url: session.url }]);
    expect(state.stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(2);
    expect(state.sessionsCreate).not.toHaveBeenCalled();
    expect(prisma.billingCreditTopUpCheckout.create).not.toHaveBeenCalled();
  });

  it('does not append action evidence when automatic top-up is already disabled', async () => {
    const state = baseContext();

    await disableBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      {
        prisma: {} as PrismaClient,
        resolveContext: vi.fn().mockResolvedValue(state.context),
      },
    );

    expect(state.context.authorizeAction).not.toHaveBeenCalled();
  });

  it('updates immutable consent from the verified customer card and exact option', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: option.id,
      autoTopUpConsentRevisionId: 'consent_old',
      stripePaymentMethodId: 'pm_1',
    });
    state.stripe.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_1',
      livemode: false,
      type: 'card',
      customer: 'cus_team_1',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });
    const revisionCreate = vi.fn().mockResolvedValue({ id: 'consent_new' });
    const accountUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_old',
          autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAutoTopUpConsentRevision: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: revisionCreate,
      },
      billingCreditAccount: { updateMany: accountUpdate },
      billingCreditSetupCheckout: { updateMany: vi.fn() },
      orgAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      billingCreditAutoTopUpConsentRevision: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await updateBillingCreditAutoTopUp(
      { request: { ...request, optionId: option.id }, actorToken: 'actor', credential },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOption: vi.fn().mockResolvedValue(selections().option),
        validateCatalog: vi.fn(),
      },
    );

    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
        optionId: option.id,
        refillPaymentAmountMinor: offer.paymentAmountMinor,
        stripePaymentMethodId: 'pm_1',
        paymentMethodSummary: expect.objectContaining({ last4: '4242' }),
      }),
    });
    expect(accountUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'credit_account_1', autoTopUpGeneration: 0 }),
      data: expect.objectContaining({
        autoTopUpGeneration: { increment: 1 },
        autoTopUpConsentRevisionId: 'consent_new',
        autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      }),
    });
  });

  it('disables future charges only when no automatic payment remains unresolved', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpConsentRevisionId: 'consent_1',
      autoTopUpOptionId: option.id,
      stripePaymentMethodId: 'pm_1',
    });
    const accountUpdate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_1',
          autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAccount: {
        update: accountUpdate,
      },
      billingCreditAutoTopUpAttempt: { findFirst: vi.fn().mockResolvedValue(null) },
      billingCreditAutoTopUpDisableEvent: { create: vi.fn() },
      billingCreditSetupCheckout: { updateMany: vi.fn() },
      orgAuditLog: { create: vi.fn() },
    };
    const prisma = {
      billingCreditAutoTopUpAttempt: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await disableBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
    );

    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: 'credit_account_1' },
      data: expect.objectContaining({
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpConsentRevisionId: null,
        stripePaymentMethodId: null,
      }),
    });
  });

  it('keeps disable blocked for ambiguous review evidence', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.NEEDS_REVIEW,
      autoTopUpConsentRevisionId: 'consent_1',
      autoTopUpOptionId: option.id,
      stripePaymentMethodId: 'pm_1',
    });
    const disableCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_1',
          autoTopUpState: BillingCreditAutoTopUpState.NEEDS_REVIEW,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAutoTopUpAttempt: {
        findFirst: vi.fn().mockResolvedValue({ id: 'attempt_ambiguous' }),
      },
      billingCreditAutoTopUpDisableEvent: { create: disableCreate },
    };
    const prisma = {
      billingCreditAutoTopUpAttempt: {
        findFirst: vi.fn().mockResolvedValue({ id: 'attempt_ambiguous' }),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      disableBillingCreditAutoTopUp(
        { request, actorToken: 'actor', credential },
        { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
      ),
    ).rejects.toThrow('BILLING_CREDIT_AUTO_TOP_UP_PAYMENT_PENDING');
    expect(disableCreate).not.toHaveBeenCalled();
  });
});
