import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { lockCreditBalance } from '../../src/services/billing-credit-balance-lock.service.js';
import { buildBillingCreditAttention } from '../../src/services/billing-credit-funding-request.service.js';
import { runCreditAutoTopUpAccount } from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
const ADMIN_DOMAIN = 'region-reload-admin.example.test';
const account = { id: 'bsa_region_reload', stripeAccountId: 'acct_region_reload', livemode: false };
const user = 'usr_region_reload';
const service = 'svc_region_reload';
const appKey = 'bak_region_reload';
// Each region reloads EUR or GBP 25.00 when the lots are worth less than 5.00.
const regions = {
  EUR: { region: 'EUROPE', rate: '1.16', reloadRate: 1.2 },
  GBP: { region: 'UK', rate: '1.33', reloadRate: 1.35 },
} as const;
type Currency = keyof typeof regions;
const scoped = (currency: Currency) => {
  const code = currency.toLowerCase();
  return { org: `org-reload-${code}`, team: `team-reload-${code}`, customer: `bsc_reload_${code}`,
    credit: `bca_reload_${code}`, policy: `bcfp_reload_${code}`, offer: `bcto_reload_${code}`,
    option: `bcat_reload_${code}`, catalog: `bctc_reload_${code}`, revision: `bcar_reload_${code}`,
    lot: `bcl_open_reload_${code}`, pm: `pm_reload_${code}`, cus: `cus_reload_${code}` };
};

