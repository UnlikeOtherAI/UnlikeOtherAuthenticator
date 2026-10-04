import { createHash } from 'node:crypto';
import { BillingAppKeyPurpose, BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  finalizePrepaidDispatch, getLedgerDispatchDecision, reservePrepaidDispatch,
} from '../../src/services/billing-prepaid-reservation.service.js';
import { assertPrepaidUsageCovered } from '../../src/services/billing-prepaid-coverage.service.js';
import { readCycleCreditEvidence } from '../../src/services/billing-cycle-credit-evidence.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { budgetScopeTotals, releaseBudgetDispatch, reserveBudgetDispatch } from
  '../../src/services/billing-credit-budget-dispatch.service.js';
import { recordPaidUsageLiability } from '../../src/services/billing-paid-liability.service.js';
import { listCreditBudgets, putCreditBudget, registerNativeBudgetScope } from
  '../../src/services/billing-credit-budget-management.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

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
let signingKey: KeyLike;
let actorCredential: VerifiedBillingAppKey;
const issuer = 'https://authentication.unlikeotherai.com';
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

async function delegation(overrides: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tv: 0, email: 'prepaid@example.com', source_domain: 'deepwater.example.com',
    azp: 'deepwater.example.com', product: 'deepwater', scope: 'ai.invoke',
    active: { orgId: ids.org, teamId: ids.team },
    org: { org_id: ids.org, org_role: 'owner', teams: [ids.team],
      team_roles: { [ids.team]: 'admin' } }, ...overrides,
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'prepaid-test-key' })
    .setIssuer(issuer).setAudience('https://ledger.example.com').setSubject(ids.user)
    .setJti(`prepaid-${issuedAt}`).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 45)
    .sign(signingKey);
}

function admissionInput(dispatchId: string) {
  return { dispatchId, requestFingerprint: 'b'.repeat(64),
    dispatchStartedAt: '2026-10-04T12:00:00.000Z', product: 'deepwater',
    providerServiceId: 'openai', organisationId: ids.org, teamId: ids.team,
    userId: ids.user, rawCostBound: '0.00000001', currency: 'USD' };
}

