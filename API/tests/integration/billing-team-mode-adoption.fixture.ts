import { Prisma, type PrismaClient } from '@prisma/client';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { fundingRaceIds as ids, seedFundingRace } from './billing-credit-funding-actions.persistence.fixture.js';
export { ids };
export const physicalAccount = 'acct_1Sn2VfGY1l8e0vu2';
export const subject = { organisationId: ids.org, teamId: ids.team };
export const actor = { userId: ids.user, email: 'funding-race@example.com', tokenVersion: 0 };

export async function seedAdoption(db: PrismaClient) {
  await seedFundingRace(db);
  // Construct the pre-policy fixture; never rewrite financial rows during adoption.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.billingTeamMode.deleteMany();
    await tx.billingStripeAccount.update({ where: { id: ids.account }, data: { stripeAccountId: physicalAccount } });
    await tx.billingCreditAccount.update({ where: { id: ids.creditAccount }, data: { balanceMicrocredits: 3_000_000_000n } });
  });
  await db.domainRole.create({ data: { userId: ids.user, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
  // Global LIVE configuration and dormant customer/wallet are not financial history.
  await db.billingStripeAccount.create({ data: { id: 'adoption-live', stripeAccountId: physicalAccount, livemode: true } });
  await db.billingStripeCustomer.create({ data: { id: 'adoption-live-customer', accountId: 'adoption-live',
    orgId: ids.org, teamId: ids.team, scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`, stripeCustomerId: 'cus_live_empty' } });
  await db.billingCreditAccount.create({ data: { id: 'adoption-live-wallet', accountId: 'adoption-live',
    customerId: 'adoption-live-customer', orgId: ids.org, teamId: ids.team, scopeKey: `${ids.org}:${ids.team}` } });
  await db.billingCreditTopUpCatalog.create({ data: { id: 'adoption-live-catalog', accountId: 'adoption-live',
    key: 'funding-race', version: 1, currency: 'USD', paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n,
    stripeLookupKey: 'live-race', stripeProductId: 'prod_live', stripePriceId: 'price_live' } });
}

export function liveCapture(tx: Prisma.TransactionClient) {
  return tx.billingCreditTopUpCheckout.create({ data: { id: 'adoption-live-capture', accountId: 'adoption-live',
    creditAccountId: 'adoption-live-wallet', customerId: 'adoption-live-customer', catalogId: 'adoption-live-catalog',
    serviceId: ids.service, appKeyId: ids.appKey, offerId: ids.offer, actorJti: 'live-capture', requestedByUserId: ids.user,
    billingModeTeamId: ids.team, billingModeRevision: 0, paymentAmountMinor: 500n,
    creditsReceivedMicrocredits: 5_000_000_000n, currency: 'USD', successUrlDigest: 'a'.repeat(64),
    cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date(Date.now() + 60_000) } });
}

export async function financialSnapshot(db: PrismaClient) {
  return { wallets: await db.billingCreditAccount.findMany({ orderBy: { id: 'asc' } }),
    customers: await db.billingStripeCustomer.findMany({ orderBy: { id: 'asc' } }),
    consents: await db.billingCreditAutoTopUpConsentRevision.findMany(),
    setups: await db.billingCreditSetupCheckout.findMany(),
    events: await db.billingStripeWebhookEvent.findMany(), entries: await db.billingCreditEntry.findMany() };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function createSettlement(db: Prisma.TransactionClient, month: string, accountId = 'adoption-live',
  creditAccountId = 'adoption-live-wallet', teamId: string | null = ids.team) {
  const tariff = await db.billingTariff.upsert({ where: { id: 'mode-period-tariff' },
    update: {}, create: { id: 'mode-period-tariff', serviceId: ids.service, key: 'period', version: 1,
      name: 'Period tariff', mode: 'STANDARD', collectionMode: 'STRIPE', usagePaymentMode: 'PAY_AS_YOU_GO', markupBps: 3000, currency: 'USD' } });
  return db.billingCreditUsageSettlement.create({ data: { accountId, creditAccountId, teamId,
    tariffId: tariff.id, serviceId: ids.service, appKeyId: ids.appKey, billingMonth: month } });
}

export async function createGrantNumber(db: PrismaClient) {
  const createdAt = new Date(Date.now() - 120_000);
  const expiresAt = new Date(Date.now() - 60_000);
  const fx = await db.billingSmsFxSnapshot.create({ data: { policy: 'ECB_REFERENCE_USD_PER_EUR_V1', source: 'https://www.ecb.europa.eu',
    sourceDigest: 'a'.repeat(64), rateDate: createdAt, observedAt: createdAt, acceptedAt: createdAt,
    expiresAt: new Date(Date.now() + 60_000), usdPerEur: '1.1', acceptedByUserId: ids.user, acceptanceReason: 'Synthetic grant fixture' } });
  const quote = await db.billingSmsQuote.create({ data: { serviceId: ids.service, appKeyId: ids.appKey, orgId: ids.org,
    commercialPolicyVersion: 'synthetic', monthlyFeeEur: '7.25', messageMarkupBps: 2700, country: 'CZ', direction: 'inbound',
    providerAmount: '0.01', providerCurrency: 'USD', providerSource: 'https://pricing.twilio.com', providerObservedAt: createdAt,
    fxSnapshotId: fx.id, finalAmount: '0.02', finalCurrency: 'USD', rateBasis: 'inbound_mobile', createdAt, expiresAt } });
  return db.billingSmsNumberResource.create({ data: { id: 'grant-number', serviceId: ids.service, appKeyId: ids.appKey,
    orgId: ids.org, quoteId: quote.id, phoneNumber: '+420777000001', country: 'CZ', state: 'active',
    accountSid: `AC${'a'.repeat(32)}`, phoneNumberSid: `PN${'a'.repeat(32)}` } });
}
