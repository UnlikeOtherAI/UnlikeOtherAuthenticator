import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope, Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';




import { getBillingCycleDetail, listBillingCycles } from '../../src/services/billing-cycle-read.service.js';
import { seedCycleScopeFixture } from '../helpers/cycle-scope-fixture.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('captured organisation cycle scope',()=>{
  let f:Awaited<ReturnType<typeof seedCycleScopeFixture>>;
  beforeAll(async()=>{f=await seedCycleScopeFixture();});
  afterAll(async()=>{await f?.db.cleanup();vi.unstubAllEnvs();});
  it('retains both scopes for org managers and refuses team-only financial readers', async () => {
    const {db,ownerId,teamManagerId,context,insertCycle}=f;
    const team = await insertCycle('2030-07', 'team', BillingAssignmentScope.ORGANISATION);
    const org = await insertCycle('2030-07', 'organisation', BillingAssignmentScope.ORGANISATION);
    await insertCycle('2030-06', 'team', BillingAssignmentScope.TEAM);
    const owner = context(ownerId);
    const first = await listBillingCycles(owner, { limit: 1 },
      { prisma: db.prisma, now: new Date('2030-07-15T00:00:00.000Z') });
    expect(first.cycles[0]?.cycle_id).toBe(org.id);
    expect(first.next_cursor).not.toBeNull();
    const second = await listBillingCycles(owner, { limit: 1, cursor: first.next_cursor! },
      { prisma: db.prisma, now: new Date('2030-07-15T00:00:00.000Z') });
    expect(second.cycles[0]?.cycle_id).toBe(team.id);
    expect(first.cycles[0]?.scope.team_id).toBeNull();
    expect((await getBillingCycleDetail(owner, org.id, {prisma:db.prisma})).cycle_id).toBe(org.id);
    expect((await getBillingCycleDetail(owner, team.id, {prisma:db.prisma})).cycle_id).toBe(team.id);
    const manager = context(teamManagerId);
    await expect(listBillingCycles(manager, {}, {prisma:db.prisma}))
      .rejects.toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
    for (const cycle of [org, team]) {
      await expect(getBillingCycleDetail(manager, cycle.id, {prisma:db.prisma}))
        .rejects.toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
    }
  });


  it('pages captured scopes without inventing a current preview total', async () => {
    const {db,ownerId,context,insertCycle}=f;
    const team = await insertCycle('2030-10', 'team', BillingAssignmentScope.ORGANISATION);
    const org = await insertCycle('2030-10', 'organisation', BillingAssignmentScope.ORGANISATION);
    const owner = context(ownerId);
    const now = new Date('2030-11-15T00:00:00.000Z');
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const page = await listBillingCycles(owner, { limit: 1, cursor },
        { prisma: db.prisma, now });
      expect(page.cycles).toHaveLength(1);
      seen.push(page.cycles[0]!.cycle_id);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen.slice(0, 2))).toEqual(new Set([team.id, org.id]));
    expect(seen.some(id=>id.startsWith('preview:'))).toBe(false);
    expect(new Set(seen).size).toBe(seen.length);
  });


  it('rejects a mismatched frozen snapshot and preserves the first revision', async () => {
    const {db,serviceId,orgId,teamId,ownerId,context,insertCycle}=f;
    const row = await insertCycle('2030-05', 'team', BillingAssignmentScope.TEAM);
    const owner = context(ownerId);
    expect((await getBillingCycleDetail(owner, row.id, { prisma: db.prisma })).cycle_id)
      .toBe(row.id);
    await expect(db.prisma.billingCustomerCycle.update({ where: { id: row.id },
      data: { state: 'adjusted' } })).rejects.toThrow();
    const bad = await db.prisma.billingCustomerCycle.create({ data: {
      id: randomUUID(), serviceId, orgId, teamId, billingMonth: '2030-04',
      revision: 1, state: 'finalized', payerScope: BillingAssignmentScope.TEAM,
      publicSnapshot: { ...row.publicSnapshot as object, cycle_id: 'wrong-cycle' },
      privateEvidence: row.privateEvidence ?? Prisma.JsonNull, snapshotSha256: 'a'.repeat(64),
    } });
    await expect(getBillingCycleDetail(owner, bad.id, { prisma: db.prisma }))
      .rejects.toMatchObject({ message: 'BILLING_CYCLE_SNAPSHOT_INTEGRITY' });
  });


});
