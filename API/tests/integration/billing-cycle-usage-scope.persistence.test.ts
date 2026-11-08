import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope, BillingMonthlyChargeBasis, BillingTariffSource } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';
import { prepareBillingTeamUsageCycle } from '../../src/services/billing-cycle-team-usage.service.js';
import { getBillingCycleDetail } from '../../src/services/billing-cycle-read.service.js';
import { seedCycleScopeFixture } from '../helpers/cycle-scope-fixture.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('captured organisation cycle scope',()=>{
  let f:Awaited<ReturnType<typeof seedCycleScopeFixture>>;
  beforeAll(async()=>{f=await seedCycleScopeFixture();});
  afterAll(async()=>{await f?.db.cleanup();vi.unstubAllEnvs();});
  it('prepares a team usage cycle without a subscription source or current-member inference',
    async () => {
    const {db,serviceId,orgId,teamId,ownerId,teamManagerId,serviceIdentifier,recordPaidLiability,fetchPaidReceiptSet,context}=f;
      const usage = {
        schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
        scope: { organizationId: orgId, teamId, userId: null, month: '2030-02',
          startsAt: '2030-02-01T00:00:00.000Z', endsAt: '2030-03-01T00:00:00.000Z' },
        calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens',
          calls: '1', inputUnits: '100', cachedInputUnits: '0', outputUnits: '50',
          estimatedProviderCost: null, actualProviderCost: '10',
          selectedProviderCost: '10', currency: 'USD', costProvenance: 'actual',
          billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
          originProduct: serviceIdentifier, userId: teamManagerId,
          billingDisposition: 'paid' as const }],
        billingCompleteness: { state: 'complete' as const, unresolvedPaidAttempts: '0' },
        snapshot: { cursor: 'feb-cursor-1', id: 'feb-snapshot-1',
          capturedAt: '2030-03-03T00:00:00.000Z', immutable: true as const,
          sha256: 'f'.repeat(64) },
      };
      const fetchMetering = vi.fn().mockResolvedValue(usage);
      const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [teamId],
        snapshot: { id: 'feb-discovery', cursor: 'feb-discovery',
          capturedAt: '2030-03-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
      const params = { serviceId, organisationId: orgId, teamId,
        billingMonth: '2030-02' };
      const deps = { prisma: db.prisma, now: () => new Date('2030-10-03T00:00:00.000Z'),
        fetchMetering, discoverTeams, fetchPaidReceiptSet };
      await recordPaidLiability('2030-02', teamId, '10', 13_000_000_000n);
      const first = await prepareBillingTeamUsageCycle(params, deps);
      fetchMetering.mockResolvedValueOnce({ ...usage, snapshot: { ...usage.snapshot,
        id: 'feb-snapshot-new-assertion', cursor: 'feb-cursor-new-assertion',
        capturedAt: '2030-10-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
      expect(await prepareBillingTeamUsageCycle(params, deps)).toEqual(first);
      const viewer = context(ownerId);
      viewer.request.product = serviceIdentifier;
      viewer.credential.service.identifier = serviceIdentifier;
      const detail = await getBillingCycleDetail(viewer, first.cycleId,
        { prisma: db.prisma });
      expect(detail).toMatchObject({ scope: { cycle_scope: 'team', payer_scope: 'organisation' },
        subscription_lines: [], credits: { consumed: '13000' },
        usage_lines: [{ customer_charge: { amount: '13' } }],
      });
      await recordPaidLiability('2030-02', teamId, '2', 2_600_000_000n);
      fetchMetering.mockResolvedValue({ ...usage, lines: [{ ...usage.lines[0],
        actualProviderCost: '12', selectedProviderCost: '12' }],
      snapshot: { ...usage.snapshot, id: 'feb-snapshot-late', cursor: 'feb-cursor-late',
        sha256: 'b'.repeat(64) } });
      const revised = await prepareBillingTeamUsageCycle(params, deps);
      expect(revised.cycleId).not.toBe(first.cycleId);
      expect(await db.prisma.billingCustomerCycle.count({ where: {
        serviceId, orgId, teamId, billingMonth: '2030-02',
      } })).toBe(2);
    });


  it('retains a signed historical team identifier after its live Team row is gone',
    async () => {
    const {db,serviceId,orgId,serviceIdentifier,recordPaidLiability,fetchPaidReceiptSet}=f;
      const historicalTeamId = `deleted-ledger-team-${randomUUID()}`;
      expect(await db.prisma.team.findUnique({ where: { id: historicalTeamId } })).toBeNull();
      const fetchMetering = vi.fn().mockResolvedValue({
        schemaVersion: 1, product: serviceIdentifier, groupBy: 'user',
        scope: { organizationId: orgId, teamId: historicalTeamId, userId: null,
          month: '2030-01', startsAt: '2030-01-01T00:00:00.000Z',
          endsAt: '2030-02-01T00:00:00.000Z' },
        calls: '1', lines: [{ serviceId: 'model-synthetic', usageUnit: 'tokens',
          calls: '1', inputUnits: '1', cachedInputUnits: '0', outputUnits: '1',
          estimatedProviderCost: null, actualProviderCost: '1',
          selectedProviderCost: '1', currency: 'USD', costProvenance: 'actual',
          billingProduct: serviceIdentifier, callerProduct: serviceIdentifier,
          originProduct: serviceIdentifier, userId: null, billingDisposition: 'paid' }],
        billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        snapshot: { cursor: 'historical-snapshot', id: 'historical-snapshot',
          capturedAt: '2030-02-03T00:00:00.000Z', immutable: true,
          sha256: 'b'.repeat(64) },
      });
      const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [historicalTeamId],
        snapshot: { id: 'org-historical-snapshot', cursor: 'org-historical-snapshot',
          capturedAt: '2030-02-03T00:00:00.000Z', sha256: 'c'.repeat(64) } });
      await recordPaidLiability('2030-01', historicalTeamId, '1', 1_300_000_000n);
      const result = await prepareBillingTeamUsageCycle({ serviceId,
        organisationId: orgId, teamId: historicalTeamId, billingMonth: '2030-01' },
      { prisma: db.prisma, now: () => new Date('2030-10-03T00:00:00.000Z'),
        fetchMetering, discoverTeams, fetchPaidReceiptSet });
      const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
        where: { id: result.cycleId },
      });
      expect(row.teamId).toBe(historicalTeamId);
      expect(row.orgId).toBe(orgId);
      expect((row.publicSnapshot as Record<string, unknown>).subscription_lines).toEqual([]);
    });


  it('freezes one organisation fee and two separate org-paid team usage cycles', async () => {
    const {db,serviceId,orgId,teamId,ownerId,teamManagerId,tariffId,serviceIdentifier,recordPaidLiability,fetchPaidReceiptSet,context,sourceFor}=f;
    const otherTeamId = `historical-ledger-team-${randomUUID()}`;
    await db.prisma.billingTariffTermEvent.create({ data: {
      serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: orgId,
      effectiveFromMonth: '2030-03', tariffId, reason: 'test_seed',
    } });
    const source = await sourceFor(null);
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2030-03', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
    };
    const teamIds = [teamId, otherTeamId];
    await recordPaidLiability('2030-03', teamId, '1', 1_300_000_000n, tariffId);
    await recordPaidLiability('2030-03', otherTeamId, '2', 2_600_000_000n, tariffId);
    const discoverTeams = vi.fn().mockResolvedValue({ teamIds,
      snapshot: { id: 'march-team-discovery', cursor: 'march-team-discovery',
        capturedAt: '2030-04-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
    const fetchMetering = vi.fn().mockImplementation(async (
      params: { teamId: string },
    ) => ({
      schemaVersion: 1, product: serviceIdentifier, groupBy: 'user',
      scope: { organizationId: orgId, teamId: params.teamId, userId: null,
        month: '2030-03', startsAt: '2030-03-01T00:00:00.000Z',
        endsAt: '2030-04-01T00:00:00.000Z' },
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
        capturedAt: '2030-04-03T00:00:00.000Z', immutable: true as const,
        sha256: 'b'.repeat(64) },
    }));
    const deps = { prisma: db.prisma, now: () => new Date('2030-04-03T00:00:00.000Z'),
      quote: vi.fn().mockResolvedValue(quote), fetchMetering, discoverTeams,
      fetchPaidReceiptSet };
    const orgCycle = await prepareBillingCycleClose({ source, billingMonth: '2030-03' }, deps);
    const teamCycles = await Promise.all(teamIds.map((id) =>
      prepareBillingTeamUsageCycle({ serviceId, organisationId: orgId,
        teamId: id, billingMonth: '2030-03', organisationCycleId: orgCycle.cycleId }, deps)));
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const orgDetail = await getBillingCycleDetail(viewer, orgCycle.cycleId,
      { prisma: db.prisma });
    expect(orgDetail.subscription_lines).toHaveLength(1);
    expect(orgDetail.subscription_lines[0]?.customer_charge.amount_minor).toBe('2000');
    expect(orgDetail.usage_lines).toHaveLength(1);
    expect(orgDetail.usage_lines[0]).toMatchObject({ label: 'Metered usage',
      customer_charge: { amount: '3.9' } });
    expect(JSON.stringify(orgDetail)).not.toContain(otherTeamId);
    expect(JSON.stringify(orgDetail)).not.toMatch(/raw_units|usage_unit|calls|tokens/);
    for (const cycle of [orgCycle, ...teamCycles]) {
      await expect(getBillingCycleDetail(context(teamManagerId), cycle.cycleId, {prisma:db.prisma}))
        .rejects.toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
    }
    expect(teamCycles).toHaveLength(2);
    for (const [index, cycle] of teamCycles.entries()) {
      const row = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
        where: { id: cycle.cycleId },
      });
      expect(row.teamId).toBe(teamIds[index]);
      const snapshot = row.publicSnapshot as unknown as
        typeof billingCycleDetailV2ConformanceFixture;
      expect(snapshot.subscription_lines).toEqual([]);
      expect(snapshot.usage_lines[0]?.customer_charge?.amount)
        .toBe(index === 0 ? '1.3' : '2.6');
      if (index === 0) {
        expect((await getBillingCycleDetail(viewer, cycle.cycleId,
          { prisma: db.prisma })).usage_lines).toHaveLength(1);
      } else {
        expect((await getBillingCycleDetail(viewer,cycle.cycleId,{prisma:db.prisma})).cycle_id).toBe(cycle.cycleId);
      }
    }
  });
});