async function seed(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.user.create({ data: { id: user, email: 'reload@example.test', userKey: 'reload@example.test',
      name: 'Reload Owner' } });
    await tx.domainRole.create({ data: { domain: ADMIN_DOMAIN, userId: user, role: 'SUPERUSER' } });
    await tx.billingService.create({ data: { id: service, identifier: 'region-reload', name: 'Region Reload' } });
    await tx.billingAppKey.create({ data: { id: appKey, serviceId: service, purpose: 'CUSTOMER_LIFECYCLE',
      name: 'Region reload', keyPrefix: 'uoa_reload', secretDigest: 'c'.repeat(64),
      actorIssuer: 'https://reload.example.test', actorAudience: 'https://uoa.example.test',
      actorKeyId: 'reload-key', actorPublicJwk: { kty: 'RSA' }, checkoutReturnOrigins: ['https://reload.example.test'] } });
    await tx.billingStripeAccount.create({ data: account });
    for (const currency of Object.keys(regions) as Currency[]) {
      const ids = scoped(currency);
      const consentedAt = new Date('2026-10-12T09:00:00.000Z');
      await tx.organisation.create({ data: { id: ids.org, domain: `${ids.org}.example.test`, name: ids.org,
        slug: ids.org, ownerId: user } });
      await tx.orgMember.create({ data: { orgId: ids.org, userId: user, role: 'owner', status: 'ACTIVE' } });
      await tx.team.create({ data: { id: ids.team, orgId: ids.org, name: ids.team, slug: ids.team } });
      await tx.teamMember.create({ data: { teamId: ids.team, userId: user, teamRole: 'owner', status: 'ACTIVE' } });
      await tx.billingOrganisationRegion.create({ data: { orgId: ids.org, region: regions[currency].region, currency,
        setByUserId: user, usdPerUnit: regions[currency].rate } });
      await tx.billingStripeCustomer.create({ data: { id: ids.customer, accountId: account.id, orgId: ids.org,
        teamId: ids.team, scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`, stripeCustomerId: ids.cus } });
      await tx.billingCreditFundingPolicy.create({ data: { id: ids.policy, serviceId: service, currency, version: 1,
        topUpEnabled: true, automaticTopUpEnabled: true, automaticConsentVersion: 'auto-v1' } });
      await tx.billingCreditTopUpOffer.create({ data: { id: ids.offer, policyId: ids.policy, serviceId: service,
        key: `credits_${currency.toLowerCase()}_25`, version: 1, catalogKey: `credits_${currency.toLowerCase()}_25`,
        catalogVersion: 1, name: `${currency} 25`, description: 'Live rate', paymentAmountMinor: 2_500n,
        creditsReceivedMicrocredits: 0n, automaticTopUpEligible: true } });
      await tx.billingCreditAutoTopUpOption.create({ data: { id: ids.option, policyId: ids.policy, serviceId: service,
        refillOfferId: ids.offer, key: `refill_${currency.toLowerCase()}_25`, version: 1, thresholdMicrocredits: 0n,
        thresholdAmountMinor: 500n, monthlyChargeCapMinor: 10_000n } });
      await tx.billingCreditTopUpCatalog.create({ data: { id: ids.catalog, accountId: account.id,
        key: `credits_${currency.toLowerCase()}_25`, version: 1, currency, paymentAmountMinor: 2_500n,
        creditsReceivedMicrocredits: 0n, stripeLookupKey: `uoa_credits_${currency.toLowerCase()}_25_v1`,
        stripeProductId: 'prod_reload', stripePriceId: `price_reload_${currency.toLowerCase()}` } });
      await tx.billingCreditAutoTopUpConsentRevision.create({ data: { id: ids.revision, accountId: account.id,
        creditAccountId: ids.credit, orgId: ids.org, teamId: ids.team, serviceId: service, appKeyId: appKey,
        policyId: ids.policy, optionId: ids.option, refillOfferId: ids.offer, source: 'CUSTOMER_UPDATE',
        actorJti: `actor-${ids.revision}`, consentedByUserId: user, consentVersion: 'auto-v1',
        thresholdMicrocredits: 0n, thresholdAmountMinor: 500n, refillCreditsMicrocredits: 0n,
        refillPaymentAmountMinor: 2_500n, monthlyChargeCapMinor: 10_000n, stripePaymentMethodId: ids.pm,
        consentedAt } });
      // 6,000 credits bought in the region currency at the region's rate: worth more than 5.00.
      await tx.billingCreditAccount.create({ data: { id: ids.credit, accountId: account.id, customerId: ids.customer,
        orgId: ids.org, teamId: ids.team, scopeKey: `${ids.org}:${ids.team}`, balanceMicrocredits: 6_000_000_000n,
        autoTopUpState: 'ACTIVE', autoTopUpPolicyId: ids.policy, autoTopUpServiceId: service, autoTopUpAppKeyId: appKey,
        autoTopUpConsentRevisionId: ids.revision, autoTopUpOptionId: ids.option, autoTopUpThresholdMicrocredits: 0n,
        autoTopUpRefillOfferId: ids.offer, autoTopUpMonthlyChargeCapMinor: 10_000n, autoTopUpConsentVersion: 'auto-v1',
        autoTopUpConsentedAt: consentedAt, autoTopUpConsentedByUserId: user, stripePaymentMethodId: ids.pm } });
      await tx.billingCreditLot.create({ data: { id: ids.lot, creditAccountId: ids.credit, sourceEntryId: null,
        sequence: 0, currency: 'USD', paidAmountMinor: 600n, usdPerUnit: '1', grantedMicrocredits: 6_000_000_000n,
        remainingMicrocredits: 6_000_000_000n, openedAt: consentedAt } });
    }
  });
}

let intentCount = 0;
let spendCount = 0;

function stripeFor(currency: Currency) {
  const ids = scoped(currency);
  const code = currency.toLowerCase();
  const intents = new Map<string, Stripe.PaymentIntent>();
  return {
    rawRequest: vi.fn(async () => ({ id: `fxq_reload_${code}`, object: 'fx_quote', lock_duration: 'none',
      to_currency: 'usd', created: 1_791_806_400,
      rates: { [code]: { exchange_rate: regions[currency].reloadRate - 0.02,
        rate_details: { base_rate: regions[currency].reloadRate } } } })),
    paymentIntents: {
      create: vi.fn(async (input: Stripe.PaymentIntentCreateParams) => {
        intentCount += 1;
        const intent = { id: `pi_reload_${code}_${intentCount}`, object: 'payment_intent', amount: input.amount,
          amount_received: 0, currency: input.currency, customer: ids.cus, payment_method: ids.pm,
          latest_charge: `ch_reload_${code}`, livemode: false, status: 'processing',
          metadata: input.metadata } as Stripe.PaymentIntent;
        intents.set(intent.id, intent);
        return intent;
      }),
      retrieve: vi.fn(async (id: string) => intents.get(id)),
    },
    intents,
  };
}

describe.skipIf(!enabled)('automatic reload in the billing region currency (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const db = () => handle!.prisma;

  async function spend(currency: Currency, microcredits: bigint) {
    const ids = scoped(currency);
    spendCount += 1;
    const id = `reload_spend_${currency}_${spendCount}`;
    await db().$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.admin_auth_domain', ${ADMIN_DOMAIN}, true)`);
      const balance = await lockCreditBalance(tx, ids.credit);
      await tx.billingCreditAdminAdjustment.create({ data: { id: `bcaa_${id}`, accountId: account.id,
        creditAccountId: ids.credit, orgId: ids.org, teamId: ids.team, signedAmountMicrocredits: -microcredits,
        reason: 'Reload proof', idempotencyKey: id, createdByUserId: user, createdByEmail: 'reload@example.test',
        createdByAdminDomain: ADMIN_DOMAIN, creditEntryId: `bce_${id}` } });
      await tx.billingCreditEntry.create({ data: { id: `bce_${id}`, creditAccountId: ids.credit, direction: 'DEBIT',
        kind: 'ADJUSTMENT', amountMicrocredits: microcredits, balanceAfterMicrocredits: balance - microcredits,
        idempotencyKey: id, sourceType: 'credit_admin_adjustment', sourceId: `bcaa_${id}`, occurredAt: new Date() } });
    });
  }

  async function settle(currency: Currency, stripe: ReturnType<typeof stripeFor>, outcome: 'succeeded' | 'failed') {
    const [intent] = [...stripe.intents.values()];
    const settled = outcome === 'succeeded'
      ? { ...intent!, status: 'succeeded', amount_received: intent!.amount }
      : { ...intent!, status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } };
    stripe.intents.set(intent!.id, settled as Stripe.PaymentIntent);
    return applyTrustedCreditFundingStripeEvent({
      event: { id: `evt_reload_${currency}_${outcome}`, type: outcome === 'succeeded'
        ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
      api_version: '2026-06-24.dahlia', account: account.stripeAccountId, livemode: false,
      created: Math.floor(Date.now() / 1000), data: { object: settled } } as Stripe.Event,
      expectedPaymentIntentId: intent!.id, stripe: stripe as never, account, prisma: db() });
  }

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it.each(Object.keys(regions) as Currency[])('reloads %s 25.00 once a debit takes the lots below 5.00', async (currency) => {
    const ids = scoped(currency);
    const stripe = stripeFor(currency);
    const run = async () => {
      const result = await runCreditAutoTopUpAccount({ account, creditAccountId: ids.credit },
        { prisma: db(), stripe: stripe as never });
      if (result.outcome === 'failed') throw new Error(`reload failed: ${result.error}`);
      return result;
    };

    // 6,000 credits are worth USD 6.00, above 5.00 at the region's rate.
    expect(await run()).toMatchObject({ outcome: 'skipped', reason: 'threshold_not_reached' });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();

    await spend(currency, 1_000_000_000n);
    expect(await run()).toMatchObject({ outcome: 'submitted' });

    const attempt = await db().billingCreditAutoTopUpAttempt.findFirstOrThrow({ where: { creditAccountId: ids.credit } });
    const expected = BigInt(Math.floor(2_500 * regions[currency].reloadRate * 10)) * 1_000_000n;
    expect(attempt).toMatchObject({ currency, paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: expected,
      thresholdAmountMinor: 500n, fxRateSource: 'stripe', fxQuoteId: `fxq_reload_${currency.toLowerCase()}` });
    expect(attempt.fxBaseRate?.toNumber()).toBe(regions[currency].reloadRate);
    // USD 5.00 left, at the region's captured rate, is below 5.00 in its currency.
    expect(attempt.observedValueMinor).toBe(BigInt(Math.floor(500 / Number(regions[currency].rate))));
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2_500, currency: currency.toLowerCase(), off_session: true }),
      expect.anything());

    await settle(currency, stripe, 'succeeded');
    const lot = await db().billingCreditLot.findFirstOrThrow({ where: { creditAccountId: ids.credit, currency } });
    expect(lot).toMatchObject({ paidAmountMinor: 2_500n, grantedMicrocredits: expected });
    expect(lot.usdPerUnit.toNumber()).toBe(regions[currency].reloadRate);
  });

  it('pauses after a failed reload until the card is updated, with one alert and no retry', async () => {
    const ids = scoped('EUR');
    // 35,000 credits after the first reload; spending 30,000 leaves 5,000 of the EUR lot, worth EUR 4.16.
    await spend('EUR', 30_000_000_000n);
    const stripe = stripeFor('EUR');
    const run = async () => {
      const result = await runCreditAutoTopUpAccount({ account, creditAccountId: ids.credit },
        { prisma: db(), stripe: stripe as never });
      if (result.outcome === 'failed') throw new Error(`reload failed: ${result.error}`);
      return result;
    };
    expect(await run()).toMatchObject({ outcome: 'submitted' });

    await settle('EUR', stripe, 'failed');

    const credit = await db().billingCreditAccount.findUniqueOrThrow({ where: { id: ids.credit } });
    expect(credit.autoTopUpState).toBe('NEEDS_REVIEW');
    expect(await run()).toMatchObject({ outcome: 'skipped', reason: 'configuration_inactive' });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const attention = buildBillingCreditAttention({ creditAccountId: ids.credit,
      balanceMicrocredits: credit.balanceMicrocredits, periodKey: '2026-10', meteredBilling: true,
      account: { autoTopUpGeneration: credit.autoTopUpGeneration, autoTopUpState: credit.autoTopUpState,
        autoTopUpThresholdMicrocredits: credit.autoTopUpThresholdMicrocredits,
        autoTopUpMonthlyChargeCapMinor: credit.autoTopUpMonthlyChargeCapMinor, autoTopUpOptionId: credit.autoTopUpOptionId },
      policy: null, chargedThisMonthMinor: 0n, latestFundingCreditEntryId: null, paymentMethodExpired: false,
      secret: 'reload-attention-secret' });
    expect(attention.filter((item) => item.kind === 'payment_action_required')).toHaveLength(1);
  });
});
