import { BillingCreditCheckoutStatus, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  databaseTestsEnabled,
  fundingRaceIds as ids,
  seedFundingRace,
  stripeAccount,
} from './billing-credit-funding-actions.persistence.fixture.js';

const eur = { policy: 'bcfp_region_eur', offer: 'bcto_region_eur_25', catalog: 'bctc_region_eur_25' };
const paidAt = new Date('2026-10-12T12:05:00.000Z');

function checkout(id: string, overrides: Partial<Prisma.BillingCreditTopUpCheckoutUncheckedCreateInput> = {}) {
  return {
    id, accountId: ids.account, creditAccountId: ids.creditAccount, customerId: ids.customer,
    catalogId: eur.catalog, serviceId: ids.service, appKeyId: ids.appKey, offerId: eur.offer,
    actorJti: id, requestedByUserId: ids.user, paymentAmountMinor: 2_500n,
    creditsReceivedMicrocredits: 29_030_000_000n, currency: 'EUR', fxRateSource: 'stripe',
    fxBaseRate: '1.16123', fxExchangeRate: '1.13844', fxQuoteId: 'fxq_region_1',
    successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
    leaseExpiresAt: new Date('2026-10-12T13:00:00.000Z'),
    ...overrides,
  } satisfies Prisma.BillingCreditTopUpCheckoutUncheckedCreateInput;
}

