import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsIds } from '../helpers/sms-financial-fixture.js';
import { activateAcceptedSeatUsage } from '../../src/services/billing-seat-acceptance.service.js';
import { recoverAcceptedSeatUsage } from '../../src/services/billing-seat-usage-recovery.service.js';
import { fetchVerifiedLedgerBudgetReceiptSet } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import { resolveBillingTariffForMonth, utcBillingMonth, nextUtcBillingMonth } from '../../src/services/billing-tariff-history.service.js';

describe.skipIf(!process.env.DATABASE_URL)('prospective accepted Standard company usage terms', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let defaultId: string;
  let standardId: string;
  let offerId: string;
  const now = new Date();
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    await seedSmsFinance(db.prisma, false);
    await db.prisma.billingService.update({ where: { id: smsIds.service }, data: { tariffHistoryFromMonth: utcBillingMonth(now) } });
    const free = await db.prisma.billingTariff.create({ data: { serviceId: smsIds.service, key: 'default-free', version: 1,
      name: 'Free', mode: 'FREE', collectionMode: 'NONE', usagePaymentMode: 'PAY_AS_YOU_GO', markupBps: 0,
      currency: 'USD', usageCurrency: 'USD' } }); defaultId = free.id;
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId: smsIds.service, source: 'SERVICE_DEFAULT',
      scopeKey: smsIds.service, effectiveFromMonth: utcBillingMonth(now), tariffId: free.id, reason: 'Synthetic default' } });
    const tariff = await db.prisma.billingTariff.create({ data: { serviceId: smsIds.service, key: 'standard-eur', version: 2,
      name: 'Standard', mode: 'STANDARD', collectionMode: 'STRIPE', usagePaymentMode: 'PREPAID', markupBps: 3000,
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED', monthlyAmountMinor: 299n,
      currency: 'EUR', usageCurrency: 'USD' } }); standardId = tariff.id;
    const offer = await db.prisma.billingSeatOffer.create({ data: { serviceId: smsIds.service,
      tariffId: tariff.id, publishedByEmail: 'operator@example.test' } }); offerId = offer.id;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  async function checkout(suffix: string) {
    const user = await db.prisma.user.create({ data: { email: `${suffix}@example.test`, userKey: `${suffix}@example.test` } });
    const org = await db.prisma.organisation.create({ data: { ownerId: user.id, domain: `${suffix}.example.test`, name: suffix, slug: suffix } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: { accountId: smsIds.account, orgId: org.id,
      scope: 'ORGANISATION', scopeKey: org.id, stripeCustomerId: `cus_${suffix}` } });
    const row = await db.prisma.billingStripeCheckoutSession.create({ data: { accountId: smsIds.account,
      appKeyId: smsIds.lifecycle, customerId: customer.id, serviceId: smsIds.service, tariffId: standardId,
      tariffSource: 'ORGANISATION', seatOfferId: offerId, seatConsentTerms: {
        terms_version: 'company-standard-seat-v1', accepted: true, checkout_text: 'Synthetic exact accepted terms',
        unit_amount_minor: '299', currency: 'EUR', usage_currency: 'USD', usage_payment_mode: 'prepaid', usage_markup_bps: 3000 },
      orgId: org.id, scope: 'ORGANISATION', scopeKey: org.id, actorJti: suffix, requestedByUserId: user.id,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date(now.getTime() + 600_000) } });
    return { row, team };
  }
  it('activates genuinely first usage prospectively and rejects historical timestamp re-rating', async () => {
    const { row, team } = await checkout('first-standard');
    await db.prisma.$transaction((tx) => activateAcceptedSeatUsage(tx, row, now));
    expect((await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } })).usageTermEventId).toBeNull();
    await db.prisma.$transaction((tx) => activateAcceptedSeatUsage(tx, row, now, {
      serviceId: smsIds.service, orgId: row.orgId, checkedThroughMonth: utcBillingMonth(now), checkedAt: now, hasMetering: false,
    }));
    const stored = await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.usageTermsEffectiveAt).toEqual(now);
    async function effective(at: Date) { return resolveBillingTariffForMonth(db.prisma, { serviceId: smsIds.service,
      organisationId: row.orgId, teamId: team.id, billingMonth: utcBillingMonth(now), at }); }
    expect((await effective(new Date(now.getTime() - 1))).tariff.id).toBe(defaultId);
    expect((await effective(now)).tariff.id).toBe(standardId);
    await db.prisma.$transaction((tx) => activateAcceptedSeatUsage(tx, row, new Date(now.getTime() + 60_000)));
    expect((await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } })).usageTermEventId).toBe(stored.usageTermEventId);
    await expect(db.prisma.billingStripeCheckoutSession.update({ where: { id: row.id },
      data: { usageTermsEffectiveAt: new Date(now.getTime() + 60_000) } })).rejects.toThrow();
  });
  it('keeps previously accepted company terms through the current month', async () => {
    const { row, team } = await checkout('existing-standard');
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId: smsIds.service, source: 'ORGANISATION', scopeKey: row.orgId,
      effectiveFromMonth: utcBillingMonth(now), tariffId: defaultId, reason: 'Synthetic previous acceptance' } });
    await db.prisma.$transaction((tx) => activateAcceptedSeatUsage(tx, row, now));
    const stored = await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.usageTermsEffectiveAt?.toISOString()).toBe(`${nextUtcBillingMonth(now)}-01T00:00:00.000Z`);
    expect((await resolveBillingTariffForMonth(db.prisma, { serviceId: smsIds.service, organisationId: row.orgId,
      teamId: team.id, billingMonth: utcBillingMonth(now), at: now })).tariff.id).toBe(defaultId);
    expect((await resolveBillingTariffForMonth(db.prisma, { serviceId: smsIds.service, organisationId: row.orgId,
      teamId: team.id, billingMonth: nextUtcBillingMonth(now) })).tariff.id).toBe(standardId);
  });
  it('rejects public private tariffs and immutable offer or consent rebinding', async () => {
    const privateTariff = await db.prisma.billingTariff.create({ data: { serviceId: smsIds.service, key: 'private', version: 1,
      name: 'Private', mode: 'AT_COST', collectionMode: 'MANUAL', usagePaymentMode: 'PREPAID', markupBps: 0,
      currency: 'USD', usageCurrency: 'USD' } });
    await expect(db.prisma.billingSeatOffer.create({ data: { serviceId: smsIds.service, tariffId: privateTariff.id,
      publishedByEmail: 'operator@example.test' } })).rejects.toThrow();
    const { row } = await checkout('bound-standard');
    await expect(db.prisma.billingStripeCheckoutSession.update({ where: { id: row.id }, data: { seatOfferId: null } })).rejects.toThrow();
    await expect(db.prisma.billingSeatOffer.update({ where: { id: offerId }, data: { tariffId: privateTariff.id } })).rejects.toThrow();
  });
  it('resumes exact first source proof after an outage and verifies a signed company zero receipt set', async () => {
    const { row } = await checkout('proof-standard');
    await db.prisma.billingStripeSubscription.create({ data: { accountId: smsIds.account, checkoutId: row.id, customerId: row.customerId,
      serviceId: smsIds.service, tariffId: standardId, tariffSource: 'ORGANISATION', orgId: row.orgId,
      scope: 'ORGANISATION', scopeKey: row.orgId, stripeSubscriptionId: 'sub_proof', stripeUsageItemId: 'si_proof', status: 'active', livemode: false } });
    const outageAt = new Date(); let attempts = 0;
    await recoverAcceptedSeatUsage(db.prisma, { now: () => outageAt,
      fetchMetering: async () => { attempts += 1; throw new Error('Synthetic source outage'); },
      fetchProof: async () => { throw new Error('Synthetic source outage'); } });
    expect(attempts).toBe(1);
    expect((await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } })).usageTermEventId).toBeNull();
    const pair = await generateKeyPair('RS256', { extractable: true });
    const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'first-proof', alg: 'RS256', use: 'sig' }] });
    const checkedAt = new Date(outageAt.getTime() + 70_000);
    const digest = (kind: string) => createHash('sha256').update(`ledger-budget-receipt-set-v1:${kind}\n`).digest('hex');
    const proof = { contract: 'ledger-budget-receipt-set-v1', scope: { billing_product: 'nessie', organization_id: row.orgId,
      team_id: null, billing_month: utcBillingMonth(checkedAt), budget_scope_type: 'organization' },
    snapshot: { cursor: `mpr_${'a'.repeat(32)}`, captured_at: checkedAt.toISOString(), immutable: true },
    paid_receipt_count: '0', paid_receipt_sha256: digest('paid'), zero_incremental_count: '0', zero_incremental_sha256: digest('zero'),
    pending_dispatch_count: '0', pending_dispatch_sha256: digest('pending'), unresolved_paid_attempts: '0' };
    const signature = await new CompactSign(Buffer.from(JSON.stringify(proof))).setProtectedHeader({ alg: 'RS256', typ: 'ledger-budget-receipt-set+jws', kid: 'first-proof' }).sign(pair.privateKey);
    await recoverAcceptedSeatUsage(db.prisma, { now: () => checkedAt,
      fetchProof: async (scope) => fetchVerifiedLedgerBudgetReceiptSet(scope, { keys, fetchRaw: async () => ({ ...proof, signature }) }),
      fetchMetering: async (scope) => ({ schemaVersion: 1, product: 'nessie', groupBy: 'service', calls: '0', lines: [],
        billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        scope: { organizationId: scope.organisationId, teamId: null, userId: null, month: scope.billingMonth,
          startsAt: `${scope.billingMonth}-01T00:00:00.000Z`, endsAt: `${nextUtcBillingMonth(checkedAt)}-01T00:00:00.000Z` },
        snapshot: { id: 'snapshot', cursor: 'snapshot', capturedAt: checkedAt.toISOString(), immutable: true, sha256: 'b'.repeat(64) } }),
    });
    const stored = await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.usageTermsEffectiveAt).toEqual(checkedAt); expect(stored.usageTermEventId).not.toBeNull();
    expect(stored.usageProbeEvidence).toEqual([expect.objectContaining({ month: utcBillingMonth(checkedAt), has_metering: false,
      signed_receipt_set: expect.objectContaining({ signature }) })]);
  });
});
