import { BillingCreditAutoTopUpState, BillingCreditCheckoutStatus, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createBillingCreditAutoTopUpSetup } from '../../src/services/billing-credit-auto-top-up-setup.service.js';
import { createBillingCreditTopUpCheckout } from '../../src/services/billing-credit-top-up.service.js';
import { now, credential, request, offer, catalog, option, fundingMetadata, baseContext, selections, checkoutRow, openTopUpSession } from './billing-credit-funding.fixture.js';

// Admission and provider fencing are covered by the PostgreSQL team-archive suite.
vi.mock('../../src/services/team-billing-effect.service.js', () => ({
  withLiveTeamBillingEffect: async (_db: unknown, _scope: unknown, effect: () => Promise<unknown>) => effect(),
}));

describe('UOA credit Checkout bindings and recovery', () => {
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
        readRegion: vi.fn().mockResolvedValue(null),
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
        readRegion: vi.fn().mockResolvedValue(null),
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
        readRegion: vi.fn().mockResolvedValue(null),
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
        readRegion: vi.fn().mockResolvedValue(null),
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
          readRegion: vi.fn().mockResolvedValue(null),
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
      readRegion: vi.fn().mockResolvedValue(null),
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


});
