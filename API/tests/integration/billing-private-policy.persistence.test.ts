import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsIds } from '../helpers/sms-financial-fixture.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { setProductPolicy } from '../../src/services/billing-product-policy.service.js';
import { privateCompanyPolicy } from '../../src/services/billing-product-private-policy.service.js';
import { removeBillingTariffAssignment, upsertBillingTariffAssignment } from '../../src/services/billing-tariff.service.js';
import { nextUtcBillingMonth, utcBillingMonth } from '../../src/services/billing-tariff-history.service.js';

describe.skipIf(!process.env.DATABASE_URL)('private company policy immutable term boundaries', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let privateTariff: string;
  let standardTariff: string;
  const now = new Date();
  const nextMonth = nextUtcBillingMonth(now);
  const boundary = new Date(`${nextMonth}-01T00:00:00.000Z`);
  const actor = { userId: smsIds.user, email: 'operator@example.test' };
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    await seedSmsFinance(db.prisma, false);
    await db.prisma.billingService.update({ where: { id: smsIds.service },
      data: { tariffHistoryFromMonth: utcBillingMonth(now) } });
    await db.prisma.clientDomain.create({ data: { domain: 'authentication.unlikeotherai.com', label: 'Registered product source' } });
    await db.prisma.domainRole.create({ data: { domain: getAdminAuthDomain(), userId: smsIds.user, role: 'SUPERUSER' } });
    privateTariff = (await db.prisma.billingTariff.create({ data: { serviceId: smsIds.service, key: 'private', version: 1,
      name: 'Private', mode: 'AT_COST', collectionMode: 'MANUAL', usagePaymentMode: 'PREPAID', markupBps: 0,
      monthlyAmountMinor: 0n, currency: 'USD', usageCurrency: 'USD' } })).id;
    standardTariff = (await db.prisma.billingTariff.create({ data: { serviceId: smsIds.service, key: 'standard', version: 1,
      name: 'Standard', mode: 'STANDARD', collectionMode: 'MANUAL', usagePaymentMode: 'PREPAID', markupBps: 3000,
      monthlyAmountMinor: 399n, currency: 'USD', usageCurrency: 'USD' } })).id;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  async function company(suffix: string, effectiveFromMonth = utcBillingMonth(now)) {
    const org = await db.prisma.organisation.create({ data: { domain: `${suffix}.example.test`, name: suffix,
      slug: suffix, ownerId: smsIds.user } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    const assignment = await db.prisma.billingTariffAssignment.create({ data: { serviceId: smsIds.service,
      tariffId: privateTariff, orgId: org.id, scope: 'ORGANISATION', scopeKey: org.id, createdByEmail: actor.email } });
    const event = await db.prisma.billingTariffTermEvent.create({ data: { serviceId: smsIds.service,
      source: 'ORGANISATION', scopeKey: org.id, effectiveFromMonth, tariffId: privateTariff,
      assignmentId: assignment.id, reason: 'Synthetic exact private acceptance' } });
    return { org, team, assignment, event };
  }
  async function policy(orgId: string) {
    return setProductPolicy({ serviceId: smsIds.service, organisationId: orgId,
      sourceDomain: 'authentication.unlikeotherai.com', privateAtCost: true,
      actor: { userId: smsIds.user, tokenVersion: 0 } }, { prisma: db.prisma, now: () => now });
  }
  async function privateAt(orgId: string, at: Date) {
    return privateCompanyPolicy(db.prisma, smsIds.service, orgId, at);
  }
  it('exposes the exact future effective date and cannot activate private standing early', async () => {
    const { org, event } = await company('future-private', nextMonth);
    expect(await policy(org.id)).toMatchObject({ effective_at: boundary.toISOString() });
    expect(await privateAt(org.id, now)).toBeNull();
    expect(await privateAt(org.id, boundary)).toMatchObject({ privateTermEventId: event.id });
    await expect(db.prisma.billingProductPolicyRevision.updateMany({ where: { enrollmentId:
      (await db.prisma.billingProductEnrollment.findUniqueOrThrow({ where: { serviceId_orgId: {
        serviceId: smsIds.service, orgId: org.id } } })).id }, data: { effectiveAt: now } })).rejects.toThrow();
  });
  it('rejects a later marked-up team override before mutation while private terms are effective', async () => {
    const { org, team } = await company('override-private'); await policy(org.id);
    await expect(upsertBillingTariffAssignment({ serviceId: smsIds.service, organisationId: org.id,
      teamId: team.id, tariffId: standardTariff, actor }, { prisma: db.prisma })).rejects.toThrow('BILLING_PRIVATE_TEAM_OVERRIDE_CONFLICT');
    expect(await db.prisma.billingTariffAssignment.count({ where: { orgId: org.id, teamId: team.id } })).toBe(0);
    expect(await privateAt(org.id, now)).not.toBeNull();
  });
  it('keeps private standing now and transitions with the exact next-month standard acceptance', async () => {
    const { org, event } = await company('transition-private'); await policy(org.id);
    await upsertBillingTariffAssignment({ serviceId: smsIds.service, organisationId: org.id,
      tariffId: standardTariff, actor }, { prisma: db.prisma });
    expect(await privateAt(org.id, now)).toMatchObject({ privateTermEventId: event.id });
    expect(await privateAt(org.id, boundary)).toBeNull();
    expect((await db.prisma.billingTariffTermEvent.findUniqueOrThrow({ where: { id: event.id } })).tariffId).toBe(privateTariff);
    expect(await upsertBillingTariffAssignment({ serviceId: smsIds.service, organisationId: org.id,
      tariffId: standardTariff, teamId: (await db.prisma.team.findFirstOrThrow({ where: { orgId: org.id } })).id,
      actor }, { prisma: db.prisma })).toMatchObject({ tariffId: standardTariff });
  });
  it('removes the future private entitlement through an append-only removal event without changing current accepted terms', async () => {
    const { org, assignment, event } = await company('removed-private'); await policy(org.id);
    await removeBillingTariffAssignment({ serviceId: smsIds.service, assignmentId: assignment.id, actor }, { prisma: db.prisma });
    expect(await privateAt(org.id, now)).toMatchObject({ privateTermEventId: event.id });
    expect(await privateAt(org.id, boundary)).toBeNull();
    expect((await db.prisma.billingTariffTermEvent.findUniqueOrThrow({ where: { id: event.id } })).tariffId).toBe(privateTariff);
  });
  it('does not carry a private waiver across a later authoritative negotiated contract', async () => {
    const { org, event } = await company('contract-private'); await policy(org.id);
    const contract = await db.prisma.billingOrganisationContract.create({ data: { orgId: org.id,
      reference: 'synthetic-future-contract', name: 'Future accepted terms', status: 'ACTIVE', activatedAt: now } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: { contractId: contract.id,
      version: 1, effectiveFromMonth: nextMonth, usageMarkupBps: 3000, currency: 'USD', paymentTermsDays: 30 } });
    await db.prisma.billingContractServiceTerm.create({ data: { contractVersionId: version.id,
      serviceId: smsIds.service, tariffId: standardTariff, monthlyAmountMinor: 399n } });
    expect(await privateAt(org.id, now)).toMatchObject({ privateTermEventId: event.id });
    expect(await privateAt(org.id, boundary)).toBeNull();
    await expect(setProductPolicy({ serviceId: smsIds.service, organisationId: org.id,
      sourceDomain: 'authentication.unlikeotherai.com', privateAtCost: true,
      actor: { userId: smsIds.user, tokenVersion: 0 } }, { prisma: db.prisma, now: () => boundary }))
      .rejects.toThrow('BILLING_PRIVATE_EFFECTIVE_TARIFF_CONFLICT');
  });
});
