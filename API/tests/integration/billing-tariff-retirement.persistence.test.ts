import { BillingTariffSource } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { serializeBillingService } from '../../src/routes/internal/admin/billing-serialization.js';
import { resolveCurrentBillingTariff } from '../../src/services/billing-current-tariff.service.js';
import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';
import { listBillingServices } from '../../src/services/billing-tariff-read.service.js';
import {
  restoreBillingTariff,
  retireBillingTariff,
} from '../../src/services/billing-tariff-retirement.service.js';
import {
  nextUtcBillingMonth,
  resolveBillingTariffForMonth,
  utcBillingMonth,
} from '../../src/services/billing-tariff-history.service.js';
import {
  createBillingService,
  createBillingTariffVersion,
  setDefaultBillingTariff,
  upsertBillingTariffAssignment,
} from '../../src/services/billing-tariff.service.js';
import { captureTestOrganisationFinancialBinding } from '../helpers/organisation-financial-binding.js';
import { createTestDb } from '../helpers/test-db.js';
import { createRetirementStripeSubscription } from './billing-tariff-retirement.fixture.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
const actor = { userId: null, email: 'operator@example.com' };
const thisMonth = utcBillingMonth(new Date());

describe.skipIf(!process.env.DATABASE_URL)('tariff version retirement with PostgreSQL', () => {
  let db: TestDb;
  let ownerId: string;
  let serviceId: string;
  let defaultId: string;
  const org = (slug: string) => db.prisma.organisation.create({ data: {
    domain: `${slug}.retire.example`, name: slug, slug, ownerId } });
  const tariff = (key: string, terms: Record<string, unknown> = {}) =>
    db.prisma.billingTariff.create({ data: { serviceId, key, version: 1, name: key, mode: 'CUSTOM',
      collectionMode: 'MANUAL', markupBps: 2000, monthlyAmountMinor: 1000n, currency: 'USD', ...terms } });
  const deps = () => ({ prisma: db.prisma });
  const blockers = async (id: string) => {
    const service = (await listBillingServices(deps())).find((row) => row.id === serviceId)!;
    return serializeBillingService(service).tariffs.find((row) => row.id === id)!.retire_blocked_by;
  };

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    ownerId = (await db.prisma.user.create({ data: {
      email: 'retire-owner@example.com', userKey: 'retire-owner@example.com' } })).id;
    const service = await createBillingService({ identifier: 'retire-service', name: 'Retire', actor,
      defaultTariff: { key: 'base', name: 'Base', mode: 'at_cost', collectionMode: 'none',
        monthlyAmountMinor: '0', currency: 'USD' } }, deps());
    serviceId = service.id;
    defaultId = service.tariffs[0]!.id;
    expect(service.tariffs[0]!.retireBlockedBy).toEqual(['default']);
  });
  afterAll(async () => { if (db) await db.cleanup(); vi.unstubAllEnvs(); });

  it('lets only the two retirement columns change and keeps terms and deletes refused', async () => {
    const plain = await tariff('trigger-check');
    const at = new Date('2026-11-16T10:00:00.000Z');
    await expect(db.prisma.billingTariff.update({ where: { id: plain.id },
      data: { retiredAt: at, retiredByEmail: 'direct@example.com' } })).resolves.toMatchObject({ retiredAt: at });
    await db.prisma.billingTariff.update({ where: { id: plain.id }, data: { retiredAt: null, retiredByEmail: null } });
    await expect(db.prisma.billingTariff.update({ where: { id: plain.id }, data: { name: 'renamed' } }))
      .rejects.toThrow('billing tariff version terms are immutable');
    await expect(db.prisma.billingTariff.update({ where: { id: plain.id }, data: { markupBps: 1 } }))
      .rejects.toThrow('billing tariff version terms are immutable');
    await expect(db.prisma.billingTariff.delete({ where: { id: plain.id } }))
      .rejects.toThrow('billing tariff versions are immutable');
    await expect(db.prisma.billingTariff.update({ where: { id: defaultId },
      data: { retiredAt: at, retiredByEmail: 'direct@example.com' } })).rejects.toThrow('billing_tariffs_default_not_retired');
    await expect(db.prisma.billingTariff.update({ where: { id: plain.id }, data: { retiredAt: at } }))
      .rejects.toThrow('billing_tariffs_retirement_actor');
  });

  it('refuses the default and an unknown or foreign tariff', async () => {
    await expect(retireBillingTariff({ serviceId, tariffId: defaultId, actor }, deps()))
      .rejects.toThrow('BILLING_TARIFF_IN_USE');
    await expect(retireBillingTariff({ serviceId, tariffId: 'missing', actor }, deps()))
      .rejects.toThrow('BILLING_TARIFF_NOT_FOUND');
    expect(await blockers(defaultId)).toEqual(['default']);
  });

  it('retires and restores idempotently with one audit row each, keeping version numbering', async () => {
    const first = await createBillingTariffVersion({ serviceId, setAsDefault: false, actor,
      tariff: { key: 'promo', name: 'Promo', mode: 'free', collectionMode: 'none', monthlyAmountMinor: '0', currency: 'USD' } }, deps());
    expect(first.retireBlockedBy).toEqual([]);
    const retired = await retireBillingTariff({ serviceId, tariffId: first.id, actor }, deps());
    expect(retired).toMatchObject({ retiredByEmail: actor.email, retireBlockedBy: [] });
    expect(retired.retiredAt).toBeInstanceOf(Date);
    const again = await retireBillingTariff({ serviceId, tariffId: first.id, actor }, deps());
    expect(again.retiredAt).toEqual(retired.retiredAt);
    const next = await createBillingTariffVersion({ serviceId, setAsDefault: false, actor,
      tariff: { key: 'promo', name: 'Promo 2', mode: 'free', collectionMode: 'none', monthlyAmountMinor: '0', currency: 'USD' } }, deps());
    expect(next.version).toBe(2);

    const listed = serializeBillingService((await listBillingServices(deps())).find((row) => row.id === serviceId)!);
    expect(listed.tariffs.find((row) => row.id === first.id)).toMatchObject({
      retired_at: retired.retiredAt!.toISOString(), retire_blocked_by: [] });
    expect(listed.tariffs.find((row) => row.id === next.id)).toMatchObject({ retired_at: null });

    await expect(setDefaultBillingTariff({ serviceId, tariffId: first.id, actor }, deps()))
      .rejects.toThrow('BILLING_TARIFF_RETIRED');
    const someone = await org('retired-assignee');
    await expect(upsertBillingTariffAssignment({ serviceId, tariffId: first.id, organisationId: someone.id, actor }, deps()))
      .rejects.toThrow('BILLING_TARIFF_RETIRED');

    const restored = await restoreBillingTariff({ serviceId, tariffId: first.id, actor }, deps());
    expect(restored).toMatchObject({ retiredAt: null, retiredByEmail: null });
    await restoreBillingTariff({ serviceId, tariffId: first.id, actor }, deps());
    const audit = (await db.prisma.adminAuditLog.findMany({ where: {
      action: { in: ['billing.tariff_version_retired', 'billing.tariff_version_restored'] } },
      orderBy: { createdAt: 'asc' } }))
      .filter((row) => (row.metadata as { tariff_id?: string }).tariff_id === first.id);
    expect(audit.map((row) => [row.action, row.actorEmail, row.metadata])).toEqual([
      ['billing.tariff_version_retired', actor.email, { service_id: serviceId, tariff_id: first.id,
        tariff_key: 'promo', tariff_version: 1, tariff_name: 'Promo' }],
      ['billing.tariff_version_restored', actor.email, { service_id: serviceId, tariff_id: first.id,
        tariff_key: 'promo', tariff_version: 1, tariff_name: 'Promo' }],
    ]);
  });

  it('blocks while assigned and reports when the assignment starts', async () => {
    const assigned = await tariff('assigned');
    const assignee = await org('assignment-holder');
    const assignment = await upsertBillingTariffAssignment({ serviceId, tariffId: assigned.id,
      organisationId: assignee.id, actor }, deps());
    expect(assignment.effectiveFromMonth).toBe(nextUtcBillingMonth(new Date()));
    expect(assignment.tariff.retireBlockedBy).toEqual(['assignments']);
    await expect(retireBillingTariff({ serviceId, tariffId: assigned.id, actor }, deps()))
      .rejects.toThrow('BILLING_TARIFF_IN_USE');
    const listed = serializeBillingService((await listBillingServices(deps())).find((row) => row.id === serviceId)!);
    expect(listed.assignments.find((row) => row.id === assignment.id)).toMatchObject({
      effective_from_month: nextUtcBillingMonth(new Date()),
      tariff: { id: assigned.id, retired_at: null, retire_blocked_by: ['assignments'] },
    });
  });

  it('blocks on a live Stripe subscription and stops once it has ended', async () => {
    const stripeTariff = await tariff('stripe-plan', { mode: 'STANDARD', collectionMode: 'STRIPE' });
    const holder = await org('stripe-holder');
    const subscription = await createRetirementStripeSubscription(db.prisma, {
      serviceId, tariffId: stripeTariff.id, orgId: holder.id, ownerId });
    expect(await blockers(stripeTariff.id)).toEqual(['assignments', 'subscriptions']);
    await db.prisma.billingStripeSubscription.update({ where: { id: subscription.id }, data: { status: 'canceled' } });
    expect(await blockers(stripeTariff.id)).toEqual(['assignments']);
  });

  it('blocks on a live seat subscription and a contract that is not terminated, never on history', async () => {
    const seatTariff = await tariff('contract-seat', { monthlyChargeBasis: 'PER_SEAT', seatPolicy: 'FIXED',
      seatChargeTiming: 'PRORATED' });
    const holder = await org('contract-holder');
    const contract = await db.prisma.billingOrganisationContract.create({ data: {
      ...await captureTestOrganisationFinancialBinding(db.prisma, holder.id),
      orgId: holder.id, reference: 'retire-contract', name: 'Retire contract' } });
    const version = await db.prisma.billingOrganisationContractVersion.create({ data: {
      contractId: contract.id, version: 1, usageMarkupBps: 2000, currency: 'USD', paymentTermsDays: 30,
      effectiveFromMonth: nextUtcBillingMonth(new Date()) } });
    const term = await db.prisma.billingContractServiceTerm.create({ data: {
      contractVersionId: version.id, serviceId, tariffId: seatTariff.id, monthlyAmountMinor: 1000n } });
    const seat = await db.prisma.$transaction(async (tx) => {
      const now = await observedBillingTime(tx);
      const created = await tx.billingSeatSubscription.create({ data: {
        contractServiceTermId: term.id, serviceId, tariffId: seatTariff.id, orgId: holder.id, teamId: null,
        scope: 'ORGANISATION', seatPolicy: 'FIXED', seatChargeTiming: 'PRORATED', unitAmountMinor: 1000n,
        currency: 'USD', activatedAt: now, baselineCapturedAt: now, commercialEffectiveAt: now } });
      await tx.billingFixedSeatCapacityRevision.create({ data: { seatSubscriptionId: created.id, quantity: 1, effectiveAt: now } });
      return created;
    });
    expect(await blockers(seatTariff.id)).toEqual(['subscriptions', 'contract_terms']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.prisma.$transaction(async (tx) => {
      await tx.billingSeatSubscription.update({ where: { id: seat.id }, data: { endedAt: await observedBillingTime(tx) } });
    });
    expect(await blockers(seatTariff.id)).toEqual(['contract_terms']);
    const activatedAt = new Date();
    await db.prisma.billingOrganisationContract.update({ where: { id: contract.id },
      data: { status: 'ACTIVE', activatedAt } });
    expect(await blockers(seatTariff.id)).toEqual(['contract_terms']);
    await db.prisma.billingOrganisationContract.update({ where: { id: contract.id },
      data: { status: 'TERMINATED', terminatedAt: new Date(activatedAt.getTime() + 1000) } });
    expect(await blockers(seatTariff.id)).toEqual([]);
    await expect(retireBillingTariff({ serviceId, tariffId: seatTariff.id, actor }, deps()))
      .resolves.toMatchObject({ retireBlockedBy: [] });
  });

  it('still resolves a month whose terms name a retired version', async () => {
    const historic = await tariff('historic');
    const holder = await org('history-holder');
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId, source: BillingTariffSource.ORGANISATION,
      scopeKey: holder.id, effectiveFromMonth: thisMonth, tariffId: historic.id, reason: 'test-history' } });
    await retireBillingTariff({ serviceId, tariffId: historic.id, actor }, deps());
    const resolved = await resolveBillingTariffForMonth(db.prisma, { serviceId, organisationId: holder.id,
      teamId: null, billingMonth: thisMonth });
    expect(resolved.tariff).toMatchObject({ id: historic.id, retiredByEmail: actor.email });
  });

  // Last: a Nessie service with anniversary seat terms arms membership triggers for later writes.
  it('skips a retired Nessie regional version in the API and the SQL seat scope', async () => {
    const nessie = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Nessie',
      tariffHistoryFromMonth: thisMonth } });
    const regular = { serviceId: nessie.id, mode: 'STANDARD' as const, collectionMode: 'STRIPE' as const,
      markupBps: 3000, monthlyAmountMinor: 399n, monthlyChargeBasis: 'PER_SEAT' as const, seatPolicy: 'AUTOMATIC' as const,
      seatChargeTiming: 'PRORATED' as const, usagePaymentMode: 'PREPAID' as const, anniversarySeats: true, usageCurrency: 'USD' };
    const usd = await db.prisma.billingTariff.create({ data: { ...regular, key: 'standard-usd', version: 1,
      name: 'Regular', currency: 'USD', isDefault: true } });
    await db.prisma.billingTariffTermEvent.create({ data: { serviceId: nessie.id, source: BillingTariffSource.SERVICE_DEFAULT,
      scopeKey: nessie.id, effectiveFromMonth: thisMonth, tariffId: usd.id, reason: 'test-default' } });
    const versions = [];
    for (const version of [1, 2]) {
      versions.push(await db.prisma.billingTariff.create({ data: { ...regular, key: 'standard-eur', version,
        name: `Regular EUR ${version}`, currency: 'EUR' } }));
    }
    const holder = await org('nessie-region');
    await db.prisma.billingOrganisationRegion.create({ data: { orgId: holder.id, region: 'EUROPE', currency: 'EUR',
      setByUserId: ownerId } });
    await db.prisma.billingAppKey.create({ data: { serviceId: nessie.id, purpose: 'CUSTOMER_LIFECYCLE',
      name: 'Nessie lifecycle', keyPrefix: 'uoa_app_retire', secretDigest: 'retire-nessie-digest',
      actorIssuer: `https://${holder.domain}`, actorAudience: 'https://authentication.unlikeotherai.com',
      actorKeyId: 'retire-key', actorPublicJwk: { kty: 'RSA', kid: 'retire-key', n: 'AQAB', e: 'AQAB' } } });
    const scope = { serviceId: nessie.id, organisationId: holder.id, teamId: null, billingMonth: thisMonth };
    const seatScope = () => db.prisma.$queryRaw<Array<{ tariff_id: string }>>`
      SELECT tariff_id FROM billing_nessie_paid_seat_scope(${holder.id}, NULL)`;
    expect((await resolveCurrentBillingTariff(db.prisma, scope, 'nessie')).tariff.id).toBe(versions[1]!.id);
    expect(await seatScope()).toEqual([{ tariff_id: versions[1]!.id }]);
    await retireBillingTariff({ serviceId: nessie.id, tariffId: versions[1]!.id, actor }, deps());
    expect((await resolveCurrentBillingTariff(db.prisma, scope, 'nessie')).tariff.id).toBe(versions[0]!.id);
    expect(await seatScope()).toEqual([{ tariff_id: versions[0]!.id }]);
  });
});
