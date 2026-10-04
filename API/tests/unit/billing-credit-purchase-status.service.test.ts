import type { PrismaClient, BillingCreditTopUpCheckout } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { BILLING_CUSTOMER_LOCALES } from '../../src/contracts/billing-statement-v1.js';
import {
  getBillingCreditPurchaseStatus,
  readCreditPurchaseEvidence,
} from '../../src/services/billing-credit-purchase-status.service.js';
import { billingCreditPaymentCopy } from '../../src/services/billing-payment-copy.catalog.js';

const account = { id: 'stripe_account_1', stripeAccountId: 'acct_1', livemode: false };
const customerStripeId = 'cus_1';
const purchaseId = 'purchase_1';
const fundingMetadata = {
  uoa_credit_top_up_checkout_id: purchaseId,
  uoa_service_id: 'service_1',
  uoa_app_key_id: 'app_key_1',
  uoa_credit_account_id: 'credit_account_1',
};

const readCreditPurchaseState = async (
  params: Parameters<typeof readCreditPurchaseEvidence>[0],
) => (await readCreditPurchaseEvidence(params)).state;

function checkout(overrides: Record<string, unknown> = {}): BillingCreditTopUpCheckout {
  return {
    id: purchaseId,
    accountId: account.id,
    creditAccountId: 'credit_account_1',
    customerId: 'customer_1',
    catalogId: 'catalog_1',
    serviceId: 'service_1',
    appKeyId: 'app_key_1',
    offerId: 'offer_1',
    actorJti: 'actor_jti_1',
    requestedByUserId: 'user_1',
    paymentAmountMinor: 500n,
    creditsReceivedMicrocredits: 5_000_000_000n,
    currency: 'USD',
    successUrlDigest: 'a'.repeat(64),
    cancelUrlDigest: 'b'.repeat(64),
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: null,
    completionWebhookEventId: null,
    status: 'OPEN',
    leaseExpiresAt: new Date('2026-10-04T12:00:00.000Z'),
    expiresAt: null,
    completedAt: null,
    creditEntryId: null,
    createdAt: new Date('2026-10-04T12:00:00.000Z'),
    updatedAt: new Date('2026-10-04T12:00:00.000Z'),
    ...overrides,
  } as BillingCreditTopUpCheckout;
}

function session(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    object: 'checkout.session',
    livemode: false,
    client_reference_id: purchaseId,
    customer: customerStripeId,
    mode: 'payment',
    status: 'complete',
    amount_total: 500,
    currency: 'usd',
    payment_intent: 'pi_1',
    metadata: fundingMetadata,
    ...overrides,
  } as Stripe.Checkout.Session;
}

function intent(overrides: Record<string, unknown> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    livemode: false,
    customer: customerStripeId,
    amount: 500,
    currency: 'usd',
    status: 'succeeded',
    metadata: fundingMetadata,
    ...overrides,
  } as Stripe.PaymentIntent;
}

function stripeFor(params: {
  session?: Stripe.Checkout.Session;
  intent?: Stripe.PaymentIntent;
  sessionError?: Error;
  intentError?: Error;
} = {}) {
  const sessionsRetrieve = params.sessionError
    ? vi.fn().mockRejectedValue(params.sessionError)
    : vi.fn().mockResolvedValue(params.session ?? session());
  const intentsRetrieve = params.intentError
    ? vi.fn().mockRejectedValue(params.intentError)
    : vi.fn().mockResolvedValue(params.intent ?? intent());
  return {
    client: {
      checkout: { sessions: { retrieve: sessionsRetrieve } },
      paymentIntents: { retrieve: intentsRetrieve },
    } as unknown as Pick<Stripe, 'checkout' | 'paymentIntents'>,
    sessionsRetrieve,
    intentsRetrieve,
  };
}

