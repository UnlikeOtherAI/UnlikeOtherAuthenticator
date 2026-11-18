import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueInviteToken } from '../../src/services/team-invite.service.base.js';
import { createTestDb } from '../helpers/test-db.js';
import { createBillingTariffVersion, upsertBillingTariffAssignment } from '../../src/services/billing-tariff.service.js';
import { nextUtcBillingMonth, resolveBillingTariffForMonth } from '../../src/services/billing-tariff-history.service.js';
import { collectInvitationPayment, invitationFundingRequest, requireFundedInvitation }
  from '../../src/services/billing-invitation-seat.service.js';
import { rateProviderCost } from '../../src/services/billing-rating.service.js';

const cases = [
  ['tokens-only', 'at_cost', 0, true], ['standard', 'standard', 399, true], ['custom', 'custom', 175, true], ['waived-seats', 'custom', 0, true],
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
    await createBillingTariffVersion({ serviceId, actor, setAsDefault: true, tariff: {
      key: 'standard-usd', name: 'Regular seats', mode: 'standard', collectionMode: 'stripe',
      monthlyAmountMinor: '399', currency: 'USD', monthlyChargeBasis: 'per_seat',
      seatPolicy: 'automatic', seatChargeTiming: 'prorated', markupBps: 3000, usagePaymentMode: 'prepaid',
    } }, { prisma: db.prisma });
  });
  afterAll(async () => { if (db) await db.cleanup(); });
  describe.each(['team', 'organisation'])('%s operator agreement', scope => {
    it.each(cases)('%s', async (name, mode, seat, paidUsage) => {
      const p = db.prisma, key = scope + '-' + name;
      const org = await p.organisation.create({ data: { ownerId, slug: key, name: key, domain: 'seat.example' } });
      const team = await p.team.create({ data: { orgId: org.id, name: 'First', slug: 'first' } });
      await p.orgMember.create({ data: { orgId: org.id, userId: ownerId, role: 'owner' } });
      const tariff = await createBillingTariffVersion({ serviceId, actor, setAsDefault: false, tariff: {
        key, name, mode, collectionMode: seat || mode === 'at_cost' ? 'stripe' : 'none', monthlyAmountMinor: String(seat), currency: 'USD',
        monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic', seatChargeTiming: 'prorated',
        markupBps: paidUsage && mode !== 'at_cost' ? 3000 : 0, usagePaymentMode: paidUsage ? 'prepaid' : 'pay_as_you_go',
      } }, { prisma: p });
      const assignment = await upsertBillingTariffAssignment({ serviceId, tariffId: tariff.id, actor, organisationId: org.id,
        teamId: scope === 'team' ? team.id : null }, { prisma: p });
      const terms = await resolveBillingTariffForMonth(p, { serviceId, organisationId: org.id, teamId: team.id,
        billingMonth: nextUtcBillingMonth(new Date()) });
      expect(terms.assignmentId).toBe(assignment.id);
      expect(terms.source).toBe(scope.toUpperCase());
      expect(terms.tariff).toMatchObject({ monthlyAmountMinor: BigInt(seat), anniversarySeats: seat > 0,
        seatPolicy: 'AUTOMATIC', usagePaymentMode: paidUsage ? 'PREPAID' : 'PAY_AS_YOU_GO' });
      expect(rateProviderCost('1', 'USD', { mode, markupBps: terms.tariff.markupBps }).total).toBe(mode === 'at_cost' ? '1' : paidUsage ? '1.3' : '0');
      const invite = (email: string) => p.teamInvite.create({ data: {
        orgId: org.id, teamId: team.id, email, lastSentAt: new Date(),
      } });
      const ready = async (id: string) => (await p.$queryRaw<Array<{ ready: boolean }>>`
        SELECT billing_invitation_seat_ready(${id}) AS ready`)[0]?.ready;
      // Future exceptions never waive payment under the current regular default.
      const future = await invite('future@example.test');
      expect(future).toMatchObject({ billingSeatRequired: true, billingSeatFundedAt: null });
      expect(await ready(future.id)).toBe(false);
      await p.billingTariffTermEvent.create({ data: { serviceId, source: scope === 'team' ? 'TEAM' : 'ORGANISATION',
        scopeKey: assignment.scopeKey, effectiveFromMonth: new Date().toISOString().slice(0, 7),
        tariffId: tariff.id, assignmentId: assignment.id, reason: 'effective-exception-test' } });
      const current = await invite('effective@example.test');
      expect(current).toMatchObject({ billingSeatRequired: seat > 0, billingSeatFundedAt: null });
      expect(await ready(current.id)).toBe(seat === 0);
      if (seat === 0) {
        const cardOnFile = vi.fn().mockRejectedValue(new Error('No card saved'));
        const collect = vi.fn().mockRejectedValue(new Error('No seat charge permitted'));
        // An older held invitation must use the now-effective seat-free agreement too.
        expect(await ready(future.id)).toBe(true);
        for (const id of [future.id, current.id]) {
          await collectInvitationPayment(await invitationFundingRequest(p, id), { admin: p, cardOnFile, collect });
          await expect(requireFundedInvitation(p, id)).resolves.toBeUndefined();
        }
        const config = validateConfigFields(baseClientConfigPayload({ registration_mode: 'passwordless' }));
        await issueInviteToken({ prisma: p, inviteId: future.id, existingUser: null,
          email: future.email, userKey: future.email, domain: org.domain, config,
          configUrl: 'https://client.example.com/config', now: new Date() });
        expect(await p.verificationToken.count({ where: { teamInviteId: future.id, usedAt: null } })).toBe(1);
        expect(await p.teamInvite.findUniqueOrThrow({ where: { id: future.id } }))
          .toMatchObject({ billingSeatRequired: true, billingSeatFundedAt: null });
        await p.teamInvite.update({ where: { id: future.id },
          data: { revokedAt: new Date(), revokedReason: 'REVOKED' } });
        expect(await ready(future.id)).toBe(false);
        expect(cardOnFile).not.toHaveBeenCalled();
        expect(collect).not.toHaveBeenCalled();
      }
    });
  });
});
