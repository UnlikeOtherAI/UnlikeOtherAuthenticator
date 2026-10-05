import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('pending Stripe fixed-seat capacity', () => {
  let db: TestDb;
  let ownerId: string;
  let orgId: string;
  let teamId: string;
  let accountId: string;
  let appKeyId: string;
  let customerId: string;
  let serviceId: string;
  let tariffId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: 'checkout-seat-owner@example.test', userKey: 'checkout-seat-owner@example.test',
    } });
    ownerId = owner.id;
    const org = await db.prisma.organisation.create({ data: {
      ownerId, name: 'Pending checkout seats', slug: 'pending-checkout-seats', domain: 'example.test',
    } });
    orgId = org.id;
    await db.prisma.orgMember.create({ data: { orgId, userId: ownerId, role: 'owner' } });
    const team = await db.prisma.team.create({ data: {
      orgId, name: 'Checkout team', slug: 'checkout-team',
    } });
    teamId = team.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: 'pending-checkout-seats', name: 'Pending checkout seats',
    } });
    serviceId = service.id;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'pending-checkout-seats', version: 1, name: 'Fixed seats',
      mode: 'STANDARD', collectionMode: 'STRIPE', markupBps: 3000,
      currency: 'USD', monthlyAmountMinor: 500n, monthlyChargeBasis: 'PER_SEAT',
      seatPolicy: 'FIXED', seatChargeTiming: 'PRORATED',
    } });
    tariffId = tariff.id;
    const appKey = await db.prisma.billingAppKey.create({ data: {
      serviceId, name: 'Checkout app key', keyPrefix: 'uoa_pending_checkout',
      secretDigest: 'pending-checkout-digest', actorIssuer: 'https://checkout-seat.example',
      actorAudience: 'https://authentication.unlikeotherai.com',
      actorKeyId: 'pending-checkout-key', actorPublicJwk: {
        kty: 'RSA', kid: 'pending-checkout-key', n: 'AQAB', e: 'AQAB',
      },
    } });
    appKeyId = appKey.id;
    const account = await db.prisma.billingStripeAccount.create({ data: {
      stripeAccountId: 'acct_pending_checkout_seats', livemode: false,
    } });
    accountId = account.id;
    const customer = await db.prisma.billingStripeCustomer.create({ data: {
      accountId, orgId, teamId: null, scope: 'ORGANISATION',
      scopeKey: orgId, stripeCustomerId: 'cus_pending_checkout_seats',
    } });
    customerId = customer.id;
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  function checkout(id: string, quantity: number) {
    return {
      id, accountId, appKeyId, customerId, serviceId, tariffId,
      tariffSource: 'SERVICE_DEFAULT' as const, orgId, teamId: null,
      scope: 'ORGANISATION' as const, scopeKey: orgId, actorJti: id,
      requestedByUserId: ownerId, fixedSeatQuantity: quantity,
      successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000), status: 'creating',
    };
  }

  it('rejects an under-capacity Checkout before provider egress', async () => {
    const second = await db.prisma.user.create({ data: {
      email: 'checkout-second@example.test', userKey: 'checkout-second@example.test',
    } });
    await db.prisma.orgMember.create({ data: { orgId, userId: second.id } });
    await expect(db.prisma.billingStripeCheckoutSession.create({
      data: checkout('checkout_too_small', 1),
    })).rejects.toThrow('Fixed seat checkout capacity exceeded');
    expect(await db.prisma.billingStripeCheckoutSession.count({
      where: { id: 'checkout_too_small' },
    })).toBe(0);
    await db.prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId: second.id } } });
  });

  it('serializes invitation admission with Checkout and holds unknown outcomes', async () => {
    const second = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => { signal = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = db.prisma.$transaction(async (tx) => {
        await tx.billingStripeCheckoutSession.create({
          data: checkout('checkout_pending_capacity', 1),
        });
        signal();
        await held;
      });
      await inserted;
      let settled = false;
      const competing = second.teamInvite.create({ data: {
        orgId, teamId, email: 'checkout-invite@example.test', lastSentAt: new Date(),
      } }).then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      release();
      await first;
      await competing;
      expect(await db.prisma.teamInvite.count({ where: { orgId } })).toBe(0);
      await db.prisma.billingStripeCheckoutSession.update({
        where: { id: 'checkout_pending_capacity' }, data: { status: 'abandoned' },
      });
      await expect(db.prisma.teamInvite.create({ data: {
        orgId, teamId, email: 'checkout-invite@example.test', lastSentAt: new Date(),
      } })).rejects.toThrow('Fixed seat checkout capacity exceeded');
      await db.prisma.billingStripeCheckoutSession.update({
        where: { id: 'checkout_pending_capacity' }, data: { status: 'expired' },
      });
      await db.prisma.teamInvite.create({ data: {
        orgId, teamId, email: 'checkout-invite@example.test', lastSentAt: new Date(),
      } });
      expect(await db.prisma.teamInvite.count({ where: { orgId } })).toBe(1);
    } finally {
      release();
      await second.$disconnect();
    }
  });
});
