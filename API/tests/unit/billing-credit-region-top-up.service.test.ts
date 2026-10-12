import { BillingAppKeyPurpose, BillingCreditCheckoutStatus, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { CreditFundingActionContext } from '../../src/services/billing-credit-funding-context.service.js';
import { createBillingCreditTopUpCheckout } from '../../src/services/billing-credit-top-up.service.js';
import { AppError } from '../../src/utils/errors.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const credential = {
  id: 'app_key_nessie',
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  checkoutReturnOrigins: ['https://app.nessie.example'],
  service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' },
} as unknown as Parameters<typeof createBillingCreditTopUpCheckout>[0]['credential'];
const request = { product: 'nessie', organisationId: 'org_eu', teamId: 'team_eu', userId: 'user_eu' };
const eurSelection = {
  policy: { id: 'policy_eur', currency: 'EUR' },
  offer: { id: 'offer_eur_20', paymentAmountMinor: 2_000n, creditsReceivedMicrocredits: 0n },
  catalog: { id: 'catalog_eur_20', stripePriceId: 'price_eur_20', stripeProductId: 'prod_credits' },
};

function harness() {
  const sessionsCreate = vi.fn(async (input: Record<string, unknown>) => ({
    id: 'cs_topup_eur', livemode: false, mode: 'payment', status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_topup_eur', customer: input.customer,
    client_reference_id: input.client_reference_id, metadata: input.metadata, expires_at: 1_791_000_000,
  }));
  const stripe = { checkout: { sessions: { create: sessionsCreate } } };
  const customer = { id: 'customer_eu', stripeCustomerId: 'cus_eu' };
  const context = {
    actor: { jti: 'actor_jti_eu' },
    account: { id: 'account_1', stripeAccountId: 'acct_uoa', livemode: false },
    creditAccount: { id: 'credit_account_eu' },
    customer,
    stripe,
    authorizeAction: vi.fn(),
    ensureCustomer: vi.fn().mockResolvedValue(customer),
  } as unknown as CreditFundingActionContext;
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data, id: 'checkout_eur_1', status: BillingCreditCheckoutStatus.CREATING,
  }));
  const prisma = {
    billingCreditTopUpCheckout: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create,
      update: vi.fn(),
    },
  } as unknown as PrismaClient;
  return { prisma, context, sessionsCreate, create };
}

describe('credit top-ups in the billing region currency', () => {
  it('fixes a EUR top-up at the live rate read as its checkout is created', async () => {
    const state = harness();
    const resolveOffer = vi.fn().mockResolvedValue(eurSelection);
    const readRate = vi.fn().mockResolvedValue({
      currency: 'EUR', source: 'stripe', baseRate: '1.16123', exchangeRate: '1.138', quoteId: 'fxq_live_1',
      fxSnapshotId: null, asOf: now,
    });

    await createBillingCreditTopUpCheckout(
      { request: { ...request, offerId: eurSelection.offer.id }, actorToken: 'actor', credential,
        endpoint: '/billing/v1/credits/top-up-checkout' },
      {
        prisma: state.prisma, now: () => now, resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOffer, validateCatalog: vi.fn(),
        readRegion: vi.fn().mockResolvedValue({ region: 'EUROPE', currency: 'EUR' }), readRate,
      },
    );

    // USD offers stay open to older consumers; the region adds EUR.
    expect(resolveOffer.mock.calls[0]![0]).toMatchObject({ currencies: ['USD', 'EUR'] });
    expect(readRate).toHaveBeenCalledWith('EUR', expect.objectContaining({ stripe: state.context.stripe }));
    // EUR 20.00 × 1.16123 = USD 23.2246, rounded down to 23,224 whole credits.
    expect(state.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        currency: 'EUR', paymentAmountMinor: 2_000n, creditsReceivedMicrocredits: 23_224_000_000n,
        fxRateSource: 'stripe', fxBaseRate: '1.16123', fxExchangeRate: '1.138', fxQuoteId: 'fxq_live_1',
        fxSnapshotId: null,
      }),
    });
    expect(state.sessionsCreate.mock.calls[0]![0]).toMatchObject({
      line_items: [{ price: 'price_eur_20', quantity: 1 }],
    });
  });

  it('keeps a USD top-up at its fixed credits for an organisation without a region', async () => {
    const state = harness();
    const usd = {
      policy: { id: 'policy_usd', currency: 'USD' },
      offer: { id: 'offer_usd_25', paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 25_000_000_000n },
      catalog: { id: 'catalog_usd_25', stripePriceId: 'price_usd_25', stripeProductId: 'prod_credits' },
    };
    const resolveOffer = vi.fn().mockResolvedValue(usd);

    await createBillingCreditTopUpCheckout(
      { request: { ...request, offerId: usd.offer.id }, actorToken: 'actor', credential,
        endpoint: '/billing/v1/credits/top-up-checkout' },
      {
        prisma: state.prisma, now: () => now, resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOffer, validateCatalog: vi.fn(), readRegion: vi.fn().mockResolvedValue(null),
      },
    );

    expect(resolveOffer.mock.calls[0]![0]).toMatchObject({ currencies: ['USD'] });
    const data = state.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ currency: 'USD', creditsReceivedMicrocredits: 25_000_000_000n });
    expect(data).not.toHaveProperty('fxRateSource');
  });

  it('refuses a EUR top-up without a checkout or Stripe session while no rate can be read', async () => {
    const state = harness();

    await expect(createBillingCreditTopUpCheckout(
      { request: { ...request, offerId: eurSelection.offer.id }, actorToken: 'actor', credential,
        endpoint: '/billing/v1/credits/top-up-checkout' },
      {
        prisma: state.prisma, now: () => now, resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOffer: vi.fn().mockResolvedValue(eurSelection), validateCatalog: vi.fn(),
        readRegion: vi.fn().mockResolvedValue({ region: 'EUROPE', currency: 'EUR' }),
        readRate: vi.fn().mockRejectedValue(
          new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_CREDIT_FX_RATE_UNAVAILABLE')),
      },
    )).rejects.toMatchObject({ message: 'BILLING_CREDIT_FX_RATE_UNAVAILABLE', statusCode: 503 });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.sessionsCreate).not.toHaveBeenCalled();
  });
});
