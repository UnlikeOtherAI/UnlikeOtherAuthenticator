import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  finalizePrepaidDispatch, getLedgerDispatchDecision,
} from '../../src/services/billing-prepaid-reservation.service.js';
import { assertPrepaidUsageCovered } from '../../src/services/billing-prepaid-coverage.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ids = {
  user: 'usr_prepaid_rating', org: 'org_prepaid_rating', team: 'team_prepaid_rating',
  service: 'svc_prepaid_rating', tariff: 'tariff_prepaid_rating',
  account: 'acct_prepaid_rating', customer: 'customer_prepaid_rating',
  credit: 'credit_prepaid_rating', key: 'ledger_key_prepaid_rating',
};
const secret = `uoa_ledger_${'a'.repeat(43)}`;
let prisma: PrismaClient;
let cleanup: () => Promise<void>;

async function seed(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'prepaid@example.com', 'prepaid@example.com', 'Prepaid')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "organisations"
      ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'prepaid.example.com', 'Prepaid', 'prepaid', ${ids.user}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "teams"
      ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Prepaid', 'prepaid', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_services"
      ("id", "identifier", "name", "tariff_history_from_month", "updated_at")
      VALUES (${ids.service}, 'deepwater', 'DeepWater', '2026-10', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_tariffs"
      ("id", "service_id", "key", "version", "name", "mode", "collection_mode",
       "markup_bps", "currency", "usage_payment_mode")
      VALUES (${ids.tariff}, ${ids.service}, 'prepaid', 1, 'Prepaid', 'STANDARD',
        'NONE', 0, 'USD', 'PREPAID')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_stripe_accounts"
      ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_prepaid_rating', false, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_stripe_customers"
      ("id", "account_id", "org_id", "team_id", "scope", "scope_key", "updated_at")
      VALUES (${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_credit_accounts"
      ("id", "account_id", "customer_id", "org_id", "team_id", "scope", "scope_key",
       "currency", "balance_microcredits", "updated_at")
      VALUES (${ids.credit}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'TEAM', ${`${ids.org}:${ids.team}`}, 'USD', 100, CURRENT_TIMESTAMP)`);
  });
  await prisma.billingLedgerRuntimeKey.create({ data: {
    id: ids.key, serviceId: ids.service,
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    keyPrefix: secret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
    sourceDomain: 'deepwater.example.com', createdByEmail: 'admin@example.com',
  } });
}

async function reserveFixture(index: number, cost = '0.00000000013',
  tariffId = ids.tariff, reservedMicrocredits = 1n) {
  return prisma.billingPrepaidReservation.create({ data: {
    dispatchId: `dispatch-prepaid-${index}`, requestFingerprint: 'a'.repeat(64),
    creditAccountId: ids.credit,
    tariffId, serviceId: ids.service, providerServiceId: 'openai',
    appKeyId: ids.key, orgId: ids.org, teamId: ids.team, userId: ids.user,
    billingMonth: '2026-10', dispatchStartedAt: new Date('2026-10-04T12:00:00.000Z'),
    currency: 'USD', rawCostBound: cost, reservedMicrocredits,
    events: { create: { kind: 'RESERVED', amountMicrocredits: reservedMicrocredits } },
  } });
}

describe.skipIf(!enabled)('prepaid dispatch liability in PostgreSQL', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    await seed();
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('carries tiny exact costs across receipts and debits only the cumulative delta', async () => {
    for (let index = 0; index < 10; index += 1) {
      await reserveFixture(index);
      const result = await finalizePrepaidDispatch({ runtimeSecret: secret,
        dispatchId: `dispatch-prepaid-${index}`, receiptId: `receipt-prepaid-${index}`,
        kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
      expect(result.status).toBe('SETTLED');
      expect(result.debited_microcredits).toBe(index === 0 || index === 7 ? '1' : '0');
    }
    const bucket = await prisma.billingPrepaidRatingBucket.findUniqueOrThrow({
      where: { creditAccountId: ids.credit },
    });
    expect(bucket.cumulativeRatedQuanta.toFixed(0)).toBe('13000000000000');
    expect(bucket.debitedMicrocredits).toBe(2n);
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits).toBe(98n);
    expect(await prisma.billingCreditEntry.count({
      where: { creditAccountId: ids.credit, sourceType: 'prepaid_provider_receipt' },
    })).toBe(2);
    await expect(assertPrepaidUsageCovered({
      usage: { billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        scope: { organizationId: ids.org, teamId: ids.team, month: '2026-10' },
        lines: [{ billingProduct: 'deepwater', billingDisposition: 'paid',
          selectedProviderCost: '0.0000000013', currency: 'USD' }] } as never,
      serviceId: ids.service, product: 'deepwater', organisationId: ids.org,
      teamId: ids.team, billingMonth: '2026-10',
    }, prisma)).resolves.toBeUndefined();
    const replay = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-0', receiptId: 'receipt-prepaid-0',
      kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
    expect(replay.debited_microcredits).toBe('1');
  });

  it('holds active credit, accepts trusted zero, and tombstones a lost request', async () => {
    await reserveFixture(99);
    await expect(assertPrepaidUsageCovered({
      usage: { billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
        scope: { organizationId: ids.org, teamId: ids.team, month: '2026-10' },
        lines: [{ billingProduct: 'deepwater', billingDisposition: 'paid',
          selectedProviderCost: '0.0000000013', currency: 'USD' }] } as never,
      serviceId: ids.service, product: 'deepwater', organisationId: ids.org,
      teamId: ids.team, billingMonth: '2026-10',
    }, prisma)).rejects.toThrow('PREPAID_RECEIPTS_UNRESOLVED');
    await expect(prisma.billingCreditAccount.update({ where: { id: ids.credit },
      data: { balanceMicrocredits: 0n } })).rejects.toThrow();
    const zero = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-99', receiptId: 'receipt-prepaid-zero',
      kind: 'settle', rawCostActual: '0', currency: 'USD' }, { prisma });
    expect(zero.debited_microcredits).toBe('0');
    const released = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost', receiptId: 'receipt-no-egress',
      kind: 'release' }, { prisma });
    expect(released.status).toBe('RELEASED');
    expect((await getLedgerDispatchDecision({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost' }, { prisma })).payment_mode).toBe('cancelled');
    await expect(finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-lost', receiptId: 'different',
      kind: 'release' }, { prisma })).rejects.toThrow('PREPAID_RECEIPT_CONFLICT');
  });

  it('never debits raw provider cost through an existing free tariff reservation', async () => {
    const freeTariffId = 'tariff_prepaid_free';
    await prisma.$executeRaw(Prisma.sql`INSERT INTO "billing_tariffs"
      ("id", "service_id", "key", "version", "name", "mode", "collection_mode",
       "markup_bps", "currency", "usage_payment_mode")
      VALUES (${freeTariffId}, ${ids.service}, 'free', 1, 'Free', 'FREE',
        'NONE', 0, 'USD', 'PREPAID')`);
    await reserveFixture(100, '0.01', freeTariffId, 0n);
    const before = (await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits;
    const result = await finalizePrepaidDispatch({ runtimeSecret: secret,
      dispatchId: 'dispatch-prepaid-100', receiptId: 'receipt-prepaid-free',
      kind: 'settle', rawCostActual: '0.01', currency: 'USD' }, { prisma });
    expect(result).toMatchObject({ status: 'SETTLED', debited_microcredits: '0' });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.credit },
    })).balanceMicrocredits).toBe(before);
  });
});
