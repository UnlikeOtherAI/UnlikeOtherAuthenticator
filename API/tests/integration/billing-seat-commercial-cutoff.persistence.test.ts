import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('superseded fixed seat capacity', () => {
  let db: TestDb;
  let orgId: string;
  let memberId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: 'old-capacity-owner@example.test',
      userKey: 'old-capacity-owner@example.test',
    } });
    const member = await db.prisma.user.create({ data: {
      email: 'new-capacity-member@example.test',
      userKey: 'new-capacity-member@example.test',
    } });
    memberId = member.id;
    const org = await db.prisma.organisation.create({ data: {
      ownerId: owner.id, name: 'Capacity change', slug: 'capacity-change',
      domain: 'example.test',
    } });
    orgId = org.id;
    await db.prisma.orgMember.create({ data: {
      orgId, userId: owner.id, role: 'owner',
    } });
    const service = await db.prisma.billingService.create({ data: {
      identifier: 'seat-capacity-cutoff', name: 'Capacity cutoff',
    } });
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId: service.id, key: 'fixed-capacity', version: 1,
      name: 'Fixed capacity', mode: 'CUSTOM', collectionMode: 'MANUAL',
      markupBps: 3000, currency: 'USD', monthlyAmountMinor: 1000n,
      monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'FIXED',
      seatChargeTiming: 'PRORATED',
    } });
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId, reference: 'capacity-change', name: 'Capacity change',
    } });
    const versions = await Promise.all([1, 2].map((version) =>
      db.prisma.billingOrganisationContractVersion.create({ data: {
        contractId: contract.id, version, usageMarkupBps: 3000,
        currency: 'USD', paymentTermsDays: 30,
        effectiveFromMonth: version === 1 ? '2026-11' : '2026-12',
      } })));
    const terms = [];
    for (const version of versions) {
      terms.push(await db.prisma.billingContractServiceTerm.create({ data: {
        contractVersionId: version.id, serviceId: service.id,
        tariffId: tariff.id, monthlyAmountMinor: 1000n,
      } }));
    }
    await db.prisma.$transaction(async (tx) => {
      const activatedAt = await observedBillingTime(tx);
      const boundary = new Date(activatedAt.getTime() + 2_000);
      for (const [index, term] of terms.entries()) {
        const agreement = await tx.billingSeatSubscription.create({ data: {
          contractServiceTermId: term.id, serviceId: service.id,
          tariffId: tariff.id, orgId, teamId: null, scope: 'ORGANISATION',
          seatPolicy: 'FIXED', seatChargeTiming: 'PRORATED',
          unitAmountMinor: 1000n, currency: 'USD',
          activatedAt, baselineCapturedAt: activatedAt,
          commercialEffectiveAt: index === 0 ? activatedAt : boundary,
          commercialEndsAt: index === 0 ? boundary : null,
        } });
        await tx.billingFixedSeatCapacityRevision.create({ data: {
          seatSubscriptionId: agreement.id,
          quantity: index === 0 ? 1 : 3, effectiveAt: activatedAt,
        } });
      }
    });
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  it('keeps the old limit until its commercial boundary and then admits under the new capacity', async () => {
    await expect(db.prisma.orgMember.create({ data: { orgId, userId: memberId } }))
      .rejects.toThrow('Fixed seat capacity exceeded');
    const cutoff = await db.prisma.billingSeatSubscription.findFirstOrThrow({
      where: { orgId, commercialEndsAt: { not: null } },
      select: { commercialEndsAt: true, endedAt: true },
    });
    expect(cutoff.endedAt).toBeNull(); // No scheduler sweep has run.
    const remaining = cutoff.commercialEndsAt!.getTime() - Date.now() + 30;
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    await db.prisma.orgMember.create({ data: { orgId, userId: memberId } });
    expect(await db.prisma.orgMember.count({ where: { orgId } })).toBe(2);
  });
});
