import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runBillingCycleCloseBatch } from '../../src/services/billing-cycle-close-run.service.js';
import {
  seedHistoricalBillingCycleWatches, seedRecentBillingCycleWatches,
} from '../../src/services/billing-cycle-close-seed.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' &&
  Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('durable closed-month cycle watches', () => {
  let db: TestDb;
  let serviceId: string;
  let orgId: string;
  let teamId: string;
  let identifier: string;
  const now = new Date('2026-10-04T12:00:00.000Z');

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: `${randomUUID()}@example.com`,
      name: 'Watch Owner',
    } });
    const org = await db.prisma.organisation.create({ data: {
      domain: `${randomUUID()}.example.com`, name: 'Cycle Watch',
      slug: `cycle-${randomUUID().slice(0, 8)}`, ownerId: owner.id,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: {
      orgId, name: 'Historical Team', slug: `team-${randomUUID().slice(0, 8)}`,
    } });
    teamId = team.id;
    identifier = `cycle-watch-${randomUUID()}`;
    const service = await db.prisma.billingService.create({ data: {
      identifier, name: 'Cycle Watch', tariffHistoryFromMonth: '2026-06',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    } });
    serviceId = service.id;
  });

  afterAll(async () => { await db?.cleanup(); });

  it('seeds recent periods first and resumes historical keysets across restarts', async () => {
    expect(await seedRecentBillingCycleWatches({ prisma: db.prisma, now })).toBe(2);
    expect(await seedRecentBillingCycleWatches({ prisma: db.prisma, now })).toBe(0);
    const recent = await db.prisma.billingCycleCloseWatch.findMany({ where: {
      serviceId, orgId,
    }, orderBy: { billingMonth: 'desc' } });
    expect(recent.map((row) => [row.sourceKind, row.billingMonth, row.priority]))
      .toEqual([['team_discovery', '2026-09', 0], ['team_discovery', '2026-08', 1]]);
    const historical = await seedHistoricalBillingCycleWatches('team_discovery',
      { prisma: db.prisma, now });
    expect(historical).toMatchObject({ sources: 1, inserted: 2, wrapped: false });
    expect(await db.prisma.billingCycleCloseWatch.count({ where: {
      serviceId, orgId,
    } })).toBe(4);
    const resume = await seedHistoricalBillingCycleWatches('team_discovery',
      { prisma: db.prisma, now });
    expect(resume).toMatchObject({ sources: 0, inserted: 0, wrapped: true });
    const simultaneous = await Promise.all([
      seedHistoricalBillingCycleWatches('team_discovery', { prisma: db.prisma, now }),
      seedHistoricalBillingCycleWatches('team_discovery', { prisma: db.prisma, now }),
    ]);
    expect(simultaneous.reduce((total, result) => total + result.sources, 0)).toBe(1);
    expect(simultaneous.every((result) => result.inserted === 0)).toBe(true);
    await expect(db.prisma.billingCycleCloseWatch.update({
      where: { sourceKind_sourceId_billingMonth: {
        sourceKind: 'team_discovery', sourceId: `${serviceId}:${orgId}`,
        billingMonth: '2026-09',
      } }, data: { orgId: randomUUID() },
    })).rejects.toThrow();
  });

  it('claims a current period ahead of history and survives concurrent workers', async () => {
    const discover = vi.fn().mockResolvedValue({ teamIds: [teamId],
      snapshot: { id: 'proof', cursor: 'proof', sha256: 'a'.repeat(64),
        capturedAt: now.toISOString() } });
    const [first, second] = await Promise.all([
      runBillingCycleCloseBatch({ prisma: db.prisma, now, discover }),
      runBillingCycleCloseBatch({ prisma: db.prisma, now, discover }),
    ]);
    expect(first.checked + second.checked).toBe(4);
    expect(first.held + second.held).toBe(0);
    expect(discover).toHaveBeenCalledTimes(4);
    expect(discover.mock.calls[0]?.[0]).toMatchObject({
      product: identifier, organisationId: orgId, billingMonth: '2026-09',
    });
    expect(await db.prisma.billingCycleCloseWatch.count({ where: {
      sourceKind: 'team_usage', serviceId, orgId, teamId,
    } })).toBe(4);
    const settled = await db.prisma.billingCycleCloseWatch.findMany({ where: {
      sourceKind: 'team_discovery', serviceId, orgId,
    } });
    expect(settled.every((row) => row.leaseToken === null &&
      row.lastCheckedAt !== null && row.generation === 1n)).toBe(true);
  });

  it('does not publish discovered team work after its lease expires', async () => {
    const staleTeamId = randomUUID();
    await db.prisma.billingCycleCloseWatch.updateMany({ where: {
      sourceKind: 'team_usage', serviceId, orgId,
    }, data: { nextCheckAt: new Date('2030-01-01T00:00:00.000Z') } });
    await db.prisma.billingCycleCloseWatch.update({ where: {
      sourceKind_sourceId_billingMonth: { sourceKind: 'team_discovery',
        sourceId: `${serviceId}:${orgId}`, billingMonth: '2026-09' },
    }, data: { nextCheckAt: new Date('2020-01-01T00:00:00.000Z') } });
    const discover = vi.fn(async () => {
      await db.prisma.billingCycleCloseWatch.update({ where: {
        sourceKind_sourceId_billingMonth: { sourceKind: 'team_discovery',
          sourceId: `${serviceId}:${orgId}`, billingMonth: '2026-09' },
      }, data: { leaseExpiresAt: new Date('2020-01-01T00:00:00.000Z') } });
      return { teamIds: [staleTeamId], snapshot: { id: 'stale', cursor: 'stale',
        sha256: 'a'.repeat(64), capturedAt: now.toISOString() } };
    });
    const result = await runBillingCycleCloseBatch({ prisma: db.prisma, now, discover });
    expect(result).toMatchObject({ checked: 1, held: 1 });
    expect(result.failures[0]?.code).toBe('BILLING_CYCLE_WATCH_LEASE_LOST');
    expect(await db.prisma.billingCycleCloseWatch.findFirst({ where: {
      sourceKind: 'team_usage', teamId: staleTeamId,
    } })).toBeNull();
  });
});
