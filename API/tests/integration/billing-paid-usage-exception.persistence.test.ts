import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getPaidUsageException, paidExceptionEvidenceDigest, registerPaidUsageException,
  writeOffPaidUsageException,
} from '../../src/services/billing-paid-usage-exception.service.js';
import { budgetScopeTotals } from '../../src/services/billing-credit-budget-dispatch.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ids = { user: 'usr_paid_exception', org: 'org_paid_exception',
  team: 'team_paid_exception', service: 'svc_paid_exception',
  tariff: 'tariff_paid_exception', key: 'key_paid_exception',
  account: 'account_paid_exception', customer: 'customer_paid_exception',
  credit: 'credit_paid_exception' };
const secret = `uoa_ledger_${'e'.repeat(43)}`;
const bound = new Prisma.Decimal('0.000000001');
const actual = new Prisma.Decimal('0.000000004');
const fingerprint = 'f'.repeat(64);
const contextDigest = 'c'.repeat(64);
let prisma: PrismaClient;
let cleanup: () => Promise<void>;

function evidence(dispatchId: string, receiptId: string) {
  return paidExceptionEvidenceDigest({ dispatchId, receiptId, actual,
    currency: 'USD', requestFingerprint: fingerprint, rawCostBound: bound,
    contextDigest });
}

