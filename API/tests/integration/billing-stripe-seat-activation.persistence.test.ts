import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('Stripe per-seat activation projection', () => {
  let db: TestDb;
  let accountId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const user = await db.prisma.user.create({ data: {
      email: 'stripe-seat-owner@example.test', userKey: 'stripe-seat-owner@example.test',
    } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, name: 'Stripe Seats', slug: 'stripe-seats', domain: 'example.test',
    } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: 'stripe-seat-plan', name: 'Stripe seats',
    } });
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'stripe-seat-plan', version: 1,
      name: 'Stripe seats', mode: 'STANDARD', collectionMode: 'STRIPE',
      markupBps: 3000, currency: 'USD', monthlyAmountMinor: 299n,
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'FIXED',
      seatChargeTiming: 'PRORATED',
    } });
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId: service.id, name: 'Seat app key', keyPrefix: 'uoa_stripe_seat',
      secretDigest: 'stripe-seat-digest', actorIssuer: 'https://stripe-seat.example',
      actorAudience: 'https://authentication.unlikeotherai.com',
      actorKeyId: 'stripe-seat-key', actorPublicJwk: {
        kty: 'RSA', kid: 'stripe-seat-key', n: 'AQAB', e: 'AQAB',
      },
    } });
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: 'acct_stripe_seat', livemode: false,
    } });
    accountId = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId, orgId: org.id, teamId: null, scope: 'ORGANISATION',
      scopeKey: org.id, stripeCustomerId: 'cus_stripe_seat',
    } });
    const catalog = await db.prisma.billingStripeCatalog.create({ data: {
      accountId, serviceId: service.id, currency: 'USD',
      meterEventName: 'stripe_seat_usage', stripeProductId: 'prod_stripe_seat',
      stripeMeterId: 'mtr_stripe_seat', stripeUsagePriceId: 'price_stripe_seat_usage',
    } });
    await db.prisma.billingStripeTariffPrice.create({ data: {
      accountId, tariffId: tariff.id, catalogId: catalog.id,
      monthlyAmountMinor: 299n, stripeMonthlyPriceId: null,
    } });
    await db.prisma.billingStripeCheckoutSession.create({ data: {
      id: 'stripe_seat_checkout', accountId, appKeyId: appKey.id,
      customerId: customer.id, serviceId: service.id, tariffId: tariff.id,
      tariffSource: 'SERVICE_DEFAULT', orgId: org.id, teamId: null,
      scope: 'ORGANISATION', scopeKey: org.id, actorJti: 'stripe-seat-jti',
      requestedByUserId: user.id, fixedSeatQuantity: 2,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000), status: 'complete',
      stripeCheckoutSessionId: 'cs_stripe_seat',
    } });
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  function remote(status: 'active' | 'canceled') {
    return { id: 'sub_stripe_seat', customer: 'cus_stripe_seat',
      metadata: { uoa_checkout_id: 'stripe_seat_checkout',
        uoa_service_id: 'stripe-seat-service', uoa_tariff_id: 'stripe-seat-tariff',
        uoa_scope_key: 'stripe-seat-org', uoa_stripe_account_id: 'acct_stripe_seat',
        uoa_stripe_mode: 'test', uoa_fixed_seat_quantity: '2' },
      items: { data: [{ id: 'si_stripe_seat_usage', quantity: 1,
        price: { id: 'price_stripe_seat_usage', recurring: { usage_type: 'metered' } },
        current_period_start: 1_780_272_000, current_period_end: 1_782_950_400,
        discounts: [] }] }, discounts: [], status, livemode: false,
      ended_at: null, cancel_at_period_end: status === 'canceled' };
  }

  it('captures fixed capacity exactly once and closes the observed monthly source', async () => {
    const checkout = await db.prisma.billingStripeCheckoutSession.findUniqueOrThrow({
      where: { id: 'stripe_seat_checkout' },
    });
    const account = { id: accountId, stripeAccountId: 'acct_stripe_seat', livemode: false };
    const active = remote('active');
    active.metadata.uoa_service_id = checkout.serviceId;
    active.metadata.uoa_tariff_id = checkout.tariffId;
    active.metadata.uoa_scope_key = checkout.scopeKey;
    await db.prisma.$transaction((tx) => syncBaseStripeSubscription(
      tx, active as never, account as never,
    ));
    await db.prisma.$transaction((tx) => syncBaseStripeSubscription(
      tx, active as never, account as never,
    ));
    const projected = await db.prisma.billingStripeSubscription.findUniqueOrThrow({
      where: { accountId_stripeSubscriptionId: {
        accountId, stripeSubscriptionId: active.id,
      } }, include: { seatSubscription: { include: { capacityRevisions: true } } },
    });
    subscriptionId = projected.id;
    expect(projected.billableFrom).not.toBeNull();
    expect(projected.seatSubscription?.baselineMemberCount).toBe(1);
    expect(projected.seatSubscription?.capacityRevisions).toHaveLength(1);
    expect(projected.seatSubscription?.capacityRevisions[0]?.quantity).toBe(2);
    await db.prisma.$transaction((tx) => syncBaseStripeSubscription(
      tx, { ...active, status: 'canceled', cancel_at_period_end: true } as never,
      account as never,
    ));
    const ended = await db.prisma.billingStripeSubscription.findUniqueOrThrow({
      where: { id: subscriptionId }, include: { seatSubscription: true },
    });
    expect(ended.billableUntil).not.toBeNull();
    expect(ended.seatSubscription?.endedAt).not.toBeNull();
  });
});
