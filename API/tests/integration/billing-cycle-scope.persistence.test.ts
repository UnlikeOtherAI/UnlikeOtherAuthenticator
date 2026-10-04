import { randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis,
  BillingTariffMode,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
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
  let tariffId: string;
  let serviceIdentifier: string;

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
    serviceIdentifier = service.identifier;
    const tariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'standard', version: 1, name: 'Standard',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 2000n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD',
    } });
    tariffId = tariff.id;
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

  it('freezes a closed quote once while keeping usage and credits pending', async () => {
    const source = { kind: 'manual' as const, id: 'manual-source' };
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2026-08', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
    };
    const usage = {
      schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
      scope: { organizationId: orgId, teamId, userId: null, month: '2026-08',
        startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z' },
      calls: '0', lines: [], billingCompleteness: {
        state: 'complete' as const, unresolvedPaidAttempts: '0',
      },
      snapshot: { cursor: 'cursor-august', id: 'snapshot-august',
        capturedAt: '2026-09-03T00:00:00.000Z', immutable: true as const,
        sha256: 'b'.repeat(64) },
    };
    const quoteFn = vi.fn().mockResolvedValue(quote);
    const fetchMetering = vi.fn().mockResolvedValue(usage);
    const params = { source, billingMonth: '2026-08' };
    const deps = { prisma: db.prisma, now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: quoteFn, fetchMetering };
    const first = await prepareBillingCycleClose(params, deps);
    const replay = await prepareBillingCycleClose(params, deps);
    expect(replay).toEqual(first);
    expect(first.amountMinor).toBe(2000n);
    expect(await db.prisma.billingCustomerCycle.count({ where: {
      serviceId, orgId, teamId: null, billingMonth: '2026-08',
    } })).toBe(1);
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const detail = await getBillingCycleDetail(viewer, first.cycleId,
      { prisma: db.prisma });
    expect(detail).toMatchObject({ state: 'pending_reconciliation',
      scope: { cycle_scope: 'organisation', team_id: null }, document_available: false,
      credits: { consumed: null, status: 'pending_reconciliation' },
      subscription_lines: [{ customer_charge: { amount_minor: '2000' } }],
    });
    quoteFn.mockResolvedValue({ ...quote, amountMinor: 3000n });
    await expect(prepareBillingCycleClose(params, deps))
      .rejects.toMatchObject({ message: 'BILLING_CYCLE_EXISTING_RECONCILIATION_REQUIRED' });
  });

  it('holds uncertain paid usage and serializes concurrent close preparation', async () => {
    const source = { kind: 'manual' as const, id: 'team-manual-september' };
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId,
      scope: BillingAssignmentScope.TEAM, agreementId: null,
      billingMonth: '2026-09', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
    };
    const usage = {
      schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
      scope: { organizationId: orgId, teamId, userId: null, month: '2026-09',
        startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z' },
      calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens', calls: '1',
        inputUnits: '100', cachedInputUnits: '25', outputUnits: '50',
        estimatedProviderCost: null, actualProviderCost: '10',
        selectedProviderCost: '10', currency: 'USD', costProvenance: 'actual',
        billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
        originProduct: serviceIdentifier, userId: ownerId,
        billingDisposition: 'paid' as const }],
      billingCompleteness: { state: 'complete' as const, unresolvedPaidAttempts: '0' },
      snapshot: { cursor: 'cursor-september', id: 'snapshot-september',
        capturedAt: '2026-10-03T00:00:00.000Z', immutable: true as const,
        sha256: 'c'.repeat(64) },
    };
    const quoteFn = vi.fn().mockResolvedValue(quote);
    const fetchMetering = vi.fn().mockResolvedValue(usage);
    const params = { source, billingMonth: '2026-09' };
    const deps = { prisma: db.prisma, now: () => new Date('2026-10-03T00:00:00.000Z'),
      quote: quoteFn, fetchMetering };
    fetchMetering.mockResolvedValueOnce({ ...usage,
      billingCompleteness: { state: 'unresolved', unresolvedPaidAttempts: '1' } });
    await expect(prepareBillingCycleClose(params, deps))
      .rejects.toMatchObject({ message: 'BILLING_CYCLE_LEDGER_COVERAGE_UNRESOLVED' });
    fetchMetering.mockResolvedValueOnce({ ...usage, lines: [{ ...usage.lines[0],
      selectedProviderCost: null }] });
    await expect(prepareBillingCycleClose(params, deps))
      .rejects.toMatchObject({ message: 'BILLING_CYCLE_PAID_COST_MISSING' });
    const [first, replay] = await Promise.all([
      prepareBillingCycleClose(params, deps), prepareBillingCycleClose(params, deps),
    ]);
    expect(replay).toEqual(first);
    expect(await db.prisma.billingCustomerCycle.count({ where: {
      serviceId, orgId, teamId, billingMonth: '2026-09',
    } })).toBe(1);
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const detail = await getBillingCycleDetail(viewer, first.cycleId,
      { prisma: db.prisma });
    expect(detail.usage_lines[0]).toMatchObject({
      raw_units: { input: '100', cached_input: '25', output: '50', total: '175' },
      customer_charge: { amount: '13', currency: 'USD' }, credits_consumed: null,
    });
  });
});
