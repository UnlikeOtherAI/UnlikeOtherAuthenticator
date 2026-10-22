import { BillingCreditCheckoutStatus, BillingCreditPaymentAdjustmentKind, Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lockCreditBalance } from '../../src/services/billing-credit-balance-lock.service.js';
import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import { readCreditBalanceValue, readCreditDisplayValues } from '../../src/services/billing-credit-lot-value.service.js';
import { applyPaymentAdjustment } from '../../src/services/billing-credit-payment-adjustment-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  databaseTestsEnabled,
  fundingRaceIds as ids,
  seedFundingRace,
  stripeAccount,
} from './billing-credit-funding-actions.persistence.fixture.js';

const ADMIN_DOMAIN = 'credit-lots-admin.example.test';
const eur = { policy: 'bcfp_lots_eur', offer: 'bcto_lots_eur_25', catalog: 'bctc_lots_eur_25' };
let clock = Date.parse('2026-10-12T10:00:00.000Z');
const tick = () => new Date(clock += 60_000);

describe.skipIf(!databaseTestsEnabled)('credit lots (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const db = (): PrismaClient => handle!.prisma;

  async function pay(id: string, currency: 'USD' | 'EUR') {
    const at = tick();
    const usd = currency === 'USD';
    await db().billingCreditTopUpCheckout.create({ data: {
      id, accountId: ids.account, creditAccountId: ids.creditAccount, customerId: ids.customer,
      catalogId: usd ? ids.catalog : eur.catalog, serviceId: ids.service, appKeyId: ids.appKey,
      offerId: usd ? ids.offer : eur.offer, actorJti: id, requestedByUserId: ids.user,
      paymentAmountMinor: usd ? 500n : 2_500n, currency,
      // USD 5.00 buys 5,000 credits; EUR 25.00 at 1.16123 buys 29,030.
      creditsReceivedMicrocredits: usd ? 5_000_000_000n : 29_030_000_000n,
      ...(usd ? {} : { fxRateSource: 'stripe', fxBaseRate: '1.16123', fxExchangeRate: '1.13844', fxQuoteId: `fxq_${id}` }),
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date(at.getTime() + 3_600_000),
    } });
    await db().billingCreditTopUpCheckout.update({ where: { id },
      data: { stripeCheckoutSessionId: `cs_${id}`, status: BillingCreditCheckoutStatus.OPEN } });
    const webhook = await db().billingStripeWebhookEvent.create({ data: { accountId: ids.account,
      stripeEventId: `evt_${id}`, type: 'payment_intent.succeeded', livemode: false, stripeCreatedAt: at,
      stripeObjectId: `pi_${id}`, stripeCustomerId: 'cus_funding_race', stripeCheckoutSessionId: `cs_${id}`,
      stripePaymentIntentId: `pi_${id}`, stripeChargeId: `ch_${id}`, amountMinor: usd ? 500n : 2_500n, currency } });
    await db().$transaction((tx) => applyCreditFundingWebhook(tx, {
      event: { kind: 'payment_succeeded', localType: 'top_up', localId: id, checkoutSessionId: `cs_${id}`,
        chargeId: `ch_${id}`, paymentMethodId: 'pm_funding_race', occurredAt: at,
        paymentIntent: { id: `pi_${id}`, status: 'succeeded', livemode: false, amount_received: usd ? 500 : 2_500,
          currency: currency.toLowerCase(), customer: 'cus_funding_race', latest_charge: `ch_${id}` } as never },
      eventFields: { stripeCreatedAt: at },
    }, webhook.id, stripeAccount));
    return (await db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id } })).creditEntryId as string;
  }

  async function adjust(id: string, signed: bigint, client: PrismaClient = db()) {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.admin_auth_domain', ${ADMIN_DOMAIN}, true)`);
      const balance = await lockCreditBalance(tx, ids.creditAccount);
      await tx.billingCreditAdminAdjustment.create({ data: { id: `bcaa_${id}`, accountId: ids.account,
        creditAccountId: ids.creditAccount, orgId: ids.org, teamId: ids.team, signedAmountMicrocredits: signed,
        reason: 'Credit lot proof', idempotencyKey: id, createdByUserId: ids.user,
        createdByEmail: 'funding-race@example.com', createdByAdminDomain: ADMIN_DOMAIN, creditEntryId: `bce_${id}` } });
      await tx.billingCreditEntry.create({ data: { id: `bce_${id}`, creditAccountId: ids.creditAccount,
        direction: signed > 0n ? 'CREDIT' : 'DEBIT', kind: 'ADJUSTMENT', amountMicrocredits: signed < 0n ? -signed : signed,
        balanceAfterMicrocredits: balance + signed, idempotencyKey: id, sourceType: 'credit_admin_adjustment',
        sourceId: `bcaa_${id}`, occurredAt: tick() } });
    });
    return `bce_${id}`;
  }

  async function refund(checkoutId: string, kind: BillingCreditPaymentAdjustmentKind, objectId: string, minor: bigint,
    currency: 'USD' | 'EUR' = 'USD') {
    const at = tick();
    await db().$transaction(async (tx) => {
      const reversal = kind === BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL;
      const webhook = await tx.billingStripeWebhookEvent.create({ data: { accountId: ids.account,
        stripeEventId: `evt_${kind}_${objectId}`, type: reversal ? 'refund.failed' : 'refund.updated',
        apiVersion: '2026-06-24.dahlia', livemode: false, stripeCreatedAt: at, stripeObjectId: objectId,
        stripeObjectStatus: reversal ? 'failed' : 'succeeded', stripeCustomerId: 'cus_funding_race',
        stripePaymentIntentId: `pi_${checkoutId}`, stripeChargeId: `ch_${checkoutId}`, amountMinor: minor,
        currency } });
      await applyPaymentAdjustment(tx, { kind: 'payment_adjustment', localId: checkoutId, localType: 'top_up',
        adjustmentKind: kind, stripeObjectId: objectId,
        paymentIntent: { id: `pi_${checkoutId}`, customer: 'cus_funding_race', latest_charge: `ch_${checkoutId}`,
          payment_method: 'pm_funding_race' } as never,
        paymentIntentId: `pi_${checkoutId}`, chargeId: `ch_${checkoutId}`, amountMinor: minor, currency,
        occurredAt: at }, webhook.id, stripeAccount);
    });
  }

  const lots = () => db().billingCreditLot.findMany({ where: { creditAccountId: ids.creditAccount },
    orderBy: { sequence: 'asc' } });
  const movements = (entryId: string) => db().billingCreditLotMovement.findMany({ where: { entryId },
    orderBy: { id: 'asc' }, select: { lotId: true, deltaMicrocredits: true } });
  async function expectBalanced() {
    const [account, all, debt] = await Promise.all([
      db().billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } }), lots(),
      db().billingCreditLotMovement.aggregate({ where: { creditAccountId: ids.creditAccount, lotId: null },
        _sum: { deltaMicrocredits: true } })]);
    const remaining = all.reduce((sum, lot) => sum + lot.remainingMicrocredits, 0n);
    expect(remaining + (debt._sum.deltaMicrocredits ?? 0n)).toBe(account.balanceMicrocredits);
  }

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedFundingRace(handle.prisma);
    await handle.prisma.domainRole.create({ data: { domain: ADMIN_DOMAIN, userId: ids.user, role: 'SUPERUSER' } });
    await handle.prisma.billingCreditFundingPolicy.create({ data: { id: eur.policy, serviceId: ids.service,
      currency: 'EUR', version: 1, topUpEnabled: true, automaticTopUpEnabled: true, automaticConsentVersion: 'auto-v1' } });
    await handle.prisma.billingCreditTopUpOffer.create({ data: { id: eur.offer, policyId: eur.policy,
      serviceId: ids.service, key: 'credits_eur_25', version: 1, catalogKey: 'credits_eur_25', catalogVersion: 1,
      name: 'EUR 25', description: 'Live rate', paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 0n } });
    await handle.prisma.billingCreditTopUpCatalog.create({ data: { id: eur.catalog, accountId: ids.account,
      key: 'credits_eur_25', version: 1, currency: 'EUR', paymentAmountMinor: 2_500n, creditsReceivedMicrocredits: 0n,
      stripeLookupKey: 'uoa_credits_eur_25_v1', stripeProductId: 'prod_funding_race', stripePriceId: 'price_eur_25' } });
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('opens a lot per purchase and draws a debit oldest-first, one movement per lot', async () => {
    const usd = await pay('bctu_lots_usd_1', 'USD');
    const euro = await pay('bctu_lots_eur_1', 'EUR');
    expect((await lots()).map((lot) => [lot.sourceEntryId, lot.currency, lot.paidAmountMinor, lot.usdPerUnit.toFixed(),
      lot.remainingMicrocredits])).toEqual([
      [usd, 'USD', 500n, '1', 5_000_000_000n],
      [euro, 'EUR', 2_500n, '1.16123', 29_030_000_000n],
    ]);

    const debit = await adjust('lots_debit_spanning', -8_000_000_000n);

    expect(await movements(debit)).toEqual([
      { lotId: `bcl_${usd}`, deltaMicrocredits: -5_000_000_000n },
      { lotId: `bcl_${euro}`, deltaMicrocredits: -3_000_000_000n },
    ]);
    expect((await lots()).map((lot) => lot.remainingMicrocredits)).toEqual([0n, 26_030_000_000n]);
    await expectBalanced();
  });

  it('values the balance in what it was bought at, whatever the exchange rate does', async () => {
    await db().billingOrganisationRegion.create({ data: { orgId: ids.org, region: 'EUROPE', currency: 'EUR',
      setByUserId: ids.user, usdPerUnit: '1.20' } });
    const before = await readCreditBalanceValue({ creditAccountId: ids.creditAccount, organisationId: ids.org },
      { db: db(), stripe: null });
    // 26,030 credits of the EUR 25.00 lot (29,030 credits) are worth EUR 22.41.
    expect(before).toEqual({ currency: 'EUR', amount: '22.41', amountMinor: 2_241n });

    const usdLot = await pay('bctu_lots_usd_2', 'USD');
    const after = await readCreditBalanceValue({ creditAccountId: ids.creditAccount, organisationId: ids.org },
      { db: db(), stripe: null });
    // The EUR lot keeps its value; the new USD 5.00 lot is valued at the region's captured 1.20.
    expect(after).toEqual({ currency: 'EUR', amount: '26.58', amountMinor: 2_658n });
    expect(await movements(usdLot)).toEqual([]);
    await expect(db().billingOrganisationRegion.update({ where: { orgId: ids.org },
      data: { usdPerUnit: '1.30' } })).rejects.toThrow(/BILLING_REGION_IMMUTABLE/);
  });

  it('values each entry from the lots it drew, and the next credits at the oldest lot\'s rate', async () => {
    const debit = 'bce_lots_debit_spanning';
    const euro = (await db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id: 'bctu_lots_eur_1' } }))
      .creditEntryId as string;
    const dollars = (await db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id: 'bctu_lots_usd_2' } }))
      .creditEntryId as string;
    const values = await readCreditDisplayValues({ creditAccountId: ids.creditAccount, organisationId: ids.org,
      entryIds: [debit, euro, dollars, 'bce_without_movements'] }, { db: db(), stripe: null });
    // USD 5.00 from the USD lot at the region's 1.20 (EUR 4.1666) plus 3,000 EUR-lot credits (EUR 2.5834).
    expect(values.entries.get(debit)).toEqual({ currency: 'EUR', amount: '6.75', amountMinor: 675n });
    // The EUR 25.00 purchase is worth what was paid for it.
    expect(values.entries.get(euro)).toEqual({ currency: 'EUR', amount: '25.00', amountMinor: 2_500n });
    // USD 5.00 bought after the region was chosen is worth its credits at the region's 1.20.
    expect(values.entries.get(dollars)).toEqual({ currency: 'EUR', amount: '4.16', amountMinor: 416n });
    expect(values.entries.has('bce_without_movements')).toBe(false);
    expect(values.balance).toEqual({ currency: 'EUR', amount: '26.58', amountMinor: 2_658n });
    // The first USD lot is spent, so the next credits come from the EUR lot at its own rate.
    const eurLot = (await lots()).find((lot) => lot.sourceEntryId === euro)!;
    expect(values.nextRate).toEqual({ currency: 'EUR', usdPerUnit: '1.16123', source: 'purchase',
      asOf: eurLot.openedAt });
  });

  it('refunds from the refunded purchase\'s own lot and gives a reversal back to it', async () => {
    const own = await db().billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id: 'bctu_lots_usd_2' } });
    await refund('bctu_lots_usd_2', BillingCreditPaymentAdjustmentKind.REFUND, 're_lots_usd_2', 500n);
    const refundEntry = await db().billingCreditEntry.findFirstOrThrow({ where: { kind: 'REFUND',
      reversesEntryId: own.creditEntryId } });
    // The older EUR lot is untouched; the refunded USD purchase's own lot pays it.
    expect(await movements(refundEntry.id)).toEqual([
      { lotId: `bcl_${own.creditEntryId}`, deltaMicrocredits: -5_000_000_000n }]);

    await refund('bctu_lots_usd_2', BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL, 're_lots_usd_2', 500n);
    const reversal = await db().billingCreditEntry.findFirstOrThrow({ where: { kind: 'REFUND_REVERSAL',
      reversesEntryId: own.creditEntryId } });
    expect(await movements(reversal.id)).toEqual([
      { lotId: `bcl_${own.creditEntryId}`, deltaMicrocredits: 5_000_000_000n }]);
    await expectBalanced();
  });

  it('records a refund of spent credits as debt that the next purchase pays first', async () => {
    const spent = await adjust('lots_spend_all', -31_030_000_000n);
    expect((await lots()).every((lot) => lot.remainingMicrocredits === 0n)).toBe(true);
    expect((await movements(spent)).length).toBe(2);

    await refund('bctu_lots_usd_1', BillingCreditPaymentAdjustmentKind.REFUND, 're_lots_usd_1', 500n);
    const debt = await db().billingCreditLotMovement.aggregate({ where: { creditAccountId: ids.creditAccount,
      lotId: null }, _sum: { deltaMicrocredits: true } });
    expect(debt._sum.deltaMicrocredits).toBe(-5_000_000_000n);

    const next = await pay('bctu_lots_eur_2', 'EUR');
    expect(await movements(next)).toEqual([
      { lotId: `bcl_${next}`, deltaMicrocredits: -5_000_000_000n },
      { lotId: null, deltaMicrocredits: 5_000_000_000n },
    ]);
    expect((await lots()).at(-1)?.remainingMicrocredits).toBe(24_030_000_000n);
    await expectBalanced();
  });

  it('serializes concurrent debits on one account without losing a lot movement', async () => {
    await adjust('lots_concurrent_grant', 10_000_000_000n);
    const debits = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      adjust(`lots_concurrent_${index}`, -3_000_000_000n)));

    const drawn = await db().billingCreditLotMovement.aggregate({ where: { entryId: { in: debits } },
      _sum: { deltaMicrocredits: true } });
    expect(drawn._sum.deltaMicrocredits).toBe(-18_000_000_000n);
    await expectBalanced();
  });

  it('refunds what is left of a EUR lot, in EUR, from that lot alone', async () => {
    const entry = await pay('bctu_lots_eur_3', 'EUR');
    const lot = async () => (await lots()).find((row) => row.sourceEntryId === entry)!;
    // Spend every older lot and 3,000 of this lot's 29,030 credits.
    const older = (await lots()).filter((row) => row.sourceEntryId !== entry)
      .reduce((sum, row) => sum + row.remainingMicrocredits, 0n);
    await adjust('lots_spend_into_eur_3', -(older + 3_000_000_000n));
    expect((await lot()).remainingMicrocredits).toBe(26_030_000_000n);

    // What is left is worth EUR 22.41 of the EUR 25.00 paid; refunding that takes back 26,022 credits, all from
    // this lot, and leaves 8 credits, worth under a cent.
    await refund('bctu_lots_eur_3', BillingCreditPaymentAdjustmentKind.REFUND, 're_lots_eur_3', 2_241n, 'EUR');
    const refunded = await db().billingCreditEntry.findFirstOrThrow({ where: { kind: 'REFUND', reversesEntryId: entry } });
    expect(refunded).toMatchObject({ amountMicrocredits: 26_022_000_000n, currency: 'USD' });
    expect(await movements(refunded.id)).toEqual([{ lotId: `bcl_${entry}`, deltaMicrocredits: -26_022_000_000n }]);
    await expect(db().billingCreditPaymentAdjustment.findFirstOrThrow({ where: { stripeObjectId: 're_lots_eur_3' } }))
      .resolves.toMatchObject({ currency: 'EUR', amountMinor: 2_241n, amountMicrocredits: 26_022_000_000n });
    await expect(readCreditBalanceValue({ creditAccountId: ids.creditAccount, organisationId: ids.org },
      { db: db(), stripe: null })).resolves.toEqual({ currency: 'EUR', amount: '0.00', amountMinor: 0n });

    // A refund that fails gives the same credits back to the same lot.
    await refund('bctu_lots_eur_3', BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL, 're_lots_eur_3', 2_241n, 'EUR');
    const reversal = await db().billingCreditEntry.findFirstOrThrow({ where: { kind: 'REFUND_REVERSAL',
      reversesEntryId: entry } });
    expect(await movements(reversal.id)).toEqual([{ lotId: `bcl_${entry}`, deltaMicrocredits: 26_022_000_000n }]);

    // Refunding all EUR 25.00 takes back exactly the 29,030 credits it bought: the lot, then debt for what was spent.
    await refund('bctu_lots_eur_3', BillingCreditPaymentAdjustmentKind.REFUND, 're_lots_eur_3_all', 2_500n, 'EUR');
    const all = await db().billingCreditEntry.findFirstOrThrow({ where: { kind: 'REFUND', reversesEntryId: entry,
      NOT: { id: refunded.id } } });
    expect(all.amountMicrocredits).toBe(29_030_000_000n);
    expect(await movements(all.id)).toEqual([
      { lotId: `bcl_${entry}`, deltaMicrocredits: -26_030_000_000n },
      { lotId: null, deltaMicrocredits: -3_000_000_000n },
    ]);
    await expectBalanced();
  });

  it('refuses any change to a lot\'s terms or to a movement', async () => {
    const [first] = await lots();
    await expect(db().billingCreditLot.update({ where: { id: first!.id }, data: { usdPerUnit: '2' } }))
      .rejects.toThrow(/keeps its terms/);
    await expect(db().billingCreditLotMovement.updateMany({ where: { creditAccountId: ids.creditAccount },
      data: { deltaMicrocredits: 1n } })).rejects.toThrow(/immutable/);
  });
});
