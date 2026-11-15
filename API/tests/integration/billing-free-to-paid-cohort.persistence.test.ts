import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';

type Db = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
describe.skipIf(!process.env.DATABASE_URL)('free-to-paid seat cohort', () => {
  let db: Db;
  let serviceId: string, freeId: string, paidId: string;
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw new Error('DATABASE_URL_REQUIRED'); db = created;
    const service = await db.prisma.billingService.create({ data: { identifier: 'nessie', name: 'Nessie',
      tariffHistoryFromMonth: '2026-01' } });
    serviceId = service.id;
    const common = { serviceId, setAsDefault: false, actor: { email: 'operator@example.test' } };
    freeId = (await createBillingTariffVersion({ ...common, tariff: { key: 'explicit-free', name: 'Free seats',
      mode: 'free', collectionMode: 'none', currency: 'USD', usagePaymentMode: 'pay_as_you_go',
      monthlyAmountMinor: '0', monthlyChargeBasis: 'flat' } }, { prisma: db.prisma })).id;
    paidId = (await createBillingTariffVersion({ ...common, tariff: { key: 'standard-usd', name: 'Regular seats',
      mode: 'standard', collectionMode: 'stripe', currency: 'USD', usagePaymentMode: 'prepaid',
      monthlyAmountMinor: '399', monthlyChargeBasis: 'per_seat', seatPolicy: 'automatic', seatChargeTiming: 'prorated' },
    }, { prisma: db.prisma })).id;
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  async function fixture(label: string, old = false) {
    const p = db.prisma, now = new Date(), month = now.toISOString().slice(0, 7);
    const user = (name: string) => p.user.create({ data: { email: `${label}-${name}@example.test`, userKey: `${label}-${name}` } });
    const owner = await user('owner'), member = await user('member'), extra = await user('extra');
    const org = await p.organisation.create({ data: { name: label, slug: label, domain: `${label}.example.test`,
      ownerId: owner.id, ...(old ? { createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)) } : {}) } });
    const team = await p.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
    const assignment = await p.billingTariffAssignment.create({ data: { serviceId, orgId: org.id,
      scope: 'ORGANISATION', scopeKey: org.id, tariffId: freeId } });
    await p.billingTariffTermEvent.create({ data: { serviceId, source: 'ORGANISATION', scopeKey: org.id,
      effectiveFromMonth: month, tariffId: freeId, assignmentId: assignment.id, reason: 'explicit-free-test' } });
    for (const person of [owner, member]) {
      await p.orgMember.create({ data: { orgId: org.id, userId: person.id, role: person.id === owner.id ? 'owner' : 'member' } });
      await p.teamMember.create({ data: { teamId: team.id, userId: person.id } });
    }
    expect(await p.billingNessieSeatTransition.findUnique({ where: { orgId: org.id } })).toBeNull();
    return { p, now, month, owner, member, extra, org, team, assignment };
  }

  it.each(['ORGANISATION', 'TEAM'] as const)('starts 14 days at the %s plan change for its existing members', async source => {
    const { p, month, owner, member, extra, org, team, assignment } = await fixture(source.toLowerCase());
    const target = source === 'TEAM'
      ? await p.billingTariffAssignment.create({ data: { serviceId, orgId: org.id, teamId: team.id,
        scope: 'TEAM', scopeKey: org.id + ':' + team.id, tariffId: paidId } })
      : await p.billingTariffAssignment.update({ where: { id: assignment.id }, data: { tariffId: paidId } });
    const term = await p.billingTariffTermEvent.create({ data: { serviceId, source, scopeKey: target.scopeKey,
      effectiveFromMonth: month, tariffId: paidId, assignmentId: target.id, reason: 'free-to-paid-test' } });
    const transition = await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(transition.startsAt).toEqual(term.createdAt);
    expect(transition.endsAt.getTime() - transition.startsAt.getTime()).toBe(14 * 86400_000);
    expect(transition.cohortUserIds).toEqual([owner.id, member.id].sort());
    const add = () => p.orgMember.create({ data: { orgId: org.id, userId: extra.id, role: 'member' } });
    if (source === 'ORGANISATION') await expect(add()).rejects.toThrow('complete the seat payment');
    else {
      await add(); // The organisation still has its explicit free agreement.
      await expect(p.teamMember.create({ data: { teamId: team.id, userId: extra.id } })).rejects.toThrow('complete the seat payment');
    }
    await p.$executeRaw`SELECT billing_nessie_start_transition(${org.id})`;
    expect(await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: org.id } })).toEqual(transition);
  });

  it('freezes a due scheduled team transition before another member joins the still-free organisation', async () => {
    const { p, now, month, owner, member, extra, org, team } = await fixture('scheduled', true);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const target = await p.billingTariffAssignment.create({ data: { serviceId, orgId: org.id, teamId: team.id,
      scope: 'TEAM', scopeKey: org.id + ':' + team.id, tariffId: paidId } });
    // Seed a previously scheduled term as it would exist when its month arrives.
    // Only fixture setup suppresses INSERT-time capture; the tested member write runs all triggers.
    await p.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingTariffTermEvent.create({ data: { serviceId, source: 'TEAM', scopeKey: target.scopeKey,
        effectiveFromMonth: month, tariffId: paidId, assignmentId: target.id, reason: 'scheduled-test',
        createdAt: new Date(start.getTime() - 86400_000) } });
    });
    await p.orgMember.create({ data: { orgId: org.id, userId: extra.id, role: 'member' } });
    const transition = await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(transition.startsAt).toEqual(start);
    expect(transition.cohortUserIds).toEqual([owner.id, member.id].sort());
    expect(transition.cohortUserIds).not.toContain(extra.id);
    await expect(p.teamMember.create({ data: { teamId: team.id, userId: extra.id } })).rejects.toThrow('complete the seat payment');
    expect(await p.billingNessieSeatTransition.findUniqueOrThrow({ where: { orgId: org.id } })).toEqual(transition);
  });
});
