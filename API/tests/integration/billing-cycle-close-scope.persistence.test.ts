import { randomUUID } from 'node:crypto';

import { BillingAppKeyPurpose, BillingAssignmentScope, BillingMonthlyChargeBasis } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';


import { prepareBillingCycleClose } from '../../src/services/billing-cycle-close.service.js';

import { getBillingCycleDetail } from '../../src/services/billing-cycle-read.service.js';
import { seedCycleScopeFixture } from '../helpers/cycle-scope-fixture.js';
import { monthlyCycleAccount } from '../../src/services/billing-cycle-account-binding.service.js';

vi.mock('../../src/services/billing-actor.service.js', () => ({
  verifyBillingActor: vi.fn().mockResolvedValue({}),
}));

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('captured organisation cycle scope',()=>{
  let f:Awaited<ReturnType<typeof seedCycleScopeFixture>>;
  beforeAll(async()=>{f=await seedCycleScopeFixture();});
  afterAll(async()=>{await f?.db.cleanup();vi.unstubAllEnvs();});
  it('freezes a closed quote once and proves zero usage credits from empty coverage', async () => {
    const {db,serviceId,orgId,teamId,ownerId,tariffId,serviceIdentifier,fetchPaidReceiptSet,context,sourceFor}=f;
    const source = await sourceFor(null);
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2030-08', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
    };
    const usage = {
      schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
      scope: { organizationId: orgId, teamId, userId: null, month: '2030-08',
        startsAt: '2030-08-01T00:00:00.000Z', endsAt: '2030-09-01T00:00:00.000Z' },
      calls: '0', lines: [], billingCompleteness: {
        state: 'complete' as const, unresolvedPaidAttempts: '0',
      },
      snapshot: { cursor: 'cursor-august', id: 'snapshot-august',
        capturedAt: '2030-09-03T00:00:00.000Z', immutable: true as const,
        sha256: 'b'.repeat(64) },
    };
    const quoteFn = vi.fn().mockResolvedValue(quote);
    const fetchMetering = vi.fn().mockResolvedValue(usage);
    const discoverTeams = vi.fn().mockResolvedValue({ teamIds: [teamId],
      snapshot: { id: 'org-aug-team-snapshot', cursor: 'org-aug-team-cursor',
        capturedAt: '2030-09-03T00:00:00.000Z', sha256: 'a'.repeat(64) } });
    const params = { source, billingMonth: '2030-08' };
    const deps = { prisma: db.prisma, now: () => new Date('2030-09-03T00:00:00.000Z'),
      quote: quoteFn, fetchMetering, discoverTeams, fetchPaidReceiptSet };
    const first = await prepareBillingCycleClose(params, deps);
    const replay = await prepareBillingCycleClose(params, deps);
    expect(replay).toEqual(first);
    expect(first.amountMinor).toBe(2000n);
    expect(await db.prisma.billingCustomerCycle.count({ where: {
      serviceId, orgId, teamId: null, billingMonth: '2030-08',
    } })).toBe(1);
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const detail = await getBillingCycleDetail(viewer, first.cycleId,
      { prisma: db.prisma });
    expect(detail).toMatchObject({ state: 'pending_reconciliation',
      scope: { cycle_scope: 'organisation', team_id: null }, document_available: false,
      credits: { consumed: '0', status: 'confirmed' },
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
    const nonbillable = await getBillingCycleDetail(viewer, revised.cycleId,
      { prisma: db.prisma });
    expect(nonbillable.usage_lines[0]?.customer_charge?.amount).toBe('0');
    const revisions = await db.prisma.billingCustomerCycle.findMany({ where: {
      serviceId, orgId, teamId: null, billingMonth: '2030-08',
    }, orderBy: { revision: 'asc' } });
    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions[0]?.snapshotSha256).toBe(first.snapshotSha256);
    expect((revisions[1]?.privateEvidence as Record<string, unknown>).previous_cycle_id)
      .toBe(first.cycleId);
  });


  it('holds uncertain paid usage and serializes concurrent close preparation', async () => {
    const {db,serviceId,orgId,teamId,ownerId,tariffId,serviceIdentifier,recordPaidLiability,fetchPaidReceiptSet,context,sourceFor}=f;
    const source = await sourceFor(null);
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId:null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2030-09', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
    };
    const usage = {
      schemaVersion: 1 as const, product: serviceIdentifier, groupBy: 'user' as const,
      scope: { organizationId: orgId, teamId, userId: null, month: '2030-09',
        startsAt: '2030-09-01T00:00:00.000Z', endsAt: '2030-10-01T00:00:00.000Z' },
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
        capturedAt: '2030-10-03T00:00:00.000Z', immutable: true as const,
        sha256: 'c'.repeat(64) },
    };
    const quoteFn = vi.fn().mockResolvedValue(quote);
    const fetchMetering = vi.fn().mockResolvedValue(usage);
    await recordPaidLiability('2030-09', teamId, '10', 13_000_000_000n, tariffId);
    const params = { source, billingMonth: '2030-09' };
    const deps = { prisma: db.prisma, now: () => new Date('2030-10-03T00:00:00.000Z'),
      quote: quoteFn, fetchMetering, fetchPaidReceiptSet,discoverTeams:vi.fn().mockResolvedValue({teamIds:[teamId],snapshot:{id:'org-september',cursor:'org-september',capturedAt:'2030-10-03T00:00:00Z',sha256:'a'.repeat(64)}}) };
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
      serviceId, orgId, teamId:null, billingMonth: '2030-09',
    } })).toBe(1);
    const viewer = context(ownerId);
    viewer.request.product = serviceIdentifier;
    viewer.credential.service.identifier = serviceIdentifier;
    const detail = await getBillingCycleDetail(viewer, first.cycleId,
      { prisma: db.prisma });
    expect(detail.usage_lines[0]).toMatchObject({ label: 'Metered usage',
      customer_charge: { amount: '13', currency: 'USD' }, credits_consumed: '13000' });
    expect(JSON.stringify(detail)).not.toMatch(/raw_units|cache_write|reasoning|model-synthetic/);
    const privateRow = await db.prisma.billingCustomerCycle.findUniqueOrThrow({
      where: { id: first.cycleId },
    });
    expect(JSON.stringify(privateRow.privateEvidence)).toContain('cacheWrite5mTokens');

    // A completed PAYG settlement proves 13,000 credits of rated usage even
    // when the customer paid from an invoice and no funded wallet was debited.
    const {account,wallet}=f;
    const key = await db.prisma.billingAppKey.create({ data: {
      serviceId, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Cycle credit proof', keyPrefix: 'cycle_credit',
      secretDigest: randomUUID(), actorIssuer: 'https://test.example',
      actorAudience: 'https://uoa.example', actorKeyId: randomUUID(),
      actorPublicJwk: { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      checkoutReturnOrigins: ['https://test.example'],
    } });
    const portfolio = await db.prisma.billingCreditPortfolioSnapshot.create({ data: {
      accountId: account.id, creditAccountId: wallet.id, orgId, teamId,
      perspectiveServiceId: serviceId, perspectiveProduct: serviceIdentifier,
      billingMonth: '2030-09', ledgerSnapshotId: 'mup_cycle_credit_september',
      ledgerSnapshotCursor: 'mup_cycle_credit_september',
      capturedAt: new Date('2030-10-03T00:00:00.000Z'), sha256: 'd'.repeat(64),
    } });
    const settlement = await db.prisma.billingCreditUsageSettlement.create({ data: {
      accountId: account.id, creditAccountId: wallet.id, teamId, tariffId,
      serviceId, appKeyId: key.id, billingMonth: '2030-09', currency: 'USD',
    } });
    await db.prisma.$transaction(async (tx) => {
      const adjustment = await tx.billingCreditUsageSettlementAdjustment.create({ data: {
        settlementId: settlement.id, accountId: account.id,
        creditAccountId: wallet.id, serviceId, appKeyId: key.id,
        portfolioSnapshotId: portfolio.id, sequence: 1,
        deltaRatedUsageAmountMicroMinor: 1_300_000_000n,
        deltaCreditsConsumedMicrocredits: 0n,
        deltaRemainingUsageAmountMicroMinor: 1_300_000_000n,
        cumulativeRatedUsageAmountMicroMinor: 1_300_000_000n,
        cumulativeCreditsConsumedMicrocredits: 0n,
        cumulativeRemainingUsageAmountMicroMinor: 1_300_000_000n,
      } });
      await tx.billingCreditUsageAllocation.create({ data: {
        settlementId: settlement.id, adjustmentId: adjustment.id,
        serviceId, appKeyId: key.id, attributedUserId: ownerId,
        deltaRatedUsageAmountMicroMinor: 1_300_000_000n,
        deltaCreditsConsumedMicrocredits: 0n,
        deltaRemainingUsageAmountMicroMinor: 1_300_000_000n,
        cumulativeRatedUsageAmountMicroMinor: 1_300_000_000n,
        cumulativeCreditsConsumedMicrocredits: 0n,
        cumulativeRemainingUsageAmountMicroMinor: 1_300_000_000n,
      } });
    });
    const credited = await prepareBillingCycleClose(params, deps);
    expect(credited.cycleId).not.toBe(first.cycleId);
    const rated = await getBillingCycleDetail(viewer, credited.cycleId,
      { prisma: db.prisma });
    expect(rated.usage_lines[0]?.credits_consumed).toBe('13000');
    expect(rated.credits).toMatchObject({ consumed: '13000',
      opening_balance: '0', closing_balance: '0', status: 'confirmed' });
    expect(JSON.stringify(rated)).not.toMatch(/markup|provider_cost|raw_units|tokens/i);
    const duplicateObservation = await db.prisma.billingCreditPortfolioSnapshot.create({
      data: { accountId: account.id, creditAccountId: wallet.id, orgId, teamId,
        perspectiveServiceId: serviceId, perspectiveProduct: serviceIdentifier,
        billingMonth: '2030-09', ledgerSnapshotId: 'mup_cycle_credit_september_replay',
        ledgerSnapshotCursor: 'mup_cycle_credit_september_replay',
        capturedAt: new Date('2030-10-04T00:00:00.000Z'), sha256: 'e'.repeat(64) },
    });
    await db.prisma.billingCreditUsageSettlementAdjustment.create({ data: {
      settlementId: settlement.id, accountId: account.id,
      creditAccountId: wallet.id, serviceId, appKeyId: key.id,
      portfolioSnapshotId: duplicateObservation.id, sequence: 2,
      deltaRatedUsageAmountMicroMinor: 0n,
      deltaCreditsConsumedMicrocredits: 0n,
      deltaRemainingUsageAmountMicroMinor: 0n,
      cumulativeRatedUsageAmountMicroMinor: 1_300_000_000n,
      cumulativeCreditsConsumedMicrocredits: 0n,
      cumulativeRemainingUsageAmountMicroMinor: 1_300_000_000n,
    } });
    expect(await prepareBillingCycleClose(params, deps)).toEqual(credited);
  });


  it('freezes the captured LIVE wallet with a funded main TEST wallet present',async()=>{
    const {db,orgId,serviceId,tariffId,account,wallet,sourceFor}=f;
    const sandbox=await db.prisma.billingStripeAccount.create({data:{stripeAccountId:account.stripeAccountId,livemode:false}});
    const customer=await db.prisma.billingStripeCustomer.create({data:{accountId:sandbox.id,orgId,teamId:null,scope:'ORGANISATION',scopeKey:orgId}});
    const testWallet=await db.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const row=await tx.billingCreditAccount.create({data:{accountId:sandbox.id,customerId:customer.id,orgId,teamId:null,scope:'ORGANISATION',scopeKey:orgId,currency:'USD',balanceMicrocredits:500n}});
      await tx.billingCreditEntry.create({data:{creditAccountId:row.id,direction:'CREDIT',kind:'ADJUSTMENT',amountMicrocredits:500n,balanceAfterMicrocredits:500n,
        currency:'USD',idempotencyKey:randomUUID(),sourceType:'credit_admin_adjustment',sourceId:randomUUID(),occurredAt:new Date('2030-01-01T00:00:00Z')}});
      return row;
    });
    const source=await sourceFor(null);
    const quote = {
      source, serviceId, tariffId, organisationId: orgId, teamId: null,
      scope: BillingAssignmentScope.ORGANISATION, agreementId: null,
      billingMonth: '2030-12', chargeBasis: BillingMonthlyChargeBasis.FLAT,
      seatPolicy: null, seatChargeTiming: null, amountMinor: 2000n,
      unitAmountMinor: 2000n, uniqueHumanSeats: null, seatMilliseconds: null,
      monthMilliseconds: null, currency: 'USD', baselineCapturedAt: null,
      baselineMemberCount: null, intervals: [], capacityRevisions: [], evidenceIds: [],
      commercialEffectiveAt: null, commercialEndsAt: null, endedAt: null,
    };

    const prepared=await prepareBillingCycleClose({source,billingMonth:'2030-12'},{prisma:db.prisma,now:()=>new Date('2031-01-03T00:00:00Z'),
      quote:vi.fn().mockResolvedValue(quote),discoverTeams:vi.fn().mockResolvedValue({teamIds:[],snapshot:{id:'empty-org',cursor:'empty-org',capturedAt:'2031-01-03T00:00:00Z',sha256:'a'.repeat(64)}})});
    const cycle=await db.prisma.billingCustomerCycle.findUniqueOrThrow({where:{id:prepared.cycleId}});
    expect((cycle.privateEvidence as Record<string,unknown>).wallet_boundary).toMatchObject({account_id:wallet.id,closing_microcredits:'0',status:'confirmed'});
    expect(await monthlyCycleAccount(db.prisma,{orgId,serviceId,teamId:null},source)).toBe(account.id);
    expect(await monthlyCycleAccount(db.prisma,{orgId:'another-org',serviceId,teamId:null},source)).toBeNull();
    expect(await monthlyCycleAccount(db.prisma,{orgId,serviceId,teamId:f.teamId},source)).toBeNull();
    expect(await monthlyCycleAccount(db.prisma,{orgId,serviceId,teamId:null},
      {kind:'manual',id:''})).toBeNull();
    expect(await monthlyCycleAccount(db.prisma,{orgId,serviceId,teamId:null},
      {kind:'unrecognised',id:source.id} as never)).toBeNull();
    expect((await db.prisma.billingCreditAccount.findUniqueOrThrow({where:{id:testWallet.id}})).balanceMicrocredits).toBe(500n);
  });

});
