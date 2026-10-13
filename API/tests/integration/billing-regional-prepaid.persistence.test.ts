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
import { syncStripeSeatActivation } from '../../src/services/billing-stripe-seat-activation.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const secret = `uoa_ledger_${'r'.repeat(43)}`;
const startsAt = new Date('2026-09-01T00:00:00Z'), endsAt = new Date('2026-10-01T00:00:00Z');
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
    const service = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Nessie', tariffHistoryFromMonth: '2026-09' } });
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
  async function customer(currency: string, amount: bigint) {
    const user = await db.prisma.user.create({ data: { email: `${currency}@example.test`, userKey: `${currency}@example.test` } });
    const org = await db.prisma.organisation.create({ data: { ownerId: user.id, domain: `${currency.toLowerCase()}.example.test`,
      name: `Regional ${currency}`, slug: `regional-${currency.toLowerCase()}` } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'admin' } });
    await db.prisma.billingOrgResponsibility.create({ data: { orgId: org.id, assumedAt: startsAt, assumedByUserId: user.id } });
    const tariff = await db.prisma.billingTariff.create({ data: { serviceId, key: `standard-${currency.toLowerCase()}`, version: 2,
      name: 'Standard', mode: 'STANDARD', collectionMode: 'STRIPE', usagePaymentMode: 'PREPAID',
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED',
      monthlyAmountMinor: amount, currency, usageCurrency: 'USD', markupBps: 3000 } });
    const assignment = await db.prisma.billingTariffAssignment.create({ data: { serviceId, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id, tariffId: tariff.id } });
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId, source: 'ORGANISATION', scopeKey: org.id,
      effectiveFromMonth: '2026-09', tariffId: tariff.id, assignmentId: assignment.id, reason: 'Synthetic accepted regional terms' } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: { accountId, orgId: org.id, teamId: null,
      scope: 'ORGANISATION', scopeKey: org.id, stripeCustomerId: `cus_${currency}` } });
    const credit = await db.prisma.billingCreditAccount.create({ data: { accountId, customerId: customer.id, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id, currency: 'USD' } });
    // Synthetic funded opening evidence, using the existing finance fixture convention.
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`UPDATE billing_credit_accounts SET balance_microcredits=100000000 WHERE id=${credit.id}`);
    });
    const checkout = await db.prisma.billingStripeCheckoutSession.create({ data: { accountId, appKeyId, customerId: customer.id,
      serviceId, tariffId: tariff.id, tariffSource: 'ORGANISATION', tariffAssignmentId: assignment.id,
      orgId: org.id, teamId: null, scope: 'ORGANISATION', scopeKey: org.id,
      actorJti: `accept-${currency}`, requestedByUserId: user.id, successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: endsAt } });
    const subscription = await db.prisma.billingStripeSubscription.create({ data: { accountId, checkoutId: checkout.id,
      customerId: customer.id, serviceId, tariffId: tariff.id, tariffSource: 'ORGANISATION', tariffAssignmentId: assignment.id, orgId: org.id,
      teamId: null, scope: 'ORGANISATION', scopeKey: org.id, stripeSubscriptionId: `sub_${currency}`,
      stripeUsageItemId: `si_${currency}`, status: 'active', livemode: false, currentPeriodStart: startsAt, currentPeriodEnd: endsAt } });
    await db.prisma.$transaction((tx) => syncStripeSeatActivation(tx, { row: subscription, tariff, checkoutFixedSeatQuantity: null,
      subscription: { status: 'active' } as Stripe.Subscription, observedAt: startsAt }));
    return { user, org, team, tariff, customer, credit, subscription };
  }
  it.each([['EUR', 299n], ['GBP', 299n], ['USD', 399n]] as const)('keeps %s seats separate through admission, receipt, cycle and monthly invoice item', async (currency, amount) => {
    const rows = await customer(currency, amount);
    const issued = Math.floor(Date.now() / 1000);
    const delegation = await new SignJWT({ tv: 0, email: rows.user.email, source_domain: 'nessie.example.test', azp: 'nessie.example.test',
      product: 'nessie', scope: 'ai.invoke', active: { orgId: rows.org.id, teamId: rows.team.id },
      org: { org_id: rows.org.id, org_role: 'owner', teams: [rows.team.id], team_roles: { [rows.team.id]: 'admin' } } })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'regional-key' }).setIssuer(issuer).setAudience('https://ledger.example.com')
      .setSubject(rows.user.id).setJti(`dispatch-${currency}`).setIssuedAt(issued).setExpirationTime(issued + 45).sign(signing);
    const dispatchId = `dispatch-${currency}`, receiptId = `receipt-${currency}`;
    const input = { dispatchId, requestFingerprint: 'b'.repeat(64), dispatchStartedAt: '2026-09-10T12:00:00.000Z',
      product: 'nessie', providerServiceId: 'openai', organisationId: rows.org.id, teamId: rows.team.id,
      userId: rows.user.id, rawCostBound: '0.01', currency: 'USD' };
    await reservePrepaidDispatch({ runtimeSecret: secret, delegation, input }, { prisma: db.prisma });
    const paid = await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId, receiptId,
      kind: 'settle', rawCostActual: '0.01', currency: 'USD' }, { prisma: db.prisma });
    expect(paid.debited_microcredits).toBe('13000000');
    const proofBody = { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: 'nessie', organization_id: rows.org.id, team_id: rows.team.id, billing_month: '2026-09' },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`, captured_at: new Date().toISOString(), immutable: true as const },
      paid_receipt_count: '1', paid_receipt_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n')
        .update(JSON.stringify([dispatchId, receiptId, '0.010000000000000000'])).update('\n').digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256').update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0' };
    const signature = await new CompactSign(Buffer.from(JSON.stringify(proofBody)))
      .setProtectedHeader({ alg: 'RS256', typ: 'ledger-paid-receipt-set+jws', kid: 'regional-key' }).sign(signing);
    const scope = { product: 'nessie', organisationId: rows.org.id, teamId: rows.team.id, billingMonth: '2026-09', serviceId };
    const proof = await verifyLedgerPaidReceiptSet({ ...proofBody, signature }, scope, publicKey);
    const metering = { schemaVersion: 1, product: 'nessie', groupBy: 'user', calls: '1',
      scope: { organizationId: rows.org.id, teamId: rows.team.id, userId: null, month: '2026-09', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
      snapshot: { id: 'snapshot', cursor: 'cursor', sha256: 'a'.repeat(64), capturedAt: new Date().toISOString(), immutable: true },
      lines: [{ serviceId: 'openai', usageUnit: 'tokens', calls: '1', inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
        estimatedProviderCost: '0.01', actualProviderCost: '0.01', selectedProviderCost: '0.01', currency: 'USD', costProvenance: 'actual',
        billingProduct: 'nessie', callerProduct: 'nessie', originProduct: 'nessie', userId: rows.user.id, billingDisposition: 'paid' }] };
    const now = () => new Date('2026-10-02T00:00:00Z');
    const cycle = await prepareBillingCycleClose({ source: { kind: 'stripe', id: rows.subscription.id }, billingMonth: '2026-09' },
      { prisma: db.prisma, now, fetchMetering: async () => metering as never, fetchPaidReceiptSet: async () => proof,
        discoverTeams: async () => ({ teamIds: [rows.team.id] }) as never });
    expect(cycle).toMatchObject({ amountMinor: amount, currency });
    const snapshot = (await db.prisma.billingCustomerCycle.findUniqueOrThrow({ where: { id: cycle.cycleId } })).publicSnapshot as
      { usage_lines: Array<{ customer_charge: unknown; credits_consumed: string }>; subscription_lines: Array<{ customer_charge: { amount_minor: string; currency: string } }> };
    expect(snapshot.usage_lines[0]).toMatchObject({ customer_charge: null, credits_consumed: '13' });
    expect(snapshot.subscription_lines[0]?.customer_charge).toMatchObject({ amount_minor: amount.toString(), currency });
    const items: Stripe.InvoiceItem[] = [];
    const stripe = { invoiceItems: { list: async () => ({ data: items, has_more: false }),
      create: async (value: Record<string, unknown>) => {
        const item = { id: `ii_${currency}`, livemode: false, ...value } as unknown as Stripe.InvoiceItem; items.push(item); return item;
      } } };
    const collection = { subscriptionId: rows.subscription.id, accountId, invoiceId: `in_${currency}`, customerId: `cus_${currency}`,
      livemode: false, billingMonth: '2026-09', periodStartsAt: startsAt, periodEndsAt: endsAt, currency,
      stripeMonthlyItemId: null, monthlyLineObserved: false, closingCancellation: false };
    await collectStripeMonthlyCharge(collection, { prisma: db.prisma, stripe: stripe as never, now });
    await collectStripeMonthlyCharge(collection, { prisma: db.prisma, stripe: stripe as never, now });
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ amount: Number(amount), currency: currency.toLowerCase() });
    expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: rows.credit.id } })))
      .toMatchObject({ currency: 'USD', balanceMicrocredits: 87_000_000n });
    expect((await db.prisma.billingPrepaidReservation.findUniqueOrThrow({ where: { dispatchId } }))).toMatchObject({ currency: 'USD' });
  });
});
