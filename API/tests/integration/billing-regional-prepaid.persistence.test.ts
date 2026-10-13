import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { reservePrepaidDispatch, finalizePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';
import { verifyLedgerPaidReceiptSet } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { collectStripeMonthlyCharge } from '../../src/services/billing-stripe-monthly-charge.service.js';
import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';
import { quoteSubscriptionMonthlyCharge } from '../../src/services/billing-monthly-subscription-quote.service.js';
import { syncStripeSeatActivation } from '../../src/services/billing-stripe-seat-activation.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const secret = `uoa_ledger_${'r'.repeat(43)}`;
const taskCurrent = new Date();
const startsAt = new Date(Date.UTC(taskCurrent.getUTCFullYear(), taskCurrent.getUTCMonth(), 1));
const endsAt = new Date(Date.UTC(taskCurrent.getUTCFullYear(), taskCurrent.getUTCMonth() + 1, 1));
const month = startsAt.toISOString().slice(0, 7);
const original = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
  STRIPE_BILLING_ENABLED: process.env.STRIPE_BILLING_ENABLED };

describe.skipIf(!process.env.DATABASE_URL)('regional seats and immutable USD prepaid evidence', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let signing: KeyLike;
  let publicKey: ReturnType<typeof createLocalJWKSet>;
  let serviceId: string;
  let accountId: string;
  let appKeyId: string;
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    const pair = await generateKeyPair('RS256', { extractable: true }); signing = pair.privateKey;
    const privateJwk = { ...await exportJWK(pair.privateKey), kid: 'regional-key', alg: 'RS256', use: 'sig' };
    const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'regional-key', alg: 'RS256', use: 'sig' };
    publicKey = createLocalJWKSet({ keys: [publicJwk] });
    process.env.PUBLIC_BASE_URL = issuer;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
    process.env.STRIPE_BILLING_ENABLED = 'false'; resetAccessTokenKeyCache();
    const service = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Nessie', tariffHistoryFromMonth: month } });
    serviceId = service.id;
    const account = await db.prisma.billingStripeAccount.create({ data: { stripeAccountId: 'acct_regional_fixture', livemode: false } });
    accountId = account.id;
    const appKey = await db.prisma.billingAppKey.create({ data: { serviceId, name: 'Regional fixture', keyPrefix: 'regional',
      secretDigest: 'a'.repeat(64), actorIssuer: issuer, actorAudience: issuer, actorKeyId: 'regional-key', actorPublicJwk: publicJwk } });
    appKeyId = appKey.id;
    await db.prisma.billingLedgerRuntimeKey.create({ data: { serviceId, secretDigest: createHash('sha256').update(secret).digest('hex'),
      keyPrefix: 'regional-runtime', ledgerAudience: 'https://ledger.example.com', sourceDomain: 'nessie.example.test',
      createdByEmail: 'operator@example.test' } });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    resetAccessTokenKeyCache(); await db?.cleanup();
  });
  async function customer(currency: string, amount: bigint, suffix = currency, collectionMode: 'STRIPE' | 'NONE' = 'STRIPE', previousUsage = false, teamFunding = false) {
    const user = await db.prisma.user.create({ data: { email: `${suffix}@example.test`, userKey: `${suffix}@example.test` } });
    const org = await db.prisma.organisation.create({ data: { ownerId: user.id, domain: `${suffix.toLowerCase()}.example.test`,
      name: `Regional ${suffix}`, slug: `regional-${suffix.toLowerCase()}` } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'admin' } });
    if (!teamFunding) await db.prisma.billingOrgResponsibility.create({ data: { orgId: org.id, assumedAt: startsAt, assumedByUserId: user.id } });
    const tariff = await db.prisma.billingTariff.create({ data: { serviceId, key: `standard-${suffix.toLowerCase()}`, version: 2,
      name: 'Standard', mode: 'STANDARD', collectionMode, usagePaymentMode: 'PREPAID',
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED',
      monthlyAmountMinor: amount, currency, usageCurrency: 'USD', markupBps: 3000 } });
    const assignment = await db.prisma.billingTariffAssignment.create({ data: { serviceId, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id, tariffId: tariff.id } });
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId, source: 'ORGANISATION', scopeKey: org.id,
      effectiveFromMonth: month, tariffId: tariff.id, assignmentId: assignment.id, reason: 'Synthetic accepted regional terms' } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: { accountId, orgId: org.id, teamId: null,
      scope: 'ORGANISATION', scopeKey: org.id, stripeCustomerId: `cus_${suffix}` } });
    const walletCustomer = teamFunding ? await db.prisma.billingStripeCustomer.create({ data: { accountId, orgId: org.id,
      teamId: team.id, scope: 'TEAM', scopeKey: `${org.id}:${team.id}`, stripeCustomerId: `cus_wallet_${suffix}` } }) : customer;
    const credit = await db.prisma.billingCreditAccount.create({ data: { accountId, customerId: walletCustomer.id, orgId: org.id,
      teamId: teamFunding ? team.id : null, scope: teamFunding ? 'TEAM' : 'ORGANISATION',
      scopeKey: teamFunding ? `${org.id}:${team.id}` : org.id, currency: 'USD' } });
    // Synthetic funded opening evidence, using the existing finance fixture convention.
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`UPDATE billing_credit_accounts SET balance_microcredits=100000000 WHERE id=${credit.id}`);
    });
    if (collectionMode === 'NONE') return { user, org, team, tariff, customer, credit, subscription: null };
    if (previousUsage) await db.prisma.billingSeatOffer.updateMany({ where: { serviceId, withdrawnAt: null, tariff: { currency } }, data: { withdrawnAt: new Date() } });
    const offer = previousUsage ? await db.prisma.billingSeatOffer.create({ data: { serviceId, tariffId: tariff.id,
      publishedByEmail: 'operator@example.test' } }) : null;
    if (previousUsage) {
      const old = await db.prisma.billingTariff.create({ data: { serviceId, key: `previous-usage-${suffix.toLowerCase()}`, version: 1, name: 'Previous agreement',
        mode: 'AT_COST', collectionMode: 'MANUAL', usagePaymentMode: 'PREPAID', currency: 'USD', usageCurrency: 'USD', markupBps: 0 } });
      await db.prisma.billingTariffTermEvent.create({ data: { serviceId, source: 'ORGANISATION', scopeKey: org.id,
        effectiveFromMonth: month, tariffId: old.id, reason: 'Synthetic previous independently funded usage' } });
    }
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: { accountId, appKeyId, customerId: customer.id,
      serviceId, tariffId: tariff.id, tariffSource: 'ORGANISATION', tariffAssignmentId: offer ? null : assignment.id,
      ...(offer ? { seatOfferId: offer.id, seatConsentTerms: { terms_version: 'company-standard-seat-v1', accepted: true,
        currency, unit_amount_minor: amount.toString(), usage_currency: 'USD', usage_payment_mode: 'prepaid', usage_markup_bps: 3000,
        checkout_text: 'Synthetic prospective public seat terms' } } : {}),
      orgId: org.id, teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      actorJti: `accept-${suffix}`, requestedByUserId: user.id, successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: endsAt } });
    const subscription = await db.prisma.billingStripeSubscription.create({ data: { accountId, checkoutId: checkout.id,
      customerId: customer.id, serviceId, tariffId: tariff.id, tariffSource: 'ORGANISATION', tariffAssignmentId: offer ? null : assignment.id, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id, stripeSubscriptionId: `sub_${suffix}`,
      stripeUsageItemId: `si_${suffix}`, status: 'active', livemode: false, currentPeriodStart: startsAt, currentPeriodEnd: endsAt } });
    await db.prisma.$transaction(async (tx) => syncStripeSeatActivation(tx, { row: subscription, tariff, checkoutFixedSeatQuantity: null,
      subscription: { status: 'active' } as Stripe.Subscription, observedAt: await observedBillingTime(tx) }));
    return { user, org, team, tariff, customer, credit, subscription };
  }
  async function delegation(rows: Awaited<ReturnType<typeof customer>>, dispatchId: string) {
    const issued = Math.floor(Date.now() / 1000);
    return new SignJWT({ tv: 0, email: rows.user.email, source_domain: 'nessie.example.test', azp: 'nessie.example.test',
      product: 'nessie', scope: 'ai.invoke', active: { orgId: rows.org.id, teamId: rows.team.id },
      org: { org_id: rows.org.id, org_role: 'owner', teams: [rows.team.id], team_roles: { [rows.team.id]: 'admin' } } })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'regional-key' }).setIssuer(issuer).setAudience('https://ledger.example.com')
      .setSubject(rows.user.id).setJti(dispatchId).setIssuedAt(issued).setExpirationTime(issued + 45).sign(signing);
  }
  it.each([['EUR', 299n, false, false], ['GBP', 299n, false, false], ['USD', 399n, false, false],
    ['EUR', 299n, true, false], ['EUR', 299n, true, true]] as const)
  ('keeps %s %s seats separate (previous usage=%s, team funding=%s)', async (currency, amount, previousUsage, teamFunding) => {
    const suffix = `${currency}${previousUsage ? '-previous' : ''}${teamFunding ? '-team' : ''}`;
    const rows = await customer(currency, amount, suffix, 'STRIPE', previousUsage, teamFunding);
    if (!rows.subscription) throw new Error('FIXTURE_SEAT_ACCEPTANCE_REQUIRED');
    const dispatchId = `dispatch-${suffix}`, receiptId = `receipt-${suffix}`;
    const input = { dispatchId, requestFingerprint: 'b'.repeat(64), dispatchStartedAt: new Date().toISOString(),
      product: 'nessie', providerServiceId: 'openai', organisationId: rows.org.id, teamId: rows.team.id,
      userId: rows.user.id, rawCostBound: '0.01', currency: 'USD' };
    await reservePrepaidDispatch({ runtimeSecret: secret, delegation: await delegation(rows, dispatchId), input }, { prisma: db.prisma });
    const paid = await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId, receiptId,
      kind: 'settle', rawCostActual: '0.01', currency: 'USD' }, { prisma: db.prisma });
    expect(paid.debited_microcredits).toBe(previousUsage ? '10000000' : '13000000');
    const proofBody = { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: 'nessie', organization_id: rows.org.id, team_id: rows.team.id, billing_month: month },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`, captured_at: new Date().toISOString(), immutable: true as const },
      paid_receipt_count: '1', paid_receipt_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n')
        .update(JSON.stringify([dispatchId, receiptId, '0.010000000000000000'])).update('\n').digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0' };
    const signature = await new CompactSign(Buffer.from(JSON.stringify(proofBody)))
      .setProtectedHeader({ alg: 'RS256', typ: 'ledger-paid-receipt-set+jws', kid: 'regional-key' }).sign(signing);
    const scope = { product: 'nessie', organisationId: rows.org.id, teamId: rows.team.id, billingMonth: month, serviceId };
    const proof = await verifyLedgerPaidReceiptSet({ ...proofBody, signature }, scope, publicKey);
    const metering = { schemaVersion: 1, product: 'nessie', groupBy: 'user', calls: '1',
      scope: { organizationId: rows.org.id, teamId: rows.team.id, userId: null, month: month, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: 'snapshot', cursor: 'cursor', sha256: 'a'.repeat(64), capturedAt: new Date().toISOString(), immutable: true },
      lines: [{ serviceId: 'openai', usageUnit: 'tokens', calls: '1', inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
        estimatedProviderCost: '0.01', actualProviderCost: '0.01', selectedProviderCost: '0.01', currency: 'USD', costProvenance: 'actual',
        billingProduct: 'nessie', callerProduct: 'nessie', originProduct: 'nessie', userId: rows.user.id, billingDisposition: 'paid' }] };
    const now = () => new Date(endsAt.getTime() + 86_400_000);
    const cycle = await prepareBillingCycleClose({ source: { kind: 'stripe', id: rows.subscription.id }, billingMonth: month },
      { prisma: db.prisma, now, fetchMetering: async () => metering as never, fetchPaidReceiptSet: async () => proof,
        discoverTeams: async () => ({ teamIds: [rows.team.id] }) as never });
    const seatQuote = await quoteSubscriptionMonthlyCharge({ source: { kind: 'stripe', id: rows.subscription.id }, billingMonth: month },
      { prisma: db.prisma, now });
    expect(cycle).toMatchObject({ amountMinor: seatQuote.amountMinor, currency });
    expect(seatQuote.unitAmountMinor).toBe(amount); expect(seatQuote.amountMinor).toBeGreaterThan(0n);
    expect(seatQuote.amountMinor).toBeLessThanOrEqual(amount);
    const snapshot = (await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: { id: cycle.cycleId } })).publicSnapshot as
      { usage_lines: Array<{ customer_charge: unknown; credits_consumed: string }>; subscription_lines: Array<{ customer_charge: { amount_minor: string; currency: string } }> };
    expect(snapshot.usage_lines[0]).toMatchObject({ customer_charge: null, credits_consumed: previousUsage ? '10' : '13' });
    expect(snapshot.subscription_lines[0]?.customer_charge).toMatchObject({ amount_minor: seatQuote.amountMinor.toString(), currency });
    const items: Stripe.InvoiceItem[] = [];
    const stripe = { invoiceItems: { list: async () => ({ data: items, has_more: false }),
      create: async (value: Record<string, unknown>) => {
        const item = { id: `ii_${suffix}`, livemode: false, ...value } as unknown as Stripe.InvoiceItem; items.push(item); return item;
      } } };
    const collection = { subscriptionId: rows.subscription.id, accountId, invoiceId: `in_${suffix}`, customerId: `cus_${suffix}`,
      livemode: false, billingMonth: month, periodStartsAt: startsAt, periodEndsAt: endsAt, currency,
      stripeMonthlyItemId: null, monthlyLineObserved: false, closingCancellation: false };
    await collectStripeMonthlyCharge(collection, { prisma: db.prisma, stripe: stripe as never, now });
    await collectStripeMonthlyCharge(collection, { prisma: db.prisma, stripe: stripe as never, now });
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ amount: Number(seatQuote.amountMinor), currency: currency.toLowerCase() });
    expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: rows.credit.id } })))
      .toMatchObject({ currency: 'USD', balanceMicrocredits: previousUsage ? 90_000_000n : 87_000_000n });
    expect((await db.prisma.billingPrepaidReservation.findUniqueOrThrow({ where: { dispatchId } }))).toMatchObject({ currency: 'USD' });
    if (teamFunding) {
      expect(await db.prisma.billingOrgResponsibility.findUnique({ where: { orgId: rows.org.id } })).toBeNull();
      expect(await db.prisma.billingCreditAccount.count({ where: { orgId: rows.org.id, scope: 'ORGANISATION' } })).toBe(0);
    }
  });
  it('does not turn a company trial and unrelated funded wallet into accepted paid-provider terms', async () => {
    const rows = await customer('USD', 399n, 'uncollected-trial', 'NONE');
    await db.prisma.clientDomain.create({ data: { domain: 'nessie.example.test', label: 'Synthetic Nessie' } });
    const enrollment = await db.prisma.billingProductEnrollment.create({ data: { serviceId, orgId: rows.org.id,
      sourceDomain: 'nessie.example.test' } });
    const now = new Date();
    await db.prisma.billingProductPolicyRevision.create({ data: { enrollmentId: enrollment.id, privateAtCost: false,
      trialStartsAt: now, trialEndsAt: new Date(now.getTime() + 30 * 86_400_000), effectiveAt: now, actorUserId: rows.user.id } });
    const dispatchId = 'trial-uncollected-dispatch';
    await expect(reservePrepaidDispatch({ runtimeSecret: secret, delegation: await delegation(rows, dispatchId), input: {
      dispatchId, requestFingerprint: 'c'.repeat(64), dispatchStartedAt: new Date().toISOString(), product: 'nessie', providerServiceId: 'openai',
      organisationId: rows.org.id, teamId: rows.team.id, userId: rows.user.id, rawCostBound: '0.01', currency: 'USD',
    } }, { prisma: db.prisma })).rejects.toThrow('BILLING_PRODUCT_USAGE_FUNDING_NOT_ACCEPTED');
    expect(await db.prisma.billingLedgerDispatchDecision.findUnique({ where: { dispatchId } })).toBeNull();
    expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: rows.credit.id } })).balanceMicrocredits).toBe(100_000_000n);
  });
});
