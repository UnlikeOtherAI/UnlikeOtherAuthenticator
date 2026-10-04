import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { activateBillingContractVersion } from '../../src/services/billing-contract.service.js';
import { quoteSubscriptionMonthlyCharge } from '../../src/services/billing-monthly-subscription-quote.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

function followingMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString().slice(0, 7);
}

describe.skipIf(!process.env.DATABASE_URL)('manual per-seat source activation', () => {
  let db: TestDb;
  let contractId: string;
  let versionId: string;
  let automaticServiceId: string;
  let fixedServiceId: string;
  const month = followingMonth(new Date());

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const user = await db.prisma.user.create({ data: {
      email: 'monthly-seat-owner@example.test', userKey: 'monthly-seat-owner@example.test',
    } });
    const org = await db.prisma.organisation.create({ data: {
      ownerId: user.id, name: 'Monthly Seats', slug: 'monthly-seats', domain: 'example.test',
    } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    const automaticService = await db.prisma.billingService.create({ data: {
      identifier: 'monthly-seat-automatic', name: 'Automatic seats',
    } });
    const fixedService = await db.prisma.billingService.create({ data: {
      identifier: 'monthly-seat-fixed', name: 'Fixed seats',
    } });
    automaticServiceId = automaticService.id;
    fixedServiceId = fixedService.id;
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      orgId: org.id, reference: 'monthly-seat-agreement', name: 'Monthly seats',
    } });
    contractId = contract.id;
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId, version: 1, usageMarkupBps: 3000, currency: 'USD',
      paymentTermsDays: 30, effectiveFromMonth: month,
    } });
    versionId = version.id;
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  it('captures roster now, freezes future commercial terms, and holds unclosed liability', async () => {
    const services = [
        { serviceId: automaticServiceId, monthlyAmountMinor: '290',
          monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic',
          seatChargeTiming: 'prorated', usagePaymentMode: 'prepaid' },
        { serviceId: fixedServiceId, monthlyAmountMinor: '1000',
          monthlyChargeBasis: 'per_seat', seatPolicy: 'fixed',
          seatChargeTiming: 'full_month', fixedSeatQuantity: 2 },
      ] as const;
    const activate = (fixedSeatQuantity = 2) => activateBillingContractVersion({
      contractId, contractVersionId: versionId,
      services: [{ ...services[0] }, { ...services[1], fixedSeatQuantity }],
      actor: { email: 'admin@example.test' },
    }, { prisma: db.prisma });
    await activate();
    await activate();
    await expect(activate(3)).rejects.toThrow('BILLING_CONTRACT_VERSION_ACTIVE');
    const terms = await db.prisma.billingContractServiceTerm.findMany({
      where: { contractVersionId: versionId }, include: { seatSubscription: true, tariff: true },
    });
    expect(terms).toHaveLength(2);
    const automatic = terms.find((item) => item.serviceId === automaticServiceId);
    const fixed = terms.find((item) => item.serviceId === fixedServiceId);
    expect(automatic?.seatSubscription?.baselineMemberCount).toBe(1);
    expect(automatic?.tariff.usagePaymentMode).toBe('PREPAID');
    expect(fixed?.fixedSeatQuantity).toBe(2);
    expect(fixed?.seatSubscription?.baselineMemberCount).toBe(1);
    const revision = await db.prisma.billingFixedSeatCapacityRevision.findFirst({
      where: { seatSubscriptionId: fixed!.seatSubscription!.id },
    });
    expect(revision).toMatchObject({ quantity: 2,
      effectiveAt: fixed!.seatSubscription!.activatedAt });
    expect(automatic!.seatSubscription!.commercialEffectiveAt.toISOString().slice(0, 7))
      .toBe(month);
    await expect(quoteSubscriptionMonthlyCharge({ source: {
      kind: 'manual', id: automatic!.id }, billingMonth: month }, { prisma: db.prisma }))
      .rejects.toThrow('BILLING_MONTH_NOT_CLOSED');
  });
});
