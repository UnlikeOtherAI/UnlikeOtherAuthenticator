import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import {
  changeFixedSeatCapacity, listSeatSubscriptions,
} from '../../src/services/billing-seat-capacity.service.js';
import { observedBillingTime } from '../../src/services/billing-seat-observed-time.service.js';

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
    quantity?: number; team?: string; timing?: 'FULL_MONTH' | 'PRORATED' },
): Promise<void> {
  const service = await prisma.billingService.create({
    data: { identifier: `seat-${id}`, name: id },
  });
  const tariff = await prisma.billingTariff.create({ data: {
    serviceId: service.id, key: id, version: 1, name: id, mode: 'CUSTOM',
    collectionMode: 'MANUAL', markupBps: 3000, currency: 'USD',
    monthlyChargeBasis: 'PER_SEAT', seatPolicy: options.policy,
    seatChargeTiming: options.timing ?? 'PRORATED', monthlyAmountMinor: 1000n,
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
    const now = await observedBillingTime(tx);
    await tx.billingSeatSubscription.create({ data: {
      id, contractServiceTermId: term.id, serviceId: service.id, tariffId: tariff.id,
      orgId, teamId: options.scope === 'TEAM' ? (options.team ?? teamId) : null,
      scope: options.scope, seatPolicy: options.policy,
      seatChargeTiming: options.timing ?? 'PRORATED',
      unitAmountMinor: 1000n, currency: 'USD', activatedAt: now, baselineCapturedAt: now,
      commercialEffectiveAt: now,
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
    await prisma.domainRole.create({ data: {
      userId: ownerId, domain: getAdminAuthDomain(), role: 'SUPERUSER',
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

  it('starts and stops seat liability when durable membership becomes visible', async () => {
    const userId = 'seat_commit_person';
    await addUser(userId);
    const observer = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    try {
      await expect(prisma.$transaction(async (tx) => {
        await tx.teamMember.create({ data: { teamId, userId } });
        throw new Error('simulated rollback');
      })).rejects.toThrow('simulated rollback');
      expect(await prisma.billingSeatMembershipInterval.count({ where: {
        seatSubscriptionId: 'seat_auto_team', userId,
      } })).toBe(0);
      const joinLowerBound = await prisma.$transaction(async (tx) => {
        await tx.teamMember.create({ data: { teamId, userId } });
        expect(await observer.teamMember.findUnique({ where: {
          teamId_userId: { teamId, userId },
        } })).toBeNull();
        expect(await observer.billingSeatMembershipInterval.count({ where: {
          seatSubscriptionId: 'seat_auto_team', userId,
        } })).toBe(0);
        await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.1)`;
        const [clock] = await tx.$queryRaw<Array<{ at: Date }>>`
          SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
        `;
        return clock!.at;
      });
      const joined = await prisma.billingSeatMembershipInterval.findFirstOrThrow({
        where: { seatSubscriptionId: 'seat_auto_team', userId, endsAt: null },
      });
      expect(joined.startsAt.getTime()).toBeGreaterThanOrEqual(joinLowerBound.getTime());
      const leaveLowerBound = await prisma.$transaction(async (tx) => {
        await tx.teamMember.update({ where: { teamId_userId: { teamId, userId } },
          data: { status: 'REMOVED' } });
        expect((await observer.teamMember.findUniqueOrThrow({ where: {
          teamId_userId: { teamId, userId },
        } })).status).toBe('ACTIVE');
        expect((await observer.billingSeatMembershipInterval.findUniqueOrThrow({
          where: { id: joined.id },
        })).endsAt).toBeNull();
        await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.1)`;
        const [clock] = await tx.$queryRaw<Array<{ at: Date }>>`
          SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
        `;
        return clock!.at;
      });
      const left = await prisma.billingSeatMembershipInterval.findUniqueOrThrow({ where: { id: joined.id } });
      expect(left.endsAt!.getTime()).toBeGreaterThanOrEqual(leaveLowerBound.getTime());
      await prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
      const intervals = await prisma.billingSeatMembershipInterval.count({ where: {
        seatSubscriptionId: 'seat_auto_team', userId,
      } });
      await prisma.$transaction(async (tx) => {
        await tx.teamMember.create({ data: { teamId, userId } });
        await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
      });
      expect(await prisma.billingSeatMembershipInterval.count({ where: {
        seatSubscriptionId: 'seat_auto_team', userId,
      } })).toBe(intervals);
      await prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId } } });
    } finally { await observer.$disconnect(); }
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

  it('keeps captured evidence immutable and closes the old scope on a membership move', async () => {
    const interval = await prisma.billingSeatMembershipInterval.findFirstOrThrow({
      where: { seatSubscriptionId: 'seat_auto_org', userId: 'seat_person_one' },
    });
    await expect(prisma.billingSeatMembershipInterval.delete({ where: { id: interval.id } }))
      .rejects.toThrow('Seat membership evidence is immutable');
    await expect(prisma.billingSeatSubscription.update({
      where: { id: 'seat_auto_org' }, data: { baselineMemberCount: 999 },
    })).rejects.toThrow('Captured seat baseline is immutable');
    await expect(prisma.billingSeatSubscription.update({
      where: { id: 'seat_auto_org' }, data: { endedAt: new Date('2020-01-01') },
    })).rejects.toThrow('Seat subscription must end at observed time');

    const newOrg = await prisma.organisation.create({ data: {
      ownerId, name: 'Other seat org', slug: 'other-seat-org', domain: 'other.seat.example',
    } });
    await prisma.orgMember.update({
      where: { orgId_userId: { orgId, userId: 'seat_person_one' } },
      data: { orgId: newOrg.id },
    });
    expect(await prisma.billingSeatMembershipInterval.count({
      where: { seatSubscriptionId: 'seat_auto_org', userId: 'seat_person_one', endsAt: null },
    })).toBe(0);

    await prisma.billingFixedSeatCapacityRevision.create({ data: {
      seatSubscriptionId: 'seat_fixed_team', quantity: 2, effectiveAt: new Date(),
    } });
    await addUser('seat_person_two');
    await prisma.teamMember.create({ data: {
      teamId: otherTeamId, userId: 'seat_person_two',
    } });
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: otherTeamId, userId: 'seat_person_two' } },
      data: { teamId },
    });
    expect(await prisma.billingSeatMembershipInterval.count({ where: {
      seatSubscriptionId: 'seat_auto_team', userId: 'seat_person_two', endsAt: null,
    } })).toBe(1);
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId, userId: 'seat_person_two' } },
      data: { teamId: otherTeamId },
    });
    expect(await prisma.billingSeatMembershipInterval.count({ where: {
      seatSubscriptionId: 'seat_auto_team', userId: 'seat_person_two', endsAt: null,
    } })).toBe(0);
  });

  it('records a genuine zero-member baseline and schedules full-month reductions', async () => {
    const emptyTeam = await prisma.team.create({ data: {
      orgId, name: 'Empty team', slug: 'empty-team',
    } });
    await makeSeatSubscription('seat_auto_empty', {
      policy: 'AUTOMATIC', scope: 'TEAM', team: emptyTeam.id,
    });
    expect((await prisma.billingSeatSubscription.findUniqueOrThrow({
      where: { id: 'seat_auto_empty' },
    })).baselineMemberCount).toBe(0);
    expect(await prisma.billingSeatMembershipInterval.count({
      where: { seatSubscriptionId: 'seat_auto_empty' },
    })).toBe(0);

    await expect(changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_org', quantity: 1,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma })).rejects.toThrow('Fixed seat capacity exceeded');
    const increase = await changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_org', quantity: 5,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma });
    expect(increase.quantity).toBe(5);
    const serviceId = (await prisma.billingSeatSubscription.findUniqueOrThrow({
      where: { id: 'seat_fixed_org' },
    })).serviceId;
    const [summary] = await listSeatSubscriptions(serviceId, { prisma });
    expect(summary.current_capacity).toBe(5);

    let releaseLock: () => void = () => undefined;
    let signalLocked: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const holding = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organisations WHERE id = ${orgId} FOR UPDATE`;
      signalLocked();
      await lockHeld;
      return observedBillingTime(tx);
    });
    try {
      await locked;
      const waiting = changeFixedSeatCapacity({ subscriptionId: 'seat_fixed_org',
        quantity: 6, actor: { userId: ownerId, tokenVersion: 0 },
      }, { prisma });
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseLock();
      const lowerBound = await holding;
      const revision = await waiting;
      expect(new Date(revision.effective_at).getTime()).toBeGreaterThanOrEqual(lowerBound.getTime());
    } finally { releaseLock(); }

    await makeSeatSubscription('seat_fixed_full_month', {
      policy: 'FIXED', scope: 'TEAM', team: emptyTeam.id,
      quantity: 5, timing: 'FULL_MONTH',
    });
    const now = new Date();
    const reduced = await changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_full_month', quantity: 4,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma, now: () => now });
    expect(reduced.effective_at.slice(0, 10)).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        .toISOString().slice(0, 10),
    );
    await expect(changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_full_month', quantity: 6,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma, now: () => now })).rejects.toThrow('SEAT_CAPACITY_CHANGE_PENDING');
    await prisma.domainRole.update({
      where: { domain_userId: { domain: getAdminAuthDomain(), userId: ownerId } },
      data: { role: 'USER' },
    });
    await expect(changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_org', quantity: 6,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma })).rejects.toThrow();
    await prisma.domainRole.update({
      where: { domain_userId: { domain: getAdminAuthDomain(), userId: ownerId } },
      data: { role: 'SUPERUSER' },
    });
    await prisma.user.update({ where: { id: ownerId }, data: { tokenVersion: { increment: 1 } } });
    await expect(changeFixedSeatCapacity({
      subscriptionId: 'seat_fixed_org', quantity: 6,
      actor: { userId: ownerId, tokenVersion: 0 },
    }, { prisma })).rejects.toThrow();
    await prisma.user.update({ where: { id: ownerId }, data: { tokenVersion: 0 } });
    const endedAt = new Date();
    await prisma.billingSeatSubscription.update({
      where: { id: 'seat_auto_empty' }, data: { endedAt },
    });
    await expect(prisma.billingSeatSubscription.update({
      where: { id: 'seat_auto_empty' }, data: { endedAt: null },
    })).rejects.toThrow('Seat subscription ending is immutable');
  });
});