describe('readCreditPurchaseState', () => {
  it('has complete customer-facing copy for every state in all supported locales', () => {
    for (const locale of BILLING_CUSTOMER_LOCALES) {
      const copy = billingCreditPaymentCopy(locale);
      for (const state of [
        'open', 'processing', 'requires_action', 'succeeded', 'failed', 'expired', 'needs_review',
      ] as const) {
        expect(copy[state].title.trim()).not.toBe('');
        expect(copy[state].message.trim()).not.toBe('');
      }
    }
  });

  it('requires local credit-entry and completion-event proof before reporting success', async () => {
    const complete = checkout({
      status: 'COMPLETE',
      creditEntryId: 'credit_entry_1',
      completionWebhookEventId: 'webhook_event_1',
    });
    await expect(readCreditPurchaseState({
      checkout: complete, account, customerStripeId: null, stripe: null,
    })).resolves.toBe('succeeded');

    for (const missing of [
      checkout({ status: 'COMPLETE', completionWebhookEventId: 'webhook_event_1' }),
      checkout({ status: 'COMPLETE', creditEntryId: 'credit_entry_1' }),
    ]) {
      await expect(readCreditPurchaseState({
        checkout: missing, account, customerStripeId, stripe: null,
      })).resolves.toBe('needs_review');
    }
  });

  it('does not treat a paid Stripe session or succeeded PaymentIntent as confirmed credits', async () => {
    const stripe = stripeFor({
      session: session({ status: 'complete', payment_status: 'paid' }),
      intent: intent({ status: 'succeeded' }),
    });

    await expect(readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId, stripe: stripe.client,
    })).resolves.toBe('processing');
    expect(stripe.sessionsRetrieve).toHaveBeenCalledWith('cs_1');
    expect(stripe.intentsRetrieve).toHaveBeenCalledWith('pi_1');
  });

  it.each([
    ['open without a PaymentIntent', 'open', null, undefined, 'open'],
    ['expired Checkout', 'expired', null, undefined, 'expired'],
    ['requires customer action', 'complete', 'pi_1', 'requires_action', 'requires_action'],
    ['processing PaymentIntent', 'complete', 'pi_1', 'processing', 'processing'],
    ['succeeded PaymentIntent before local proof', 'complete', 'pi_1', 'succeeded', 'processing'],
    ['canceled PaymentIntent', 'complete', 'pi_1', 'canceled', 'failed'],
    ['failed payment method', 'open', 'pi_1', 'requires_payment_method', 'failed'],
    ['payment method ready to retry', 'open', 'pi_1', 'requires_payment_method', 'open'],
  ] as const)('maps %s from exact remote evidence', async (_label, sessionStatus, intentId, intentStatus, expected) => {
    const remoteSession = session({
      status: sessionStatus,
      payment_intent: intentId,
    });
    const remoteIntent = intent({
      status: intentStatus,
      ...(intentStatus === 'requires_payment_method'
        ? { last_payment_error: intentStatus === 'requires_payment_method' && expected === 'failed'
          ? { code: 'card_declined' }
          : null }
        : {}),
    });
    const stripe = stripeFor({ session: remoteSession, intent: remoteIntent });
    const result = await readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId, stripe: stripe.client,
    });
    expect(result).toBe(expected);
    if (!intentId) expect(stripe.intentsRetrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['open', 'open', null, 'open'],
    ['requires action while Checkout remains open', 'open', 'requires_action', 'requires_action'],
    ['failed payment method while Checkout remains open', 'open', 'canceled', 'failed'],
  ] as const)('returns the same-purchase continuation for %s', async (_label, sessionStatus, intentStatus, expected) => {
    const remoteSession = session({
      status: sessionStatus,
      url: 'https://checkout.stripe.com/c/pay/cs_1?locale=cs',
      payment_intent: intentStatus === null ? null : 'pi_1',
    });
    const remoteIntent = intentStatus === null ? undefined : intent({ status: intentStatus });
    const evidence = await readCreditPurchaseEvidence({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ session: remoteSession, intent: remoteIntent }).client,
    });
    expect(evidence.state).toBe(expected);
    expect(evidence.continuation).toEqual({
      redirect_url: 'https://checkout.stripe.com/c/pay/cs_1?locale=cs',
      purchase_id: purchaseId,
    });
  });

  it.each(['processing', 'succeeded'] as const)(
    'does not return a continuation while the PaymentIntent is %s even if Checkout remains open',
    async (intentStatus) => {
      const evidence = await readCreditPurchaseEvidence({
        checkout: checkout(), account, customerStripeId,
        stripe: stripeFor({
          session: session({ status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
          intent: intent({ status: intentStatus }),
        }).client,
      });
      expect(evidence.state).toBe('processing');
      expect(evidence.continuation).toBeUndefined();
    },
  );

  it.each([
    'https://checkout.stripe.com.evil.example/c/pay/cs_1',
    'https://name:secret@checkout.stripe.com/c/pay/cs_1',
    'http://checkout.stripe.com/c/pay/cs_1',
    'https://checkout.stripe.com:444/c/pay/cs_1',
    `https://checkout.stripe.com/c/pay/${'x'.repeat(2100)}`,
  ])('does not return an unsafe Checkout URL: %s', async (url) => {
    const evidence = await readCreditPurchaseEvidence({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ session: session({ status: 'open', url, payment_intent: null }) }).client,
    });
    expect(evidence.state).toBe('open');
    expect(evidence.continuation).toBeUndefined();
  });

  it('does not return a continuation for a completed Checkout without local credit proof', async () => {
    const evidence = await readCreditPurchaseEvidence({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ session: session({ status: 'complete', url: 'https://checkout.stripe.com/c/pay/cs_1' }) }).client,
    });
    expect(evidence.state).toBe('processing');
    expect(evidence.continuation).toBeUndefined();
  });

  it('does not return a continuation after Checkout expires or local credit proof confirms completion', async () => {
    const expiredSession = stripeFor({
      session: session({ status: 'expired', url: null, payment_intent: null }),
    });
    const expired = await readCreditPurchaseEvidence({
      checkout: checkout(), account, customerStripeId, stripe: expiredSession.client,
    });
    expect(expired).toEqual({ state: 'expired' });

    const complete = await readCreditPurchaseEvidence({
      checkout: checkout({
        status: 'COMPLETE',
        creditEntryId: 'credit_entry_1',
        completionWebhookEventId: 'webhook_event_1',
      }),
      account, customerStripeId, stripe: stripeFor().client,
    });
    expect(complete).toEqual({ state: 'succeeded' });
  });

  it('withholds a valid-looking URL when the remote Checkout binding is mismatched', async () => {
    const evidence = await readCreditPurchaseEvidence({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ session: session({ id: 'cs_other', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_other' }) }).client,
    });
    expect(evidence).toEqual({ state: 'needs_review' });
  });

  it.each([
    ['wrong session id', { session: session({ id: 'cs_other' }) }],
    ['wrong Checkout customer', { session: session({ customer: 'cus_other' }) }],
    ['wrong Checkout mode', { session: session({ mode: 'setup' }) }],
    ['wrong Checkout reference', { session: session({ client_reference_id: 'purchase_other' }) }],
    ['wrong Checkout metadata', { session: session({ metadata: { ...fundingMetadata, uoa_app_key_id: 'app_other' } }) }],
    ['wrong Checkout amount', { session: session({ amount_total: 501 }) }],
    ['wrong Checkout currency', { session: session({ currency: 'eur' }) }],
    ['wrong Checkout livemode', { session: session({ livemode: true }) }],
    ['wrong stored PaymentIntent binding', { checkout: checkout({ stripePaymentIntentId: 'pi_other' }) }],
    ['wrong PaymentIntent id', { intent: intent({ id: 'pi_other' }) }],
    ['wrong PaymentIntent customer', { intent: intent({ customer: 'cus_other' }) }],
    ['wrong PaymentIntent metadata', { intent: intent({ metadata: { ...fundingMetadata, uoa_credit_account_id: 'credit_other' } }) }],
    ['wrong PaymentIntent amount', { intent: intent({ amount: 501 }) }],
    ['wrong PaymentIntent currency', { intent: intent({ currency: 'eur' }) }],
    ['wrong PaymentIntent livemode', { intent: intent({ livemode: true }) }],
  ] as const)('fails closed for %s', async (_label, overrides) => {
    const stripe = stripeFor(overrides);
    await expect(readCreditPurchaseState({
      checkout: overrides.checkout ?? checkout(),
      account,
      customerStripeId,
      stripe: stripe.client,
    })).resolves.toBe('needs_review');
  });

  it('fails closed for missing customer identity and Stripe retrieval errors', async () => {
    const remote = stripeFor();
    await expect(readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId: null, stripe: remote.client,
    })).resolves.toBe('needs_review');
    await expect(readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId, stripe: null,
    })).resolves.toBe('needs_review');
    await expect(readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ sessionError: new Error('stripe unavailable') }).client,
    })).resolves.toBe('needs_review');
    await expect(readCreditPurchaseState({
      checkout: checkout(), account, customerStripeId,
      stripe: stripeFor({ intentError: new Error('stripe unavailable') }).client,
    })).resolves.toBe('needs_review');
  });

  it('keeps locally expired and abandoned records terminal without a Stripe read', async () => {
    const stripe = stripeFor();
    for (const status of ['EXPIRED', 'ABANDONED'] as const) {
      await expect(readCreditPurchaseState({
        checkout: checkout({ status }), account, customerStripeId, stripe: stripe.client,
      })).resolves.toBe('expired');
    }
    expect(stripe.sessionsRetrieve).not.toHaveBeenCalled();
  });
});