describe.skipIf(!databaseTestsEnabled)('credit top-ups in the region currency (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const db = () => handle!.prisma;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedFundingRace(handle.prisma);
    await handle.prisma.billingCreditFundingPolicy.create({ data: { id: eur.policy, serviceId: ids.service,
      currency: 'EUR', version: 1, topUpEnabled: true, automaticTopUpEnabled: true,
      automaticConsentVersion: 'auto-v1' } });
    await handle.prisma.billingCreditTopUpOffer.create({ data: { id: eur.offer, policyId: eur.policy,
      serviceId: ids.service, key: 'credits_eur_25', version: 1, catalogKey: 'credits_eur_25', catalogVersion: 1,
      name: 'EUR 25', description: 'Live rate', paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 0n,
      automaticTopUpEligible: true } });
    await handle.prisma.billingCreditTopUpCatalog.create({ data: { id: eur.catalog, accountId: ids.account,
      key: 'credits_eur_25', version: 1, currency: 'EUR', paymentAmountMinor: 2_500n,
      creditsReceivedMicrocredits: 0n, stripeLookupKey: 'uoa_credits_eur_25_v1',
      stripeProductId: 'prod_funding_race', stripePriceId: 'price_eur_25' } });
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('lets a GBP or EUR offer carry no credits and a USD offer only fixed ones', async () => {
    await expect(db().billingCreditTopUpOffer.create({ data: { policyId: eur.policy, serviceId: ids.service,
      key: 'credits_eur_10', version: 1, catalogKey: 'credits_eur_10', catalogVersion: 1, name: 'EUR 10',
      description: 'fixed', paymentAmountMinor: 1_000n, creditsReceivedMicrocredits: 10_000_000_000n } }))
      .rejects.toThrow(/does not match its service funding policy/);
    await expect(db().billingCreditTopUpOffer.create({ data: { policyId: ids.policy, serviceId: ids.service,
      key: 'credits_usd_free', version: 1, catalogKey: 'credits_usd_free', catalogVersion: 1, name: 'USD 10',
      description: 'no credits', paymentAmountMinor: 1_000n, creditsReceivedMicrocredits: 0n } }))
      .rejects.toThrow(/does not match its service funding policy/);
    await expect(db().billingCreditTopUpCatalog.create({ data: { accountId: ids.account, key: 'credits_chf_25',
      version: 1, currency: 'CHF', paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 0n,
      stripeLookupKey: 'uoa_credits_chf_25_v1' } })).rejects.toThrow(/currency_check/);
  });

  it('requires the stored rate evidence on every GBP or EUR checkout', async () => {
    await expect(db().billingCreditTopUpCheckout.create({ data: checkout('bctu_region_no_rate', {
      fxRateSource: null, fxBaseRate: null, fxExchangeRate: null, fxQuoteId: null }) }))
      .rejects.toThrow(/fixed_conversion_check/);
    await expect(db().billingCreditTopUpCheckout.create({ data: checkout('bctu_region_ecb_no_snapshot', {
      fxRateSource: 'ecb', fxExchangeRate: null, fxQuoteId: null }) })).rejects.toThrow(/fixed_conversion_check/);
    await expect(db().billingCreditTopUpCheckout.create({ data: checkout('bctu_region_part_credit', {
      creditsReceivedMicrocredits: 29_030_500_000n }) })).rejects.toThrow(/fixed_conversion_check/);
    await expect(db().billingCreditTopUpCheckout.create({ data: checkout('bctu_region_gbp_on_eur', {
      currency: 'GBP' }) })).rejects.toThrow(/binding is incoherent/);
    await expect(db().billingCreditTopUpCheckout.create({ data: {
      ...checkout('bctu_region_usd_rate'), currency: 'USD', catalogId: ids.catalog, offerId: ids.offer,
      paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n } }))
      .rejects.toThrow(/fixed_conversion_check/);
  });

  it('grants exactly the stored credits as a USD entry and invoices the EUR payment', async () => {
    const id = 'bctu_region_paid';
    const sessionId = 'cs_region_paid';
    const intentId = 'pi_region_paid';
    const chargeId = 'ch_region_paid';
    const webhookId = 'bswe_region_paid';
    await db().billingCreditTopUpCheckout.create({ data: checkout(id) });
    await db().billingCreditTopUpCheckout.update({ where: { id },
      data: { stripeCheckoutSessionId: sessionId, status: BillingCreditCheckoutStatus.OPEN } });
    await db().billingStripeWebhookEvent.create({ data: { id: webhookId, accountId: ids.account,
      stripeEventId: 'evt_region_paid', type: 'payment_intent.succeeded', livemode: false, stripeCreatedAt: paidAt,
      stripeObjectId: intentId, stripeCustomerId: 'cus_funding_race', stripeCheckoutSessionId: sessionId,
      stripePaymentIntentId: intentId, stripeChargeId: chargeId, amountMinor: 2_500n, currency: 'EUR' } });
    const prepared = {
      event: {
        kind: 'payment_succeeded' as const, localType: 'top_up' as const, localId: id,
        checkoutSessionId: sessionId, chargeId, paymentMethodId: 'pm_funding_race', occurredAt: paidAt,
        paymentIntent: { id: intentId, status: 'succeeded', livemode: false, amount_received: 2_500,
          currency: 'eur', customer: 'cus_funding_race', latest_charge: chargeId } as never,
      },
      eventFields: { stripeCreatedAt: paidAt },
    };
    const before = await db().billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } });

    await db().$transaction((tx) => applyCreditFundingWebhook(tx, prepared, webhookId, stripeAccount));

    const [paid, entry, invoice, after] = await Promise.all([
      db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id } }),
      db().billingCreditEntry.findFirstOrThrow({ where: { sourceType: 'credit_top_up_checkout', sourceId: id } }),
      db().billingCreditPaymentInvoice.findFirstOrThrow({ where: { stripePaymentIntentId: intentId } }),
      db().billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } }),
    ]);
    expect(paid.status).toBe(BillingCreditCheckoutStatus.COMPLETE);
    expect(entry).toMatchObject({ currency: 'USD', amountMicrocredits: 29_030_000_000n, kind: 'TOP_UP' });
    expect(invoice).toMatchObject({ currency: 'EUR', grossAmountMinor: 2_500n,
      creditsPurchasedMicrocredits: 29_030_000_000n });
    expect(after.balanceMicrocredits - before.balanceMicrocredits).toBe(29_030_000_000n);
  }, 30_000);
});
