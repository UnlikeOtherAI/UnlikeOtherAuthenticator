import { BillingAssignmentScope, BillingCollectionMode, BillingMonthlyChargeBasis, BillingTariffMode, BillingTariffSource } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { billingCycleDetailV2ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { billingCycleSnapshotDigest, type BillingCycleContext } from '../../src/services/billing-cycle-read.service.js';
import { createTestDb } from '../helpers/test-db.js';

export const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

export type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

export let db: TestDb;

export let serviceId: string;

export let orgId: string;

export let teamId: string;

export let ownerId: string;

export let teamManagerId: string;

export let tariffId: string;

export let usageOnlyTariffId: string;

export let serviceIdentifier: string;

export async function recordPaidLiability(month: string, billedTeamId: string,
    cost: string, ratedMicrocredits: bigint, frozenTariffId = usageOnlyTariffId) {
    return db.prisma.billingPaidUsageLiability.create({ data: {
      dispatchId: `dispatch-${randomUUID()}`, receiptId: `receipt-${randomUUID()}`,
      serviceId, providerServiceId: 'model-synthetic', orgId, teamId: billedTeamId,
      userId: ownerId, billingMonth: month, currency: 'USD', tariffId: frozenTariffId,
      frozenMarkupBps: 3000, paymentMode: 'PAY_AS_YOU_GO', rawCostActual: cost,
      ratedQuanta: '0', ratedMicrocredits,
    } });
  }

export async function fetchPaidReceiptSet(scope: { product: string; organisationId: string;
    teamId: string; serviceId: string; billingMonth: string }) {
    const rows = await db.prisma.billingPaidUsageLiability.findMany({ where: {
      serviceId: scope.serviceId, orgId: scope.organisationId,
      teamId: scope.teamId, billingMonth: scope.billingMonth,
    } });
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.dispatchId), Buffer.from(b.dispatchId)));
    const hash = createHash('sha256').update('ledger-paid-receipt-set-v1:paid\n');
    for (const row of rows) hash.update(JSON.stringify([
      row.dispatchId, row.receiptId, row.rawCostActual.toFixed(18),
    ])).update('\n');
    return { contract: 'ledger-paid-receipt-set-v1' as const,
      scope: { billing_product: scope.product, organization_id: scope.organisationId,
        team_id: scope.teamId, billing_month: scope.billingMonth },
      snapshot: { cursor: `mpr_${'a'.repeat(32)}`,
        captured_at: '2026-10-04T00:00:00.000Z', immutable: true as const },
      paid_receipt_count: String(rows.length), paid_receipt_sha256: hash.digest('hex'),
      zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256')
        .update('ledger-paid-receipt-set-v1:zero\n').digest('hex'),
      unresolved_paid_attempts: '0', signature: 'test-boundary-verified-signature'.repeat(4) };
  }

export function context(userId: string): BillingCycleContext {
    return { credential: { service: { id: serviceId, identifier: 'scope-service',
      name: 'Scope Service' } } as BillingCycleContext['credential'],
    actorToken: 'test-signed-actor', endpoint: '/billing/v1/cycles/list',
    request: { product: 'scope-service', organisationId: orgId, teamId, userId } };
  }

export async function insertCycle(month: string, scope: 'team' | 'organisation',
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

export function setupCycleScopeFixture() {
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
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD', usageCurrency: 'USD',
    } });
    tariffId = tariff.id;
    const usageOnlyTariff = await db.prisma.billingTariff.create({ data: {
      serviceId, key: 'usage-only', version: 1, name: 'Usage only',
      mode: BillingTariffMode.STANDARD, collectionMode: BillingCollectionMode.MANUAL,
      markupBps: 3000, monthlyAmountMinor: 0n,
      monthlyChargeBasis: BillingMonthlyChargeBasis.FLAT, currency: 'USD', usageCurrency: 'USD',
    } });
    usageOnlyTariffId = usageOnlyTariff.id;
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
}