function beforeFinalAdmission(action: () => Promise<unknown>) {
  let transactions = 0;
  const guarded = new Proxy(prisma, {
    get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property);
      return async (...args: Parameters<PrismaClient['$transaction']>) => {
        transactions += 1;
        if (transactions === 3) await action();
        return Reflect.apply(target.$transaction, target, args);
      };
    },
  });
  return { prisma: guarded, count: () => transactions };
}

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
    await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
      (id, org_id, user_id, domain, role, updated_at)
      VALUES ('org-member-prepaid', ${ids.org}, ${ids.user}, 'prepaid.example.com', 'owner', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
      (id, team_id, user_id, team_role, updated_at)
      VALUES ('team-member-prepaid', ${ids.team}, ${ids.user}, 'admin', CURRENT_TIMESTAMP)`);
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
  await prisma.billingTariffTermEvent.create({ data: {
    serviceId: ids.service, source: 'SERVICE_DEFAULT', scopeKey: ids.service,
    effectiveFromMonth: '2026-10', tariffId: ids.tariff, reason: 'Synthetic admission proof',
  } });
}

async function reserveFixture(index: number, cost = '0.00000000013',
  tariffId = ids.tariff, reservedMicrocredits = 1n, options: {
    serviceId?: string; keyId?: string; startedAt?: Date;
  } = {}) {
  const startedAt = options.startedAt ?? new Date('2026-10-04T12:00:00.000Z');
  return prisma.billingPrepaidReservation.create({ data: {
    dispatchId: `dispatch-prepaid-${index}`, requestFingerprint: 'a'.repeat(64),
    creditAccountId: ids.credit,
    tariffId, serviceId: options.serviceId ?? ids.service, providerServiceId: 'openai',
    appKeyId: options.keyId ?? ids.key, orgId: ids.org, teamId: ids.team, userId: ids.user,
    billingMonth: startedAt.toISOString().slice(0, 7), dispatchStartedAt: startedAt,
    currency: 'USD', rawCostBound: cost, reservedMicrocredits,
    events: { create: { kind: 'RESERVED', amountMicrocredits: reservedMicrocredits } },
  } });
}

describe.skipIf(!enabled)('prepaid dispatch liability in PostgreSQL', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    signingKey = pair.privateKey;
    actorCredential = {
      id: 'billing-key-prepaid-rating', purpose: BillingAppKeyPurpose.ENTITLEMENT,
      actorIssuer: issuer, actorAudience: `${issuer}/billing/v1/effective-tariff`,
      actorKeyId: 'prepaid-test-key', actorPublicJwk: {
        ...await exportJWK(pair.publicKey), kid: 'prepaid-test-key', alg: 'RS256', use: 'sig',
      }, checkoutReturnOrigins: [], service: {
        id: ids.service, identifier: 'deepwater', name: 'DeepWater',
      },
    };
    const jwk = await exportJWK(pair.privateKey);
    Object.assign(jwk, { kid: 'prepaid-test-key', alg: 'RS256', use: 'sig' });
    process.env.PUBLIC_BASE_URL = issuer;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(jwk);
    resetAccessTokenKeyCache();
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    await seed();
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (cleanup) await cleanup();
  });

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
    const tariff = await prisma.billingTariff.findUniqueOrThrow({ where: { id: ids.tariff } });
    const creditEvidence = await readCycleCreditEvidence(prisma, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: '2026-10', payer: BillingAssignmentScope.TEAM,
      tariff, ratedAmount: '0.0000000013', rawLines: [{
        billingDisposition: 'paid', selectedProviderCost: '0.0000000013',
      }] as never,
    });
    expect(creditEvidence).toMatchObject({ covered: true,
      consumed_microcredits: '2', funded_debit_microcredits: '2' });
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
    expect(await prisma.billingPaidUsageLiability.count()).toBe(0);
    expect((await prisma.billingCreditBudgetLegacyLiability.aggregate({
      _sum: { ratedMicrocredits: true },
    }))._sum.ratedMicrocredits).toBe(2n);
  });

  it('projects one cumulative-rated PAYG liability into a finite team cap', async () => {
    const originalCutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({
      where: { id: 1 },
    });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-01T00:00:00.000Z') } });
    const policy = await prisma.billingCreditBudgetPolicy.create({ data: {
      product: 'deepwater', orgId: ids.org, teamId: ids.team,
      scopeType: 'team', scopeId: ids.team, period: 'monthly', mode: 'enforce',
      limitMicrocredits: 12n, warnThresholdPercent: 80,
      blockHumansWhenOver: true, degradeModel: null, degradeProvider: null,
    } });
    try {
      for (let index = 0; index < 10; index += 1) {
        const dispatchId = `dispatch-forward-${index}`;
        const startedAt = new Date('2026-10-04T18:00:00.000Z');
        await prisma.$transaction(async (tx) => {
          await reserveBudgetDispatch(tx, { dispatchId, startedAt,
            product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
            orgId: ids.org, teamId: ids.team, userId: ids.user,
            billingMonth: '2026-10', currency: 'USD', tariffId: ids.tariff,
            tariffMode: 'STANDARD', markupBps: 0, paymentMode: 'PAY_AS_YOU_GO',
            rawCostBound: new Prisma.Decimal('0.00000000013'),
            context: { contextId: `ctx-${index}`, originProduct: 'deepwater',
              originSourceDomain: 'deepwater.example.com', projectId: null, runId: null },
          });
          await recordPaidUsageLiability(tx, { dispatchId,
            receiptId: `receipt-forward-${index}`,
            actual: new Prisma.Decimal('0.00000000013') });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
      const forward = await prisma.billingPaidUsageLiability.aggregate({
        _sum: { ratedMicrocredits: true },
      });
      expect(forward._sum.ratedMicrocredits).toBe(2n);
      expect((await prisma.billingPaidRatingBucket.findUniqueOrThrow({ where: {
        ratingScopeKey: `payg:${createHash('sha256').update(JSON.stringify([
          ids.org, ids.team, 'USD',
        ])).digest('hex')}`,
      } })).ratedMicrocredits).toBe(2n);
      const totals = await prisma.$transaction((tx) => budgetScopeTotals(tx, {
        product: 'deepwater', orgId: ids.org, teamId: ids.team,
        scopeType: 'team', scopeId: ids.team,
      }, 'monthly', new Date('2026-10-04T18:00:00.000Z')));
      expect(totals.spent).toBe(4n); // Two already charged legacy credits + two forward.
      await prisma.billingCreditBudgetPolicy.update({ where: { id: policy.id },
        data: { limitMicrocredits: 4n, version: { increment: 1 } } });
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        dispatchId: 'dispatch-forward-denied',
        startedAt: new Date('2026-10-04T18:00:00.000Z'),
        product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
        orgId: ids.org, teamId: ids.team, userId: ids.user,
        billingMonth: '2026-10', currency: 'USD', tariffId: ids.tariff,
        tariffMode: 'STANDARD', markupBps: 0, paymentMode: 'PAY_AS_YOU_GO',
        rawCostBound: new Prisma.Decimal('0.00000000013'), context: null,
      }))).rejects.toThrow('BUDGET_CREDITS_EXHAUSTED');
    } finally {
      await prisma.billingCreditBudgetPolicy.delete({ where: { id: policy.id } });
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: originalCutover.occurredAt } });
    }
  });

  it('uses one prepaid account carry across services, a month boundary, and a late legacy receipt', async () => {
    const otherService = 'svc_prepaid_rating_other';
    const otherTariff = 'tariff_prepaid_rating_other';
    const otherKey = 'ledger_key_prepaid_rating_other';
    const otherSecret = `uoa_ledger_${'c'.repeat(43)}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
        (id, identifier, name, tariff_history_from_month, updated_at)
        VALUES (${otherService}, 'deeptest', 'DeepTest', '2026-10', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO billing_tariffs
        (id, service_id, key, version, name, mode, collection_mode,
          markup_bps, currency, usage_payment_mode)
        VALUES (${otherTariff}, ${otherService}, 'prepaid', 1, 'Prepaid', 'STANDARD',
          'NONE', 1000, 'USD', 'PREPAID')`);
      await tx.billingLedgerRuntimeKey.create({ data: {
        id: otherKey, serviceId: otherService,
        secretDigest: createHash('sha256').update(otherSecret).digest('hex'),
        keyPrefix: otherSecret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
        sourceDomain: 'deeptest.example.com', createdByEmail: 'admin@example.com',
      } });
    });
    const cutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({ where: { id: 1 } });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-04T13:00:00.000Z') } });
    try {
      await reserveFixture(300); // Pre-cutover request intentionally settles after forward receipts.
      const opening = (await prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: ids.credit },
      })).balanceMicrocredits;
      const settleForward = async (index: number, inNovember: boolean, other: boolean) => {
        const startedAt = new Date(inNovember ? '2026-11-01T00:00:01.000Z'
          : '2026-10-04T18:00:00.000Z');
        const serviceId = other ? otherService : ids.service;
        const tariffId = other ? otherTariff : ids.tariff;
        const keyId = other ? otherKey : ids.key;
        const dispatchId = `dispatch-prepaid-${index}`;
        await reserveFixture(index, '0.00000000013', tariffId, 1n,
          { serviceId, keyId, startedAt });
        await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
          dispatchId, startedAt, product: other ? 'deeptest' : 'deepwater',
          serviceId, providerServiceId: 'openai', orgId: ids.org, teamId: ids.team,
          userId: ids.user, billingMonth: startedAt.toISOString().slice(0, 7),
          currency: 'USD', tariffId, tariffMode: 'STANDARD',
          markupBps: other ? 1000 : 0, paymentMode: 'PREPAID',
          rawCostBound: new Prisma.Decimal('0.00000000013'), context: null,
        }));
        const settled = await finalizePrepaidDispatch({
          runtimeSecret: other ? otherSecret : secret,
          dispatchId, receiptId: `receipt-prepaid-${index}`,
          kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD',
        }, { prisma });
        const liability = await prisma.billingPaidUsageLiability.findUniqueOrThrow({
          where: { dispatchId },
        });
        expect(settled.debited_microcredits).toBe(liability.ratedMicrocredits.toString());
        expect(liability.billingMonth).toBe(inNovember ? '2026-11' : '2026-10');
        expect(liability.creditAccountId).toBe(ids.credit);
      };
      for (let index = 0; index < 4; index += 1) {
        await settleForward(400 + index, false, index % 2 === 1);
      }
      const late = await finalizePrepaidDispatch({ runtimeSecret: secret,
        dispatchId: 'dispatch-prepaid-300', receiptId: 'receipt-prepaid-300',
        kind: 'settle', rawCostActual: '0.00000000013', currency: 'USD' }, { prisma });
      expect(late.debited_microcredits).toBe('0');
      for (let index = 0; index < 8; index += 1) {
        await settleForward(404 + index, true, index % 2 === 0);
      }
      const liability = await prisma.billingPaidUsageLiability.aggregate({
        where: { creditAccountId: ids.credit }, _sum: { ratedMicrocredits: true },
      });
      const forwardRated = liability._sum.ratedMicrocredits ?? 0n;
      expect(forwardRated).toBeGreaterThan(0n);
      const old = await prisma.billingPrepaidRatingBucket.findUniqueOrThrow({
        where: { creditAccountId: ids.credit },
      });
      const forward = await prisma.billingPaidRatingBucket.findUniqueOrThrow({
        where: { ratingScopeKey: `prepaid:${ids.credit}` },
      });
      expect(forward.ratedMicrocredits).toBe(forwardRated);
      expect(old.debitedMicrocredits).toBe(2n);
      expect((await prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: ids.credit },
      })).balanceMicrocredits).toBe(opening - forwardRated);
      expect((await prisma.billingPaidUsageLiability.aggregate({
        where: { creditAccountId: ids.credit, billingMonth: '2026-11' },
        _sum: { ratedMicrocredits: true },
      }))._sum.ratedMicrocredits).toBe(forwardRated);
    } finally {
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: cutover.occurredAt } });
    }
  });

  it('registers a signed native run before spend and enforces a credit cap without historical guesses', async () => {
    const scope = { product: 'deepwater', organization_id: ids.org, team_id: ids.team,
      scope_type: 'run' as const, scope_id: 'run-pre-spend-budget',
      created_at: '2026-10-04T17:00:00.000Z', owner_sub: ids.user };
    const signActor = (audience: string, nativeScope?: typeof scope) => new SignJWT({
      product: 'deepwater', organisation_id: ids.org, team_id: ids.team,
      tv: 0, ...(nativeScope ? { native_scope: nativeScope } : {}),
    }).setProtectedHeader({ alg: 'RS256', kid: 'prepaid-test-key', typ: 'uoa-actor+jwt' })
      .setIssuer(issuer).setAudience(`${issuer}${audience}`).setSubject(ids.user)
      .setJti(`budget-${crypto.randomUUID()}`).setIssuedAt()
      .setExpirationTime('45s').sign(signingKey);
    const makeAuth = async (audience: string, nativeScope?: typeof scope) => ({
      credential: actorCredential, actorToken: await signActor(audience, nativeScope),
      request: { product: 'deepwater', organisationId: ids.org,
        teamId: ids.team, userId: ids.user },
    });
    const originalCutover = await prisma.billingCreditBudgetCutover.findUniqueOrThrow({
      where: { id: 1 },
    });
    await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
      data: { occurredAt: new Date('2026-10-04T16:00:00.000Z') } });
    try {
      await expect(registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes'), scope, { prisma },
      )).rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      expect(await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', scope), scope, { prisma },
      )).toMatchObject({ status: 'registered', scope_id: scope.scope_id });
      expect(await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', scope), scope, { prisma },
      )).toMatchObject({ status: 'registered' });
      const write = { product: scope.product, organization_id: scope.organization_id,
        team_id: scope.team_id, scope_type: scope.scope_type, scope_id: scope.scope_id,
        period: 'per_run' as const, mode: 'enforce' as const,
        limit_credits: '0.000001', warn_threshold_percent: 80,
        block_humans_when_over: false, degrade_model: null, degrade_provider: null };
      const policy = await putCreditBudget(await makeAuth('/billing/v1/credit-budgets'),
        write, { prisma, now: new Date('2026-10-04T18:00:00.000Z') });
      expect(policy).toMatchObject({ evidence_complete: true,
        spent_credits: '0', held_credits: '0', remaining_credits: '0.000001' });
      const listed = await listCreditBudgets(await makeAuth('/billing/v1/credit-budgets'),
        { prisma, now: new Date('2026-10-04T18:00:00.000Z') });
      expect(listed.budgets).toEqual([expect.objectContaining({
        policy_id: policy.policy_id, scope_id: scope.scope_id,
      })]);
      const child = { ...scope, scope_id: 'run-child-pre-spend-budget',
        created_at: '2026-10-04T17:01:00.000Z' };
      await registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', child), child, { prisma });
      const admission = { startedAt: new Date('2026-10-04T18:00:00.000Z'),
        product: 'deepwater', serviceId: ids.service, providerServiceId: 'openai',
        orgId: ids.org, teamId: ids.team, userId: ids.user, billingMonth: '2026-10',
        currency: 'USD', tariffId: ids.tariff, tariffMode: 'STANDARD' as const,
        markupBps: 0, paymentMode: 'PAY_AS_YOU_GO' as const,
        rawCostBound: new Prisma.Decimal('0.00000000013'), context: {
          contextId: 'ctx-child-pre-spend-budget', originProduct: 'deepwater',
          originSourceDomain: 'deepwater.example.com', projectId: null,
          runId: child.scope_id, runStartedAt: child.created_at, runOwnerSub: ids.user,
          budgetRunId: scope.scope_id, budgetRunStartedAt: scope.created_at,
          budgetRunOwnerSub: ids.user,
        } };
      await prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-first',
      }));
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-over-cap',
      }))).rejects.toThrow('BUDGET_CREDITS_EXHAUSTED');
      await expect(prisma.$transaction((tx) => reserveBudgetDispatch(tx, {
        ...admission, dispatchId: 'dispatch-child-wrong-birth',
        context: { ...admission.context, budgetRunStartedAt: child.created_at },
      }))).rejects.toThrow('BUDGET_NATIVE_SCOPE_MISMATCH');
      await prisma.$transaction((tx) => releaseBudgetDispatch(tx, 'dispatch-child-first'));
      await expect(registerNativeBudgetScope(
        await makeAuth('/billing/v1/credit-budgets/scopes', {
          ...scope, created_at: '2026-10-04T17:01:00.000Z',
        }), { ...scope, created_at: '2026-10-04T17:01:00.000Z' }, { prisma },
      )).rejects.toThrow('BUDGET_NATIVE_SCOPE_CONFLICT');
    } finally {
      await prisma.billingCreditBudgetPolicy.deleteMany({ where: {
        product: scope.product, orgId: ids.org, scopeType: 'run', scopeId: scope.scope_id,
      } });
      await prisma.billingCreditBudgetNativeScope.deleteMany({ where: {
        product: scope.product, orgId: ids.org, scopeType: 'run',
        scopeId: { in: [scope.scope_id, 'run-child-pre-spend-budget'] },
      } });
      await prisma.billingCreditBudgetCutover.update({ where: { id: 1 },
        data: { occurredAt: originalCutover.occurredAt } });
    }
  });

  it('keeps a manager-created run cap owned by its captured run owner', async () => {
    const member = 'usr_prepaid_budget_member';
    const runId = 'run-manager-created-member-budget';
    const scope = { product: 'deepwater', organization_id: ids.org, team_id: ids.team,
      scope_type: 'run' as const, scope_id: runId,
      created_at: '2026-10-04T18:00:00.000Z', owner_sub: member };
    const auth = async (subject: string, endpoint: string, nativeScope?: typeof scope) => ({
      credential: actorCredential,
      actorToken: await new SignJWT({ product: 'deepwater', organisation_id: ids.org,
        team_id: ids.team, tv: 0,
        ...(nativeScope ? { native_scope: nativeScope } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'prepaid-test-key', typ: 'uoa-actor+jwt' })
        .setIssuer(issuer).setAudience(`${issuer}${endpoint}`).setSubject(subject)
        .setJti(`budget-${crypto.randomUUID()}`).setIssuedAt()
        .setExpirationTime('45s').sign(signingKey),
      request: { product: 'deepwater', organisationId: ids.org,
        teamId: ids.team, userId: subject },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`INSERT INTO users (id, email, user_key, name)
        VALUES (${member}, 'budget-member@example.com', 'budget-member@example.com', 'Budget Member')`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
        (id, org_id, user_id, domain, role, updated_at)
        VALUES ('org-member-budget', ${ids.org}, ${member}, 'prepaid.example.com', 'member', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
        (id, team_id, user_id, team_role, updated_at)
        VALUES ('team-member-budget', ${ids.team}, ${member}, 'member', CURRENT_TIMESTAMP)`);
    });
    try {
      await registerNativeBudgetScope(await auth(member,
        '/billing/v1/credit-budgets/scopes', scope), scope, { prisma });
      const write = { product: scope.product, organization_id: scope.organization_id,
        team_id: scope.team_id, scope_type: scope.scope_type, scope_id: scope.scope_id,
        period: 'per_run' as const, mode: 'enforce' as const,
        limit_credits: '1', warn_threshold_percent: 80,
        block_humans_when_over: true, degrade_model: null, degrade_provider: null };
      const policy = await putCreditBudget(await auth(ids.user,
        '/billing/v1/credit-budgets'), write, { prisma });
      expect((await prisma.billingCreditBudgetPolicy.findUniqueOrThrow({
        where: { id: policy.policy_id },
      })).ownerUserId).toBe(member);
      const listed = await listCreditBudgets(await auth(member,
        '/billing/v1/credit-budgets'), { prisma });
      expect(listed.budgets).toEqual([expect.objectContaining({
        policy_id: policy.policy_id, scope_id: runId,
      })]);
      const tightened = await putCreditBudget(await auth(member,
        '/billing/v1/credit-budgets'), { ...write, limit_credits: '0.5',
        expected_version: policy.version }, { prisma });
      expect(tightened.limit_credits).toBe('0.5');
      await expect(putCreditBudget(await auth(member,
        '/billing/v1/credit-budgets'), { ...write, limit_credits: '2',
        expected_version: tightened.version }, { prisma }))
        .rejects.toThrow('BUDGET_RUN_OWNER_REQUIRED');
    } finally {
      await prisma.billingCreditBudgetPolicy.deleteMany({ where: { scopeId: runId } });
      await prisma.billingCreditBudgetNativeScope.deleteMany({ where: { scopeId: runId } });
      await prisma.$executeRaw(Prisma.sql`DELETE FROM team_members WHERE user_id = ${member}`);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM org_members WHERE user_id = ${member}`);
      await prisma.$executeRaw(Prisma.sql`DELETE FROM users WHERE id = ${member}`);
    }
  });

  it('holds active credit, accepts trusted zero, and tombstones a lost request', async () => {
    await reserveFixture(99);
    const tariff = await prisma.billingTariff.findUniqueOrThrow({ where: { id: ids.tariff } });
    expect((await readCycleCreditEvidence(prisma, {
      orgId: ids.org, teamId: ids.team, serviceId: ids.service,
      billingMonth: '2026-10', payer: BillingAssignmentScope.TEAM,
      tariff, ratedAmount: '0.0000000013', rawLines: [{
        billingDisposition: 'paid', selectedProviderCost: '0.0000000013',
      }] as never,
    })).covered).toBe(false);
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

  it('requires real signed exact-product authority and rejects an immutable replay after epoch revocation', async () => {
    const input = admissionInput('dispatch-auth-replay');
    const token = await delegation();
    const deps = { prisma, now: new Date(input.dispatchStartedAt) };
    await expect(reservePrepaidDispatch({ runtimeSecret: secret,
      delegation: await delegation({ product: 'nessie' }), input }, deps))
      .rejects.toThrow('PREPAID_DELEGATION_MISMATCH');
    const first = await reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps);
    expect(first.payment_mode).toBe('prepaid');
    expect(first.reserved_microcredits).toBe('10');
    expect(first.context_digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await getLedgerDispatchDecision({ runtimeSecret: secret,
      dispatchId: input.dispatchId }, { prisma })).context_digest)
      .toBe(first.context_digest);
    await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 1 } });
    await expect(reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps))
      .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
    await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 0 } });
    await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: input.dispatchId,
      receiptId: 'no-dispatch-auth-replay', kind: 'release' }, { prisma });
  });

  it('refuses both new admission and replay after current team membership revocation', async () => {
    const input = admissionInput('dispatch-member-replay');
    const token = await delegation();
    const deps = { prisma, now: new Date(input.dispatchStartedAt) };
    await reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input }, deps);
    await prisma.teamMember.update({ where: { id: 'team-member-prepaid' }, data: { status: 'REMOVED' } });
    for (const dispatchId of [input.dispatchId, 'dispatch-member-new']) {
      await expect(reservePrepaidDispatch({ runtimeSecret: secret,
        delegation: token, input: { ...input, dispatchId } }, deps))
        .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
    }
    await prisma.teamMember.update({ where: { id: 'team-member-prepaid' }, data: { status: 'ACTIVE' } });
    await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: input.dispatchId,
      receiptId: 'no-dispatch-member-replay', kind: 'release' }, { prisma });
  });

  it('rechecks the credential epoch after resolving the credit account', async () => {
    const guarded = beforeFinalAdmission(() => prisma.user.update({
      where: { id: ids.user }, data: { tokenVersion: 1 },
    }));
    const input = admissionInput('dispatch-revoked-between-admission-steps');
    try {
      await expect(reservePrepaidDispatch({ runtimeSecret: secret,
        delegation: await delegation(), input },
      { prisma: guarded.prisma, now: new Date(input.dispatchStartedAt) }))
        .rejects.toThrow('PREPAID_SUBJECT_NOT_ENTITLED');
      expect(guarded.count()).toBeGreaterThanOrEqual(3);
      expect(await prisma.billingPrepaidReservation.findUnique({
        where: { dispatchId: input.dispatchId },
      })).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: ids.user }, data: { tokenVersion: 0 } });
    }
  });

  it('serializes concurrent admissions without overspending the shared pool', async () => {
    const token = await delegation();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => {
      const input = admissionInput(`dispatch-concurrent-${index}`);
      return reservePrepaidDispatch({ runtimeSecret: secret, delegation: token, input },
        { prisma, now: new Date(input.dispatchStartedAt) });
    }));
    const successful = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(successful.length).toBe(9);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(String(attempt.reason)).toContain('PREPAID_CREDIT_EXHAUSTED');
    }
    const held = await prisma.billingPrepaidReservation.aggregate({
      where: { creditAccountId: ids.credit, status: 'ACTIVE' }, _sum: { reservedMicrocredits: true },
    });
    expect(held._sum.reservedMicrocredits).toBe(90n);
    for (const attempt of successful) {
      if (attempt.status !== 'fulfilled') continue;
      await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: attempt.value.dispatch_id,
        receiptId: `unsent-${attempt.value.dispatch_id}`, kind: 'release' }, { prisma });
    }
  });

  it('refuses a runtime key revoked between the two admission transactions', async () => {
    const guarded = beforeFinalAdmission(() => prisma.billingLedgerRuntimeKey.update({
      where: { id: ids.key }, data: { revokedAt: new Date() },
    }));
    const input = admissionInput('dispatch-runtime-key-revoked');
    await expect(reservePrepaidDispatch({ runtimeSecret: secret,
      delegation: await delegation(), input },
    { prisma: guarded.prisma, now: new Date(input.dispatchStartedAt) }))
      .rejects.toThrow('INVALID_LEDGER_RUNTIME_KEY');
    expect(guarded.count()).toBeGreaterThanOrEqual(3);
    expect(await prisma.billingPrepaidReservation.findUnique({
      where: { dispatchId: input.dispatchId },
    })).toBeNull();
  });
});
