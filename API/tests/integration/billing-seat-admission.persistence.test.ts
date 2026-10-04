import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
let prisma: PrismaClient;
const orgId = 'seat_test_org';
const teamId = 'seat_test_team';
const otherTeamId = 'seat_test_other_team';
const ownerId = 'seat_test_owner';

async function addUser(id: string): Promise<void> {
  await prisma.user.create({ data: { id, email: `${id}@seat.example`, userKey: `${id}@seat.example` } });
  await prisma.orgMember.create({ data: { orgId, userId: id } });
}

async function makeSeatSubscription(
  id: string,
  options: { policy: 'AUTOMATIC' | 'FIXED'; scope: 'TEAM' | 'ORGANISATION';
    quantity?: number; team?: string },
): Promise<void> {
  const service = await prisma.billingService.create({
    data: { identifier: `seat-${id}`, name: id },
  });
  const tariff = await prisma.billingTariff.create({ data: {
    serviceId: service.id, key: id, version: 1, name: id, mode: 'CUSTOM',
    collectionMode: 'MANUAL', markupBps: 3000, currency: 'USD',
    monthlyChargeBasis: 'PER_SEAT', seatPolicy: options.policy,
    seatChargeTiming: 'PRORATED', monthlyAmountMinor: 1000n,
  } });
  const contract = await prisma.billingOrganisationContract.create({
    data: { orgId, reference: id, name: id },
  });
  const version = await prisma.billingOrganisationContractVersion.create({ data: {
    contractId: contract.id, version: 1, usageMarkupBps: 3000, currency: 'USD',
    paymentTermsDays: 30, effectiveFromMonth: '2026-11',
  } });
  const term = await prisma.billingContractServiceTerm.create({ data: {
    contractVersionId: version.id, serviceId: service.id, tariffId: tariff.id,
    monthlyAmountMinor: 1000n,
  } });
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.billingSeatSubscription.create({ data: {
      id, contractServiceTermId: term.id, serviceId: service.id, tariffId: tariff.id,
      orgId, teamId: options.scope === 'TEAM' ? (options.team ?? teamId) : null,
      scope: options.scope, seatPolicy: options.policy, seatChargeTiming: 'PRORATED',
      unitAmountMinor: 1000n, currency: 'USD', activatedAt: now, baselineCapturedAt: now,
    } });
    if (options.policy === 'FIXED') {
      await tx.billingFixedSeatCapacityRevision.create({ data: {
        seatSubscriptionId: id, quantity: options.quantity ?? 1, effectiveAt: now,
      } });
    }
  });
}

describe.skipIf(!enabled)('authoritative seat admission and evidence', () => {
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    prisma = db.prisma;
    await prisma.user.create({ data: {
      id: ownerId, email: 'seat_owner@seat.example', userKey: 'seat_owner@seat.example',
    } });
    await prisma.organisation.create({ data: {
      id: orgId, ownerId, name: 'Seat test', slug: 'seat-test', domain: 'seat.example',
    } });
    await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: 'owner' } });
    await prisma.team.create({ data: { id: teamId, orgId, name: 'A', slug: 'team-a' } });
    await prisma.team.create({ data: { id: otherTeamId, orgId, name: 'B', slug: 'team-b' } });
    await prisma.teamMember.create({ data: { teamId, userId: ownerId, teamRole: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: otherTeamId, userId: ownerId, teamRole: 'owner' } });
  });
  afterAll(async () => { if (db) await db.cleanup(); });

  it('captures a zero-capable baseline and tracks team and organisation human intervals', async () => {
    await makeSeatSubscription('seat_auto_org', { policy: 'AUTOMATIC', scope: 'ORGANISATION' });
    await makeSeatSubscription('seat_auto_team', { policy: 'AUTOMATIC', scope: 'TEAM' });
    expect((await prisma.billingSeatSubscription.findUniqueOrThrow({ where: { id: 'seat_auto_org' } }))
      .baselineMemberCount).toBe(1);
    await addUser('seat_person_one');
    await prisma.teamMember.create({ data: { teamId, userId: 'seat_person_one' } });
    await prisma.teamMember.create({ data: { teamId: otherTeamId, userId: 'seat_person_one' } });
    expect(await prisma.billingSeatMembershipInterval.count({
      where: { seatSubscriptionId: 'seat_auto_org', userId: 'seat_person_one', endsAt: null },
    })).toBe(1);
    await prisma.teamMember.update({ where: { teamId_userId: { teamId, userId: 'seat_person_one' } },
      data: { status: 'REMOVED' } });
    expect(await prisma.billingSeatMembershipInterval.count({
      where: { seatSubscriptionId: 'seat_auto_team', userId: 'seat_person_one', endsAt: null },
    })).toBe(0);
    expect(await prisma.billingSeatMembershipInterval.count({
      where: { seatSubscriptionId: 'seat_auto_org', userId: 'seat_person_one', endsAt: null },
    })).toBe(1);
  });

  it('enforces organisation and team fixed limits including pending invitations', async () => {
    await makeSeatSubscription('seat_fixed_org', { policy: 'FIXED', scope: 'ORGANISATION', quantity: 3 });
    await makeSeatSubscription('seat_fixed_team', { policy: 'FIXED', scope: 'TEAM', quantity: 1 });
    await expect(prisma.teamInvite.create({ data: {
      orgId, teamId, email: 'prospect@seat.example', lastSentAt: new Date(),
    } })).rejects.toThrow('Fixed seat capacity exceeded');
    const second = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    let release: () => void = () => undefined;
    let signal: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inserted = new Promise<void>((resolve) => { signal = resolve; });
    try {
      const first = prisma.$transaction(async (tx) => {
        await tx.teamInvite.create({ data: {
          orgId, teamId: otherTeamId, email: 'prospect@seat.example', lastSentAt: new Date(),
        } });
        signal();
        await held;
      });
      await inserted;
      let settled = false;
      const competing = second.teamInvite.create({ data: {
        orgId, teamId: otherTeamId, email: 'another@seat.example', lastSentAt: new Date(),
      } }).then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      release();
      await first;
      await competing;
      expect(await prisma.teamInvite.count({
        where: { orgId, acceptedAt: null, revokedAt: null },
      })).toBe(1);

      await prisma.billingFixedSeatCapacityRevision.create({ data: {
        seatSubscriptionId: 'seat_fixed_org', quantity: 4, effectiveAt: new Date(),
      } });
      let unblockSerializable: () => void = () => undefined;
      let markSerializable: () => void = () => undefined;
      const serialHeld = new Promise<void>((resolve) => { unblockSerializable = resolve; });
      const serialInserted = new Promise<void>((resolve) => { markSerializable = resolve; });
      const serialFirst = prisma.$transaction(async (tx) => {
        await tx.teamInvite.create({ data: {
          orgId, teamId: otherTeamId, email: 'serial-first@seat.example',
          lastSentAt: new Date(),
        } });
        markSerializable();
        await serialHeld;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await serialInserted;
      const serialSecond = second.$transaction(async (tx) => {
        // Establish the old snapshot before the first transaction commits.
        await tx.orgMember.count({ where: { orgId } });
        await tx.teamInvite.create({ data: {
          orgId, teamId: otherTeamId, email: 'serial-second@seat.example',
          lastSentAt: new Date(),
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await new Promise((resolve) => setTimeout(resolve, 40));
      unblockSerializable();
      await serialFirst;
      await expect(serialSecond).rejects.toThrow();
      expect(await prisma.teamInvite.count({
        where: { orgId, acceptedAt: null, revokedAt: null },
      })).toBe(2);
    } finally {
      release();
      await second.$disconnect();
    }
  });
});
