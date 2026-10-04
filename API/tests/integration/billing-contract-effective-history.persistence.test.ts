import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { activateBillingContractVersion } from '../../src/services/billing-contract.service.js';
import { resolveBillingTariffForMonth } from '../../src/services/billing-tariff-history.service.js';
import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!process.env.DATABASE_URL)('manual contract effective history', () => {
  let db: TestDb;
  let orgId: string;
  let serviceId: string;
  let contractId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({
      data: { email: 'owner@terms.example', userKey: 'owner@terms.example', name: 'Owner' },
    });
    const org = await db.prisma.organisation.create({
      data: { ownerId: owner.id, name: 'Terms', slug: 'terms', domain: 'terms.example' },
    });
    orgId = org.id;
    const service = await db.prisma.billingService.create({
      data: { identifier: 'future-terms', name: 'Future terms', tariffHistoryFromMonth: '2026-07' },
    });
    serviceId = service.id;
    const base = await db.prisma.billingTariff.create({
      data: { serviceId, key: 'base', version: 1, name: 'Base', mode: 'STANDARD',
        collectionMode: 'NONE', markupBps: 3000, currency: 'USD', isDefault: true },
    });
    await db.prisma.billingTariffTermEvent.create({
      data: { serviceId, source: 'SERVICE_DEFAULT', scopeKey: serviceId,
        effectiveFromMonth: '2026-07', tariffId: base.id, reason: 'created' },
    });
    const contract = await db.prisma.billingOrganisationContract.create({
      data: { orgId, reference: 'future-terms', name: 'Future terms' },
    });
    contractId = contract.id;
  }, 120_000);

  afterAll(async () => { if (db) await db.cleanup(); });

  it('persists a future manual term without moving July and applies later complete versions', async () => {
    const august = await db.prisma.billingOrganisationContractVersion.create({
      data: { contractId, version: 1, usageMarkupBps: 1750, currency: 'USD',
        paymentTermsDays: 30, effectiveFromMonth: '2026-08' },
    });
    await activateBillingContractVersion({
      contractId, contractVersionId: august.id,
      services: [{ serviceId, monthlyAmountMinor: '500' }],
      actor: { email: 'admin@terms.example' },
    }, { prisma: db.prisma, now: () => new Date('2026-07-20T00:00:00Z') });
    expect(await db.prisma.billingTariffAssignment.count({ where: { serviceId } })).toBe(0);
    const july = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-07',
    });
    const inAugust = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-08',
    });
    expect(july.tariff.markupBps).toBe(3000);
    expect(inAugust.tariff.markupBps).toBe(1750);
    expect(inAugust.assignmentId).toBeNull();

    const september = await db.prisma.billingOrganisationContractVersion.create({
      data: { contractId, version: 2, usageMarkupBps: 900, currency: 'USD',
        paymentTermsDays: 30, effectiveFromMonth: '2026-09' },
    });
    await activateBillingContractVersion({
      contractId, contractVersionId: september.id,
      services: [{ serviceId, monthlyAmountMinor: '600' }],
      actor: { email: 'admin@terms.example' },
    }, { prisma: db.prisma, now: () => new Date('2026-08-20T00:00:00Z') });
    const delayedAugust = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-08',
    });
    const inSeptember = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-09',
    });
    expect(delayedAugust.tariff.id).toBe(inAugust.tariff.id);
    expect(inSeptember.tariff.markupBps).toBe(900);

    // A legacy current pointer can still name the old manual tariff. It must
    // not extend that discount after the agreement is terminated.
    await db.prisma.billingTariffTermEvent.create({
      data: { serviceId, source: 'ORGANISATION', scopeKey: orgId,
        effectiveFromMonth: '2026-09', tariffId: inSeptember.tariff.id,
        reason: 'legacy-contract-pointer' },
    });
    await db.prisma.billingOrganisationContract.update({
      where: { id: contractId },
      data: { status: 'TERMINATED', terminatedAt: new Date('2026-10-15T12:00:00Z') },
    });
    const historical = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-09',
    });
    expect(historical.tariff.id).toBe(inSeptember.tariff.id);
    await expect(resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-10',
    })).rejects.toThrow('BILLING_CONTRACT_TERMINATION_MONTH_RECONCILIATION_REQUIRED');
    await expect(resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-11',
    })).rejects.toThrow('BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED');
    await db.prisma.billingTariffTermEvent.create({
      data: { serviceId, source: 'ORGANISATION', scopeKey: orgId,
        effectiveFromMonth: '2026-12', tariffId: null, reason: 'reconciled-removal' },
    });
    const december = await resolveBillingTariffForMonth(db.prisma, {
      serviceId, organisationId: orgId, teamId: 'team', billingMonth: '2026-12',
    });
    expect(december.tariff.markupBps).toBe(3000);
  }, 120_000);
});
