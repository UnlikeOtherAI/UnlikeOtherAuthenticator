import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { budgetScopeTotals } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { captureTestOrganisationFinancialBinding } from '../helpers/organisation-financial-binding.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('credit budget UTC windows', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const scope = { product: 'nessie', orgId: randomUUID(), teamId: randomUUID(),
    scopeType: 'team', scopeId: randomUUID() };

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
    await db.prisma.user.create({ data: { id: 'timezone-user', email: 'timezone@example.test', userKey: 'timezone@example.test' } });
    await db.prisma.organisation.create({ data: { id: scope.orgId, ownerId: 'timezone-user', name: 'Timezones',
      slug: 'timezones', domain: 'timezone.example.test' } });
    await db.prisma.team.create({ data: { id: scope.teamId, orgId: scope.orgId, name: 'One', slug: 'one' } });
    await db.prisma.billingService.create({ data: { id: 'timezone-service', identifier: 'nessie', name: 'Nessie' } });
    await db.prisma.billingTariff.create({ data: { id: 'timezone-tariff', serviceId: 'timezone-service', key: 'prepaid',
      name: 'Prepaid', version: 1, mode: 'AT_COST', collectionMode: 'NONE', markupBps: 0,
      currency: 'USD', usagePaymentMode: 'PREPAID' } });
    const binding = await captureTestOrganisationFinancialBinding(db.prisma, scope.orgId);
    for (const [at, amount] of [
      ['2026-09-30T23:59:59.999Z', 100n],
      ['2026-10-01T00:00:00.000Z', 50n],
      ['2026-11-01T00:00:00.000Z', 20n],
    ] as const) {
      const dispatchId = randomUUID();
      await db.prisma.billingCreditBudgetDispatch.create({ data: {
        ...binding, dispatchId, contextDigest: 'a'.repeat(64), reservedMicrocredits: amount,
        serviceId: 'timezone-service', providerServiceId: 'timezone-provider',
        orgId: scope.orgId, teamId: scope.teamId, userId: 'timezone-user',
        billingMonth: at.slice(0, 7), currency: 'USD', tariffId: 'timezone-tariff',
        frozenMarkupBps: 0, tariffMode: 'AT_COST', paymentMode: 'PREPAID',
      } });
      await db.prisma.billingCreditBudgetDispatchScope.create({ data: {
        ...scope, dispatchId, occurredAt: new Date(at),
      } });
    }
  });

  afterAll(async () => { await db?.cleanup(); vi.unstubAllEnvs(); });

  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu'])(
    'includes only holds inside the UTC month in %s', async (zone) => {
      const totals = await db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        return budgetScopeTotals(tx, scope, 'monthly', new Date('2026-10-15T12:00:00.000Z'), {
          // This case verifies local window accounting; absent external proof
          // must still deny admission rather than claiming a verified history.
          fetchProof: async () => { throw new Error('EXTERNAL_PROOF_UNAVAILABLE'); },
        });
      });
      expect(totals).toMatchObject({ spent: 0n, held: 50n, unknown: 0n, historicalComplete: false });
    },
  );
});
