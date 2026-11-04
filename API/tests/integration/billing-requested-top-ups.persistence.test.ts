import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBillingCreditTopUpCheckout } from '../../src/services/billing-credit-top-up.service.js';
import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { credential, databaseTestsEnabled, fundingActionContext, fundingRaceIds as ids,
  fundingRaceRequest, seedFundingRace, stripeAccount } from './billing-credit-funding-actions.persistence.fixture.js';

const amounts = [5, 10, 20, 100, 500] as const;
const prices = [
  { currency: 'USD', rate: '1', expected: [5000, 10000, 20000, 100000, 500000] },
  { currency: 'EUR', rate: '1.16123', expected: [5806, 11612, 23224, 116123, 580615] },
  { currency: 'GBP', rate: '1.31847', expected: [6592, 13184, 26369, 131847, 659235] },
] as const;
const cases = prices.flatMap((row) => amounts.map((amount, index) => ({
  ...row, amount, credits: row.expected[index]!, key: `credits_${row.currency.toLowerCase()}_${amount}`,
})));
const now = new Date('2026-11-04T20:00:00.000Z');

// Provider, FX and actor inputs are fixtures. Offer selection, checkout creation,
// payment application, credits and invoice sources go through UOA and PostgreSQL.
describe.skipIf(!databaseTestsEnabled)('requested one-time top-ups and invoice evidence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const db = () => handle!.prisma;
  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    await seedFundingRace(handle.prisma);
    for (const currency of ['EUR', 'GBP']) {
      await db().billingCreditFundingPolicy.create({ data: { id: `policy_${currency}`, currency,
        serviceId: ids.service, version: 1, topUpEnabled: true, automaticTopUpEnabled: false,
        automaticConsentVersion: 'auto-v1' } });
    }
    for (const { key, currency, amount, credits } of cases) {
      const terms = { paymentAmountMinor: BigInt(amount * 100),
        creditsReceivedMicrocredits: currency === 'USD' ? BigInt(credits) * 1_000_000n : 0n };
      await db().billingCreditTopUpOffer.create({ data: { ...terms, id: `offer_${key}`, key,
        policyId: currency === 'USD' ? ids.policy : `policy_${currency}`, version: 1,
        serviceId: ids.service, catalogKey: key, catalogVersion: 1, name: key,
        description: 'One-time purchase', automaticTopUpEligible: false } });
      await db().billingCreditTopUpCatalog.create({ data: { ...terms, key, currency, version: 1,
        accountId: ids.account, stripeLookupKey: key, stripeProductId: 'prod_requested_credits',
        stripePriceId: `price_${key}` } });
    }
  });
  afterAll(async () => { if (handle) await handle.cleanup(); });

  it.each(cases)('$currency $amount: unpaid, wrong amount, confirmed, replayed', async (row) => {
    const { currency, amount, rate, key, credits } = row;
    const minor = amount * 100;
    const microcredits = BigInt(credits) * 1_000_000n;
    const customer = 'cus_funding_race';
    const session = `cs_${key}`;
    const intent = `pi_${key}`;
    const charge = `ch_${key}`;
    const account = () => db().billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } });
    const before = await account();
    const context = fundingActionContext(before);
    const create = vi.fn(async (input: Stripe.Checkout.SessionCreateParams) => ({
      id: session, livemode: false, mode: 'payment', status: 'open', url: `https://checkout.stripe.com/${session}`,
      customer, client_reference_id: input.client_reference_id, metadata: input.metadata,
      expires_at: now.getTime() / 1000 + 86400,
    }));
    Object.assign(context.stripe, { checkout: { sessions: { create } }, prices: { retrieve: async () => ({
      id: `price_${key}`, active: true, livemode: false, type: 'one_time', currency: currency.toLowerCase(),
      lookup_key: key, unit_amount: minor,
      metadata: { uoa_kind: 'team_credit_top_up', ...(currency === 'USD' ? { credits: String(credits) }
        : { credits_basis: 'live_fx_rate' }) }, product: { id: 'prod_requested_credits', active: true,
        livemode: false, metadata: { uoa_kind: 'team_credits', credits_per_usd: '1000', contract_version: '1' } },
    }) } });
    const checkout = await createBillingCreditTopUpCheckout({
      request: { ...fundingRaceRequest, offerId: `offer_${key}` }, actorToken: 'evaluation',
      credential: { ...credential, actorIssuer: 'evaluation', actorAudience: 'evaluation',
        actorKeyId: 'evaluation', actorPublicJwk: {} },
      includePurchaseId: true, endpoint: '/billing/v1/credits/top-up-checkout',
    }, { prisma: db(), resolveContext: vi.fn().mockResolvedValue(context), now: () => now,
      readRegion: vi.fn().mockResolvedValue({ currency }), readRate: vi.fn().mockResolvedValue({
        currency, source: currency === 'USD' ? 'usd' : 'stripe', baseRate: rate,
        exchangeRate: currency === 'USD' ? null : rate, quoteId: currency === 'USD' ? null : `fxq_${key}`,
        fxSnapshotId: null, asOf: now,
      }) });
    const id = checkout.purchase_id!;
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0].line_items).toEqual([{ price: `price_${key}`, quantity: 1 }]);
    expect(await db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'OPEN', paymentAmountMinor: BigInt(minor), creditsReceivedMicrocredits: microcredits, currency,
    });
    const invoiceCount = () => db().billingCreditPaymentInvoice.count({ where: { topUpCheckoutId: id } });
    expect(await invoiceCount()).toBe(0);
    expect((await account()).balanceMicrocredits).toBe(before.balanceMicrocredits);
    const webhook = await db().billingStripeWebhookEvent.create({ data: { accountId: ids.account,
      stripeEventId: `evt_${key}`, type: 'payment_intent.succeeded', livemode: false, stripeCreatedAt: now,
      stripeObjectId: intent, stripeCustomerId: customer, stripeCheckoutSessionId: session, stripePaymentIntentId: intent,
      stripeChargeId: charge, amountMinor: BigInt(minor), currency } });
    const apply = (received: number) => db().$transaction((tx) => applyCreditFundingWebhook(tx, {
      event: { kind: 'payment_succeeded', localType: 'top_up', localId: id, checkoutSessionId: session,
        chargeId: charge, paymentMethodId: 'pm_funding_race', occurredAt: now,
        paymentIntent: { id: intent, status: 'succeeded', livemode: false, amount_received: received,
          currency: currency.toLowerCase(), customer, latest_charge: charge } as Stripe.PaymentIntent },
      eventFields: { stripeCreatedAt: now },
    }, webhook.id, stripeAccount));
    await expect(apply(minor - 1)).rejects.toThrow('STRIPE_CREDIT_TOP_UP_BINDING_INVALID');
    expect(await invoiceCount()).toBe(0);
    expect((await account()).balanceMicrocredits).toBe(before.balanceMicrocredits);
    await apply(minor);
    await apply(minor);
    expect(await invoiceCount()).toBe(1);
    expect(await db().billingCreditEntry.count({ where: { sourceType: 'credit_top_up_checkout', sourceId: id } }))
      .toBe(1);
    expect(await db().billingCreditPaymentInvoice.findFirstOrThrow({ where: { topUpCheckoutId: id } }))
      .toMatchObject({ grossAmountMinor: BigInt(minor), currency, creditsPurchasedMicrocredits: microcredits,
        stripePaymentIntentId: intent });
    const after = await account();
    expect(after.balanceMicrocredits - before.balanceMicrocredits).toBe(microcredits);
    expect(after.autoTopUpConsentRevisionId).toBe(before.autoTopUpConsentRevisionId);
    expect(after.autoTopUpGeneration).toBe(before.autoTopUpGeneration);
  });
});
