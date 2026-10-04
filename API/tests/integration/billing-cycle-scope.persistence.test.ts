import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import {
  billingCycleSnapshotDigest, getBillingCycleDetail, listBillingCycles,
  type BillingCycleContext,
} from '../../src/services/billing-cycle-read.service.js';
import { createTestDb } from '../helpers/test-db.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

describe.skipIf(!enabled)('customer cycle scope persistence', () => {
  let db: TestDb;
  let serviceId: string;
  let orgId: string;
  let teamId: string;
  let ownerId: string;
  let teamManagerId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    const owner = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Owner' } });
    const manager = await db.prisma.user.create({ data: { email: `${randomUUID()}@example.com`,
      userKey: `${randomUUID()}@example.com`, name: 'Team Manager' } });
    ownerId = owner.id;
    teamManagerId = manager.id;
    const org = await db.prisma.organisation.create({ data: { domain: `${randomUUID()}.example.com`,
      name: 'Billing Scope Test', slug: `scope-${randomUUID().slice(0, 10)}`, ownerId } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: { orgId, name: 'Selected Team',
      slug: `team-${randomUUID().slice(0, 10)}` } });
    teamId = team.id;
    const service = await db.prisma.billingService.create({ data: {
      identifier: `billing-scope-${randomUUID()}`, name: 'Scope Service',
    } });
    serviceId = service.id;
    await db.prisma.orgMember.createMany({ data: [
      { orgId, userId: ownerId, role: 'owner' },
      { orgId, userId: teamManagerId, role: 'member' },
    ] });
    await db.prisma.teamMember.createMany({ data: [
      { teamId, userId: ownerId, teamRole: 'owner' },
      { teamId, userId: teamManagerId, teamRole: 'owner' },
    ] });
  });

  afterAll(async () => { await db?.cleanup(); });

  function context(userId: string): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: 'scope-service',
      name: 'Scope Service' } } as BillingCycleContext['credential'],
    actorToken: 'test-signed-actor', endpoint: '/billing/v1/cycles/list',
    request: { product: 'scope-service', organisationId: orgId, teamId, userId } };
  }

  async function insertCycle(month: string, scope: 'team' | 'organisation',
    payer: BillingAssignmentScope, revision = 1) {
    const id = randomUUID();
    const team = scope === 'team' ? teamId : null;
    const startsAt = new Date(`${month}-01T00:00:00.000Z`);
    const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
    const publicSnapshot = { ...billingCycleDetailV2ConformanceFixture,
      cycle_id: id, schema_version: 2, state: 'finalized',
      period: { month, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() },
      scope: { organisation_id: orgId, team_id: team, cycle_scope: scope,
        payer_scope: payer.toLowerCase() },
      product: { id: serviceId, identifier: 'scope-service', name: 'Scope Service' },
      documents: [], document_available: false };
    const privateEvidence = { source: 'isolated-persistence-test', revision };
    return db.prisma.billingCustomerCycle.create({ data: {
      id, serviceId, orgId, teamId: team, billingMonth: month, revision,
      state: 'finalized', payerScope: payer, publicSnapshot, privateEvidence,
      snapshotSha256: billingCycleSnapshotDigest(publicSnapshot, privateEvidence),
    } });
  }

  it('retains both scopes in one month and denies org-paid cycles to team managers', async () => {
    const team = await insertCycle('2026-07', 'team', BillingAssignmentScope.ORGANISATION);
    const org = await insertCycle('2026-07', 'organisation', BillingAssignmentScope.ORGANISATION);
    await insertCycle('2026-06', 'team', BillingAssignmentScope.TEAM);
    const owner = context(ownerId);
    const first = await listBillingCycles(owner, { limit: 1 },
      { prisma: db.prisma, now: new Date('2026-07-15T00:00:00.000Z') });
    expect(first.cycles[0]?.cycle_id).toBe(team.id);
    expect(first.next_cursor).toBe('2026-07:team');
    const second = await listBillingCycles(owner, { limit: 1, cursor: first.next_cursor! },
      { prisma: db.prisma, now: new Date('2026-07-15T00:00:00.000Z') });
    expect(second.cycles[0]?.cycle_id).toBe(org.id);
    expect(second.cycles[0]?.scope.team_id).toBeNull();
    const manager = context(teamManagerId);
    await expect(getBillingCycleDetail(manager, org.id, { prisma: db.prisma }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(getBillingCycleDetail(manager, team.id, { prisma: db.prisma }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a mismatched frozen snapshot and preserves the first revision', async () => {
    const row = await insertCycle('2026-05', 'team', BillingAssignmentScope.TEAM);
    const owner = context(ownerId);
    expect((await getBillingCycleDetail(owner, row.id, { prisma: db.prisma })).cycle_id)
      .toBe(row.id);
    await expect(db.prisma.billingCustomerCycle.update({ where: { id: row.id },
      data: { state: 'adjusted' } })).rejects.toThrow();
    const bad = await db.prisma.billingCustomerCycle.create({ data: {
      id: randomUUID(), serviceId, orgId, teamId, billingMonth: '2026-04',
      revision: 1, state: 'finalized', payerScope: BillingAssignmentScope.TEAM,
      publicSnapshot: { ...row.publicSnapshot as object, cycle_id: 'wrong-cycle' },
      privateEvidence: {}, snapshotSha256: 'a'.repeat(64),
    } });
    await expect(getBillingCycleDetail(owner, bad.id, { prisma: db.prisma }))
      .rejects.toMatchObject({ message: 'BILLING_CYCLE_SNAPSHOT_INTEGRITY' });
  });
});
