import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { createBillingTariffVersion, upsertBillingTariffAssignment } from '../../src/services/billing-tariff.service.js';
import { nextUtcBillingMonth, resolveBillingTariffForMonth } from '../../src/services/billing-tariff-history.service.js';
import { rateProviderCost } from '../../src/services/billing-rating.service.js';

const cases = [
  ['standard', 'standard', 399, true], ['custom', 'custom', 175, true], ['waived-seats', 'custom', 0, true],
  ['waived-usage', 'free', 399, false], ['custom-waived-usage', 'free', 175, false], ['both-waived', 'free', 0, false],
] as const;
describe.skipIf(!process.env.DATABASE_URL)('Nessie seat and usage exceptions', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let serviceId: string, ownerId: string;
  const actor = { email: 'operator@example.test' };
  beforeAll(async () => {
    const handle = await createTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    serviceId = (await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Seats', tariffHistoryFromMonth: '2026-01' } })).id;
    ownerId = (await db.prisma.user.create({ data: { email: 'owner@example.test', userKey: 'owner' } })).id;
  });
  afterAll(async () => { if (db) await db.cleanup(); });
  describe.each(['team', 'organisation'])('%s operator agreement', scope => {
    it.each(cases)('%s', async (name, mode, seat, paidUsage) => {
      const p = db.prisma, key = scope + '-' + name;
      const org = await p.organisation.create({ data: { ownerId, slug: key, name: key, domain: 'seat.example' } });
      const team = await p.team.create({ data: { orgId: org.id, name: 'First', slug: 'first' } });
      await p.orgMember.create({ data: { orgId: org.id, userId: ownerId, role: 'owner' } });
      const tariff = await createBillingTariffVersion({ serviceId, actor, setAsDefault: false, tariff: {
        key, name, mode, collectionMode: seat ? 'stripe' : 'none', monthlyAmountMinor: String(seat), currency: 'USD',
        monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic', seatChargeTiming: 'prorated',
        markupBps: paidUsage ? 3000 : 0, usagePaymentMode: paidUsage ? 'prepaid' : 'pay_as_you_go',
      } }, { prisma: p });
      const assignment = await upsertBillingTariffAssignment({ serviceId, tariffId: tariff.id, actor, organisationId: org.id,
        teamId: scope === 'team' ? team.id : null }, { prisma: p });
      const terms = await resolveBillingTariffForMonth(p, { serviceId, organisationId: org.id, teamId: team.id,
        billingMonth: nextUtcBillingMonth(new Date()) });
      expect(terms.assignmentId).toBe(assignment.id);
      expect(terms.source).toBe(scope.toUpperCase());
      expect(terms.tariff).toMatchObject({ monthlyAmountMinor: BigInt(seat), anniversarySeats: seat > 0,
        seatPolicy: 'AUTOMATIC', usagePaymentMode: paidUsage ? 'PREPAID' : 'PAY_AS_YOU_GO' });
      expect(rateProviderCost('1', 'USD', { mode, markupBps: terms.tariff.markupBps }).total).toBe(paidUsage ? '1.3' : '0');
      // A prospective paid assignment cannot block invitations before Checkout can use those terms.
      await p.teamInvite.create({ data: { orgId: org.id, teamId: team.id, email: 'invitee@example.test', lastSentAt: new Date() } });
      expect(await p.billingAutomaticSeatChange.count()).toBe(0);
    });
  });
});
