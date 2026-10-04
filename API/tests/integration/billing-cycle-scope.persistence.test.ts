import { randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis,
  BillingTariffMode, BillingTariffSource,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { prepareBillingTeamUsageCycle } from '../../src/services/billing-cycle-team-usage.service.js';
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
      tariffHistoryFromMonth: '2026-01',
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
    const usageOnlyTariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'usage-only', version: 1, name: 'Usage only',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 0n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD',
    } });
    await db.prisma.billingTariffTermEvent.create({ data: {
      serviceId, source: BillingTariffSource.SERVICE_DEFAULT, scopeKey: serviceId,
      effectiveFromMonth: '2026-01', tariffId: usageOnlyTariff.id,
      reason: 'test_seed',
    } });
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
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
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
    const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [teamId],
      snapshot: { id: 'org-aug-team-snapshot', cursor: 'org-aug-team-cursor',
        capturedAt: '2026-09-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
    const params = { source, billingMonth: '2026-08' };
    const deps = { prisma: db.prisma, now: () => new Date('2026-09-03T00:00:00.000Z'),
      quote: quoteFn, fetchMetering, discoverTeams };
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
    quoteFn.mockResolvedValue(quote);
    fetchMetering.mockResolvedValue({ ...usage, snapshot: { ...usage.snapshot,
      id: 'snapshot-august-late', cursor: 'cursor-august-late', sha256: 'd'.repeat(64) } });
    const sameFactsNewCursor = await prepareBillingCycleClose(params, deps);
    expect(sameFactsNewCursor).toEqual(first);
    fetchMetering.mockResolvedValue({ ...usage, calls: '1', lines: [{
      serviceId: 'telemetry-synthetic', usageUnit: 'events', calls: '1',
      inputUnits: '0', cachedInputUnits: '0', outputUnits: '0',
      estimatedProviderCost: null, actualProviderCost: null,
      selectedProviderCost: null, currency: null, costProvenance: null,
      billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
      originProduct: serviceIdentifier, userId: ownerId,
      billingDisposition: 'nonbillable' as const,
    }], snapshot: { ...usage.snapshot, id: 'snapshot-august-new-receipt',
      cursor: 'cursor-august-new-receipt', sha256: 'e'.repeat(64) } });
    const revised = await prepareBillingCycleClose(params, deps);
    expect(revised.cycleId).not.toBe(first.cycleId);
    const revisions = await db.prisma.billingCustomerCycle.findMany({ where: {
      serviceId, orgId, teamId: null, billingMonth: '2026-08',
    }, orderBy: { revision: 'asc' } });
    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions[0]?.snapshotSha256).toBe(first.snapshotSha256);
    expect((revisions[1]?.privateEvidence as Record<string, unknown>).previous_cycle_id)
      .toBe(first.cycleId);
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
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
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
        billingDisposition: 'paid' as const,
        breakdown: { thoughtOutputTokens: '5', cacheWrite5mTokens: '20',
          cacheWrite1hTokens: '10', inputTextTokens: '100',
          inputAudioTokens: '0', outputAudioTokens: '0' } }],
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
      raw_units: { input: '100', cached_input: '25', output: '50', total: '205',
        reasoning: '5', cache_write: '30', cache_write_5m: '20',
        cache_write_1h: '10' },
      customer_charge: { amount: '13', currency: 'USD' }, credits_consumed: null,
      modalities: [{ modality: 'input_text', raw_units: '100' },
        { modality: 'input_audio', raw_units: '0' },
        { modality: 'output_audio', raw_units: '0' }],
    });
  });

  it('prepares a team usage cycle without a subscription source or current-member inference',
    async () => {
      const usage = {
        schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
        scope: { organizationId: orgId, teamId, userId: null, month: '2026-02',
          startsAt: '2026-02-01T00:00:00.000Z', endsAt: '2026-03-01T00:00:00.000Z' },
        calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens',
          calls: '1', inputUnits: '100', cachedInputUnits: '0', outputUnits: '50',
          estimatedProviderCost: null, actualProviderCost: '10',
          selectedProviderCost: '10', currency: 'USD', costProvenance: 'actual',
          billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
          originProduct: serviceIdentifier, userId: teamManagerId,
          billingDisposition: 'paid' as const }],
        billingCompleteness: { state: 'complete' as const, unresolvedPaidAttempts: '0' },
        snapshot: { cursor: 'feb-cursor-1', id: 'feb-snapshot-1',
          capturedAt: '2026-03-03T00:00:00.000Z', immutable: true as const,
          sha256: 'f'.repeat(64) },
      };
      const fetchMetering = vi.fn().mockResolvedValue(usage);
      const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [teamId],
        snapshot: { id: 'feb-discovery', cursor: 'feb-discovery',
          capturedAt: '2026-03-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
      const params = { serviceId, organisationId: orgId, teamId,
        billingMonth: '2026-02' };
      const deps = { prisma: db.prisma, now: () => new Date('2026-10-03T00:00:00.000Z'),
        fetchMetering, discoverTeams };
      const first = await prepareBillingTeamUsageCycle(params, deps);
      fetchMetering.mockResolvedValueOnce({ ...usage, snapshot: { ...usage.snapshot,
        id: 'feb-snapshot-new-assertion', cursor: 'feb-cursor-new-assertion',
        capturedAt: '2026-10-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
      expect(await prepareBillingTeamUsageCycle(params, deps)).toEqual(first);
      const viewer = context(ownerId);
      viewer.request.product = serviceIdentifier;
      viewer.credential.service.identifier = serviceIdentifier;
      const detail = await getBillingCycleDetail(viewer, first.cycleId,
        { prisma: db.prisma });
      expect(detail).toMatchObject({ scope: { cycle_scope: 'team', payer_scope: 'team' },
        subscription_lines: [], credits: { consumed: null },
        usage_lines: [{ customer_charge: { amount: '13' } }],
      });
      fetchMetering.mockResolvedValue({ ...usage, lines: [{ ...usage.lines[0],
        actualProviderCost: '12', selectedProviderCost: '12' }],
      snapshot: { ...usage.snapshot, id: 'feb-snapshot-late', cursor: 'feb-cursor-late',
        sha256: 'b'.repeat(64) } });
      const revised = await prepareBillingTeamUsageCycle(params, deps);
      expect(revised.cycleId).not.toBe(first.cycleId);
      expect(await db.prisma.billingCustomerCycle.count({ where: {
        serviceId, orgId, teamId, billingMonth: '2026-02',
      } })).toBe(2);
    });

  it('retains a signed historical team identifier after its live Team row is gone',
    async () => {
      const historicalTeamId = `deleted-ledger-team-${randomUUID()}`;
      expect(await db.prisma.team.findUnique({ where: { id: historicalTeamId } })).toBeNull();
      const fetchMetering = vi.fn().mockResolvedValue({
        schemaVersion: 1, product: serviceIdentifier, groupBy: 'user',
        scope: { organizationId: orgId, teamId: historicalTeamId, userId: null,
          month: '2026-01', startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2026-02-01T00:00:00.000Z' },
        calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens',
          calls: '1', inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
          estimatedProviderCost: null, actualProviderCost: '1',
          selectedProviderCost: '1', currency: 'USD', costProvenance: 'actual',
          billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
          originProduct: serviceIdentifier, userId: null, billingDisposition: 'paid' }],
        billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        snapshot: { cursor: 'historical-snapshot', id: 'historical-snapshot',
          capturedAt: '2026-02-03T00:00:00.000Z', immutable: true,
          sha256: 'b'.repeat(64) },
      });
      const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [historicalTeamId],
        snapshot: { id: 'org-historical-snapshot', cursor: 'org-historical-snapshot',
          capturedAt: '2026-02-03T00:00:00.000Z', sha256: 'c'.repeat(64) } });
      const result = await prepareBillingTeamUsageCycle({ serviceId,
        organisationId: orgId, teamId: historicalTeamId, billingMonth: '2026-01' },
      { prisma: db.prisma, now: () => new Date('2026-10-03T00:00:00.000Z'),
        fetchMetering, discoverTeams });
      const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
        where: { id: result.cycleId },
      });
      expect(row.teamId).toBe(historicalTeamId);
      expect(row.orgId).toBe(orgId);
      expect((row.publicSnapshot as Record<string, unknown>).subscription_lines).toEqual([]);
    });

  it('freezes one organisation fee and two separate org-paid team usage cycles', async () => {
    const otherTeamId = `historical-ledger-team-${randomUUID()}`;
    await db.prisma.billingTariffTermEvent.create({ data: {
      serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: orgId,
      effectiveFromMonth: '2026-03', tariffId, reason: 'test_seed',
    } });
    const responsibility = await db.prisma.billingOrgResponsibility.create({ data: {
      orgId, active: true, assumedAt: new Date('2026-02-01T00:00:00.000Z'),
      assumedByUserId: ownerId, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    } });
    await db.prisma.billingOrgResponsibilityTransition.create({ data: {
      responsibilityId: responsibility.id, orgId, kind: 'ASSUMED',
      effectiveAt: new Date('2026-02-01T00:00:00.000Z'),
      actorUserId: ownerId, source: 'customer_action',
    } });
    const source = { kind: 'manual' as const, id: 'organisation-march-source' };
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2026-03', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
    };
    const teamIds = [teamId, otherTeamId];
    const discoverTeams = vi.fn().mockResolvedValue({ teamIds,
      snapshot: { id: 'march-team-discovery', cursor: 'march-team-discovery',
        capturedAt: '2026-04-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
    const fetchMetering = vi.fn().mockImplementation(async (
      params: { teamId: string },
    ) => ({
      schemaVersion: 1, product: serviceIdentifier, groupBy: 'user',
      scope: { organizationId: orgId, teamId: params.teamId, userId: null,
        month: '2026-03', startsAt: '2026-03-01T00:00:00.000Z',
        endsAt: '2026-04-01T00:00:00.000Z' },
      calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens',
        calls: '1', inputUnits: '10', cachedInputUnits: '0', outputUnits: '10',
        estimatedProviderCost: null,
        actualProviderCost: params.teamId === teamId ? '1' : '2',
        selectedProviderCost: params.teamId === teamId ? '1' : '2',
        currency: 'USD', costProvenance: 'actual',
        billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
        originProduct: serviceIdentifier, userId: null,
        billingDisposition: 'paid' as const }],
      billingCompleteness: { state: 'complete' as const, unresolvedPaidAttempts: '0' },
      snapshot: { cursor: `march-${params.teamId}`, id: `march-${params.teamId}`,
        capturedAt: '2026-04-03T00:00:00.000Z', immutable: true as const,
        sha256: 'b'.repeat(64) },
    }));
    const deps = { prisma: db.prisma, now: () => new Date('2026-04-03T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote), fetchMetering, discoverTeams };
    const orgCycle = await prepareBillingCycleClose({ source, billingMonth: '2026-03' }, deps);
    const teamCycles = await Promise.all(teamIds.map((id) =>
      prepareBillingTeamUsageCycle({ serviceId, organisationId: orgId,
        teamId: id, billingMonth: '2026-03', organisationCycleId: orgCycle.cycleId }, deps)));
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const orgDetail = await getBillingCycleDetail(viewer, orgCycle.cycleId,
      { prisma: db.prisma });
    expect(orgDetail.subscription_lines).toHaveLength(1);
    expect(orgDetail.subscription_lines[0]?.customer_charge.amount_minor).toBe('2000');
    expect(orgDetail.usage_lines).toHaveLength(0);
    expect(teamCycles).toHaveLength(2);
    for (const [index, cycle] of teamCycles.entries()) {
      const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
        where: { id: cycle.cycleId },
      });
      expect(row.teamId).toBe(teamIds[index]);
      const snapshot = row.publicSnapshot as unknown as
        typeof billingCycleDetailV2ConformanceFixture;
      expect(snapshot.subscription_lines).toEqual([]);
      expect(snapshot.usage_lines[0]?.customer_charge.amount)
        .toBe(index === 0 ? '1.3' : '2.6');
      if (index === 0) {
        expect((await getBillingCycleDetail(viewer, cycle.cycleId,
          { prisma: db.prisma })).usage_lines).toHaveLength(1);
      } else {
        await expect(getBillingCycleDetail(viewer, cycle.cycleId,
          { prisma: db.prisma })).rejects.toMatchObject({ statusCode: 404 });
      }
    }
  });
});