async function seed() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO users (id, email, user_key, name)
      VALUES (${ids.user}, 'exception@example.com', 'exception@example.com', 'Operator')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO organisations
      (id, domain, name, slug, owner_id, updated_at)
      VALUES (${ids.org}, 'exception.example.com', 'Exception', 'exception',
        ${ids.user}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO teams
      (id, org_id, name, slug, updated_at)
      VALUES (${ids.team}, ${ids.org}, 'Exception', 'exception', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO domain_roles (domain, user_id, role)
      VALUES ('authentication.unlikeotherai.com', ${ids.user}, 'SUPERUSER')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
      (id, identifier, name, tariff_history_from_month, updated_at)
      VALUES (${ids.service}, 'deepwater', 'DeepWater', '2026-10', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_tariffs
      (id, service_id, key, version, name, mode, collection_mode,
        markup_bps, currency, usage_payment_mode)
      VALUES (${ids.tariff}, ${ids.service}, 'exception', 1, 'Exception',
        'STANDARD', 'NONE', 0, 'USD', 'PREPAID')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_stripe_accounts
      (id, stripe_account_id, livemode, updated_at)
      VALUES (${ids.account}, 'acct_paid_exception', false, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_stripe_customers
      (id, account_id, org_id, team_id, scope, scope_key, updated_at)
      VALUES (${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team},
        'TEAM', ${`${ids.org}:${ids.team}`}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_credit_accounts
      (id, account_id, customer_id, org_id, team_id, scope, scope_key,
        currency, balance_microcredits, updated_at)
      VALUES (${ids.credit}, ${ids.account}, ${ids.customer}, ${ids.org},
        ${ids.team}, 'TEAM', ${`${ids.org}:${ids.team}`}, 'USD', 100,
        CURRENT_TIMESTAMP)`);
  });
  await prisma.billingLedgerRuntimeKey.create({ data: {
    id: ids.key, serviceId: ids.service,
    secretDigest: createHash('sha256').update(secret).digest('hex'),
    keyPrefix: secret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
    sourceDomain: 'deepwater.example.com', createdByEmail: 'operator@example.com',
  } });
}

async function createDispatch(dispatchId: string, paymentMode: 'PREPAID' | 'PAY_AS_YOU_GO') {
  const startedAt = new Date('2026-10-04T12:00:00.000Z');
  await prisma.billingCreditBudgetDispatch.create({ data: {
    dispatchId, contextDigest, serviceId: ids.service, providerServiceId: 'openai',
    orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: '2026-10',
    currency: 'USD', tariffId: ids.tariff, frozenMarkupBps: 0,
    tariffMode: 'STANDARD', paymentMode, reservedMicrocredits: 1n,
  } });
  await prisma.billingCreditBudgetDispatchScope.create({ data: {
    dispatchId, product: 'deepwater', orgId: ids.org, teamId: ids.team,
    scopeType: 'team', scopeId: ids.team, occurredAt: startedAt,
  } });
  if (paymentMode === 'PREPAID') {
    await prisma.billingPrepaidReservation.create({ data: {
      dispatchId, requestFingerprint: fingerprint, creditAccountId: ids.credit,
      tariffId: ids.tariff, serviceId: ids.service, providerServiceId: 'openai',
      appKeyId: ids.key, orgId: ids.org, teamId: ids.team, userId: ids.user,
      billingMonth: '2026-10', dispatchStartedAt: startedAt, currency: 'USD',
      rawCostBound: bound, reservedMicrocredits: 1n,
    } });
  } else {
    await prisma.billingLedgerDispatchDecision.create({ data: {
      dispatchId, requestFingerprint: fingerprint, runtimeKeyId: ids.key,
      serviceId: ids.service, providerServiceId: 'openai', orgId: ids.org,
      teamId: ids.team, userId: ids.user, billingMonth: '2026-10',
      dispatchStartedAt: startedAt, currency: 'USD', rawCostBound: bound,
      status: 'PAY_AS_YOU_GO',
    } });
  }
}

describe.skipIf(!enabled)('paid usage operator exception PostgreSQL proof', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    await seed();
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  for (const mode of ['PREPAID', 'PAY_AS_YOU_GO'] as const) {
    it(`holds ${mode} overbound evidence then books gross and waives only excess`, async () => {
      const dispatchId = `dispatch-exception-${mode}`;
      const receiptId = `receipt-exception-${mode}`;
      await createDispatch(dispatchId, mode);
      const digest = evidence(dispatchId, receiptId);
      const registration = { runtimeSecret: secret, dispatchId, receiptId,
        rawCostActual: actual.toFixed(18), currency: 'USD', evidenceDigest: digest };
      await expect(registerPaidUsageException({ ...registration,
        evidenceDigest: '0'.repeat(64) }, { prisma })).rejects.toThrow('EVIDENCE_MISMATCH');
      expect((await registerPaidUsageException(registration, { prisma })).status)
        .toBe('HELD_OPERATOR_RECONCILIATION');
      expect(await getPaidUsageException({ runtimeSecret: secret, dispatchId }, { prisma }))
        .toMatchObject({ receipt_id: receiptId, evidence_digest: digest });
      const operation = { dispatchId, evidenceDigest: digest,
        idempotencyKey: createHash('sha256').update(dispatchId).digest('hex'),
        reason: 'Verified provider receipt exceeded the frozen hold',
        actorUserId: ids.user, actorTokenVersion: 0,
        adminDomain: 'authentication.unlikeotherai.com' };
      await expect(writeOffPaidUsageException({ ...operation,
        actorTokenVersion: 1 }, { prisma }))
        .rejects.toThrow('OPERATOR_REVOKED');
      if (mode === 'PREPAID') {
        await prisma.domainRole.update({ where: {
          domain_userId: { domain: operation.adminDomain, userId: ids.user },
        }, data: { role: 'USER' } });
        await expect(writeOffPaidUsageException(operation, { prisma }))
          .rejects.toThrow('OPERATOR_REVOKED');
        await prisma.domainRole.update({ where: {
          domain_userId: { domain: operation.adminDomain, userId: ids.user },
        }, data: { role: 'SUPERUSER' } });
      }
      const [first, race] = await Promise.allSettled([
        writeOffPaidUsageException(operation, { prisma }),
        writeOffPaidUsageException(operation, { prisma }),
      ]);
      if (first.status === 'rejected') throw first.reason;
      if (race.status === 'rejected') throw race.reason;
      expect(first.status).toBe('fulfilled');
      expect(race.status).toBe('fulfilled');
      const settled = await writeOffPaidUsageException(operation, { prisma });
      expect(settled).toMatchObject({ status: 'WRITTEN_OFF',
        gross_rated_microcredits: '4', collectible_microcredits: '1',
        waived_microcredits: '3' });
      expect(await registerPaidUsageException(registration, { prisma }))
        .toMatchObject({ status: 'WRITTEN_OFF' });
      await expect(writeOffPaidUsageException({ ...operation,
        idempotencyKey: 'a'.repeat(64) }, { prisma }))
        .rejects.toThrow('DECISION_CONFLICT');
      expect((await prisma.billingPaidUsageLiability.findUniqueOrThrow({
        where: { dispatchId },
      })).ratedMicrocredits).toBe(4n);
      await expect(prisma.billingPaidUsageException.update({ where: { dispatchId },
        data: { rawCostActual: '0.000000005' } }))
        .rejects.toThrow('paid usage exception evidence is immutable');
      expect((await prisma.billingCreditBudgetDispatch.findUniqueOrThrow({
        where: { dispatchId },
      })).status).toBe('SETTLED');
      const totals = await prisma.$transaction((tx) => budgetScopeTotals(tx, {
        product: 'deepwater', orgId: ids.org, teamId: ids.team,
        scopeType: 'team', scopeId: ids.team,
      }, 'monthly', new Date('2026-10-04T12:00:00.000Z')));
      expect(totals.spent).toBe(mode === 'PREPAID' ? 4n : 8n);
      if (mode === 'PREPAID') {
        expect((await prisma.billingCreditAccount.findUniqueOrThrow({
          where: { id: ids.credit },
        })).balanceMicrocredits).toBe(99n);
      }
    });
  }
});