describe('getBillingCreditPurchaseStatus authorization and scope', () => {
  const request = {
    product: 'deepwater', organisationId: 'org_1', teamId: 'team_1',
    userId: 'user_1', purchaseId,
  };
  const credential = { id: 'app_key_1', service: { id: 'service_1' } } as never;

  function setup(params: {
    viewerManager?: boolean;
    responsibilityActive?: boolean;
    orgManager?: boolean;
    checkoutRow?: unknown;
  } = {}) {
    const stored = params.checkoutRow === undefined ? {
      ...checkout(), customer: { stripeCustomerId: customerStripeId },
    } : params.checkoutRow;
    const findFirst = vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (!stored || !Object.entries(where).every(([key, value]) =>
        (stored as Record<string, unknown>)[key] === value)) return null;
      return stored;
    });
    const prisma = { billingCreditTopUpCheckout: { findFirst } } as unknown as PrismaClient;
    const resolveEntitlement = vi.fn();
    const resolveViewer = vi.fn().mockResolvedValue({ billingManager: params.viewerManager ?? true });
    const resolveResponsibility = vi.fn().mockResolvedValue({ active: params.responsibilityActive ?? false });
    const isOrganisationManager = vi.fn().mockResolvedValue(params.orgManager ?? false);
    const resolveCollection = vi.fn().mockResolvedValue({ account, stripe: null });
    const resolveAccount = vi.fn().mockResolvedValue({ id: 'credit_account_1', customerId: 'customer_1' });
    const readEvidence = vi.fn().mockResolvedValue({ state: 'processing' });
    return {
      findFirst, prisma, resolveEntitlement, resolveViewer, resolveResponsibility,
      isOrganisationManager, resolveCollection, resolveAccount, readEvidence,
      deps: {
        prisma, resolveEntitlement, resolveViewer, resolveResponsibility, isOrganisationManager,
        resolveCollection, resolveAccount, readEvidence,
      } as never,
    };
  }

  it('requires current manager authority before looking up a purchase', async () => {
    const state = setup({ viewerManager: false });
    await expect(getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }, state.deps)).rejects.toMatchObject({ statusCode: 403 });
    expect(state.resolveEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }), { prisma: state.prisma });
    expect(state.findFirst).not.toHaveBeenCalled();
  });

  it('uses organisation manager authority while billing responsibility is active', async () => {
    const state = setup({ viewerManager: false, responsibilityActive: true, orgManager: true });
    await getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }, state.deps);

    expect(state.isOrganisationManager).toHaveBeenCalledWith(request, { prisma: state.prisma });
    expect(state.findFirst).toHaveBeenCalledWith({
      where: {
        id: purchaseId,
        accountId: account.id,
        creditAccountId: 'credit_account_1',
        customerId: 'customer_1',
        serviceId: 'service_1',
        appKeyId: 'app_key_1',
      },
      include: { customer: { select: { stripeCustomerId: true } } },
    });
  });

  it('denies an organisation non-manager even when the team viewer manages billing', async () => {
    const state = setup({ viewerManager: true, responsibilityActive: true, orgManager: false });
    await expect(getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }, state.deps)).rejects.toMatchObject({ statusCode: 403 });
    expect(state.findFirst).not.toHaveBeenCalled();
  });

  it('returns not-found when any purchase scope selector does not match', async () => {
    const mismatches = [
      { accountId: 'account_other' },
      { creditAccountId: 'credit_other' },
      { customerId: 'customer_other' },
      { serviceId: 'service_other' },
      { appKeyId: 'app_other' },
    ];
    for (const row of mismatches) {
      const state = setup({ checkoutRow: { ...checkout(), customer: { stripeCustomerId: customerStripeId }, ...row } });
      await expect(getBillingCreditPurchaseStatus({
        request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
      }, state.deps)).rejects.toMatchObject({ statusCode: 404 });
      expect(state.findFirst.mock.calls[0]?.[0].where).toMatchObject({
        accountId: account.id,
        creditAccountId: 'credit_account_1',
        customerId: 'customer_1',
        serviceId: 'service_1',
        appKeyId: 'app_key_1',
      });
    }
  });

  it('localizes the status and only marks processing as awaiting confirmation', async () => {
    const state = setup();
    state.readEvidence.mockResolvedValue({ state: 'processing' });
    const result = await getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status', locale: 'cs',
    }, state.deps);
    expect(result).toMatchObject({ schema_version: 1, purchase_id: purchaseId, state: 'processing', awaiting_confirmation: true });
    expect(result.title).toBe('Platbu ověřujeme');

    state.readEvidence.mockResolvedValue({ state: 'succeeded' });
    const completed = await getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }, state.deps);
    expect(completed.awaiting_confirmation).toBe(false);
  });

  it('returns the exact purchase id with an authorized continuation', async () => {
    const state = setup();
    const result = await getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
      presentationEnabled: true,
    }, {
      ...state.deps,
      readEvidence: vi.fn().mockResolvedValue({
        state: 'open',
        continuation: { redirect_url: 'https://checkout.stripe.com/c/pay/cs_1', purchase_id: purchaseId },
      }),
    } as never);
    expect(result.continuation).toEqual({
      redirect_url: 'https://checkout.stripe.com/c/pay/cs_1', purchase_id: purchaseId,
    });
    expect(result.purchase_id).toBe(purchaseId);
  });

  it('does not expose continuations to legacy non-negotiated status callers', async () => {
    const state = setup();
    const result = await getBillingCreditPurchaseStatus({
      request, credential, actorToken: 'actor', endpoint: '/billing/v1/credits/purchase-status',
    }, {
      ...state.deps,
      readEvidence: vi.fn().mockResolvedValue({
        state: 'open',
        continuation: { redirect_url: 'https://checkout.stripe.com/c/pay/cs_1', purchase_id: purchaseId },
      }),
    } as never);
    expect(result.continuation).toBeUndefined();
  });
});
