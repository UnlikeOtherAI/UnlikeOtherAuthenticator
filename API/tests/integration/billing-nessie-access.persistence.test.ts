import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { nessieBillingAccess } from '../../src/services/billing-nessie-access.service.js';
import { assertNessieSeatUsage } from '../../src/services/billing-nessie-seat-access.service.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { ids, prisma, setupPersistenceSuite, enabled } from './billing-prepaid-reservation.suite-fixture.js';

// The credential boundary has separate HTTP tests. All financial reads, cohort
// creation, roster locks and transaction conflicts here use migrated PostgreSQL.
vi.mock('../../src/services/billing-organisation-authority.service.js', () => ({
  authorizeOrganisationBilling: async () => ({ billingManager: false }),
}));
const request = { product: 'nessie', organisationId: ids.org, teamId: ids.team, userId: ids.user };
const context = { request, credential: { service: { id: ids.service } } };
async function guardVersion() {
  const [row] = await prisma.$queryRaw<Array<{ version: bigint }>>`
    SELECT billing_seat_guard_version AS version FROM organisations WHERE id=${ids.org}`;
  return row!.version;
}

describe.skipIf(!enabled)('Nessie access snapshot contention', () => {
  setupPersistenceSuite('nessie');
  beforeAll(async () => {
    const tariff = await createBillingTariffVersion({ serviceId: ids.service,
      actor: { email: 'operator@example.test' }, setAsDefault: true, tariff: {
        key: 'standard-usd', name: 'Regular', mode: 'standard', collectionMode: 'stripe',
        monthlyAmountMinor: '399', monthlyChargeBasis: 'per_seat', currency: 'USD',
        seatPolicy: 'automatic', seatChargeTiming: 'prorated', usagePaymentMode: 'prepaid',
      } }, { prisma });
    await prisma.billingTariffTermEvent.create({ data: { serviceId: ids.service, source: 'SERVICE_DEFAULT',
      scopeKey: ids.service, effectiveFromMonth: new Date().toISOString().slice(0, 7),
      tariffId: tariff.id, reason: 'Current regular terms for contention regression' } });
    await prisma.billingAppKey.create({ data: { serviceId: ids.service, purpose: 'CUSTOMER_LIFECYCLE',
      name: 'Contention fixture', keyPrefix: 'contention', secretDigest: 'contention-fixture',
      actorIssuer: 'https://prepaid.example.com', actorAudience: 'https://identity.example',
      actorKeyId: 'fixture', actorPublicJwk: {}, checkoutReturnOrigins: ['https://prepaid.example.com'] } });
  });

  it('recovers an actual 40001 on first creation using a fresh whole snapshot', async () => {
    expect(await prisma.billingNessieSeatTransition.findUnique({ where: { orgId: ids.org } })).toBeNull();
    let attempts = 0, snapshots = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const failures: unknown[] = [];
    const concurrent = new Proxy(prisma, { get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property);
      return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel }) => {
        const firstPair = ++attempts <= 2;
        try {
          return await target.$transaction(async tx => {
            if (firstPair) {
              // Both transactions pin the same pre-creation snapshot, so the
              // losing roster update must produce a real serialization error.
              await tx.billingNessieSeatTransition.findUnique({ where: { orgId: ids.org } });
              if (++snapshots === 2) release();
              await ready;
            }
            return work(tx);
          }, options);
        } catch (error) { failures.push(error); throw error; }
      };
    } }) as PrismaClient;
    const values = await Promise.all([0, 1].map(() => nessieBillingAccess(context as never, { prisma: concurrent })));
    expect(failures).toEqual([expect.objectContaining({ code: 'P2010', meta: expect.objectContaining({ code: '40001' }) })]);
    expect(attempts).toBe(3);
    expect(values[0]).toMatchObject({ access: { allowed: true, status: 'transition' } });
    expect(values[1]!.access).toEqual(values[0]!.access);
    expect(await prisma.billingNessieSeatTransition.count({ where: { orgId: ids.org } })).toBe(1);
  });

  it('serves concurrent established access reads without writing the roster or extending the cohort', async () => {
    const before = await guardVersion();
    const cohort = await prisma.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: ids.org } });
    const values = await Promise.all(Array.from({ length: 12 }, () => nessieBillingAccess(context as never, { prisma })));
    for (const value of values) expect(value.access).toEqual({ allowed: true, status: 'transition', deadline: cohort.endsAt.toISOString() });
    expect(await guardVersion()).toBe(before);
    expect(await prisma.billingNessieSeatTransition.findUnique({ where: { orgId: ids.org } })).toEqual(cohort);
    expect(cohort.endsAt.getTime() - cohort.startsAt.getTime()).toBe(336 * 3600_000);
    expect((await nessieBillingAccess(context as never, { prisma, now: cohort.endsAt })).access.allowed).toBe(false);
    expect((await nessieBillingAccess({ ...context, request: { ...request, userId: 'outside-cohort' } } as never,
      { prisma })).access.allowed).toBe(false);
  });

  it('keeps the roster write fence for paid dispatch admission', async () => {
    const before = await guardVersion();
    await prisma.$transaction(tx => assertNessieSeatUsage(tx, { ...request, serviceId: ids.service }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(await guardVersion()).toBeGreaterThan(before);
  });
});
