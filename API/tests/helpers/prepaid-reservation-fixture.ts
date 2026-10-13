import { BillingAppKeyPurpose, Prisma, type PrismaClient } from '@prisma/client';
import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';

import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { verifyLedgerBudgetReceiptSet, type BudgetReceiptScope } from '../../src/services/billing-ledger-paid-receipt-proof.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { createTestDb } from '../helpers/test-db.js';

export const enabled = Boolean(process.env.DATABASE_URL);
export const ids = {
  user: 'usr_prepaid_rating', org: 'org_prepaid_rating', team: 'team_prepaid_rating',
  service: 'svc_prepaid_rating', tariff: 'tariff_prepaid_rating',
  account: 'acct_prepaid_rating', customer: 'customer_prepaid_rating',
  credit: 'credit_prepaid_rating', key: 'ledger_key_prepaid_rating',
};
export const secret = `uoa_ledger_${'a'.repeat(43)}`;
export let prisma: PrismaClient;
let cleanup: () => Promise<void>;
export let signingKey: KeyLike;
export let actorCredential: VerifiedBillingAppKey;
export const issuer = 'https://authentication.unlikeotherai.com';
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

export async function delegation(overrides: Record<string, unknown> = {}) {
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

export function admissionInput(dispatchId: string) {
  return { dispatchId, requestFingerprint: 'b'.repeat(64),
    dispatchStartedAt: '2026-10-04T12:00:00.000Z', product: 'deepwater',
    providerServiceId: 'openai', organisationId: ids.org, teamId: ids.team,
    userId: ids.user, rawCostBound: '0.00000001', currency: 'USD' };
}

export async function signedCurrentBudgetProof(scope: BudgetReceiptScope) {
  const [year, month] = scope.billingMonth.split('-').map(Number);
  const born = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const ancestry = await prisma.billingCreditBudgetDispatchScope.findMany({ where: {
    product: scope.product, orgId: scope.organisationId,
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    scopeType: scope.nativeScopeType ?? (scope.budgetScopeType ?? 'team'),
    scopeId: scope.nativeScopeId ??
      (scope.budgetScopeType === 'organization' ? scope.organisationId : scope.teamId ?? ''),
    occurredAt: { gte: born, lt: end },
  }, select: { dispatchId: true } });
  const idsInScope = ancestry.map((row) => row.dispatchId);
  const [holds, forward, legacy] = await Promise.all([
    prisma.billingCreditBudgetDispatch.findMany({ where: {
      dispatchId: { in: idsInScope },
    }, select: { dispatchId: true, status: true } }),
    prisma.billingPaidUsageLiability.findMany({ where: {
      dispatchId: { in: idsInScope },
    }, select: { dispatchId: true, receiptId: true, rawCostActual: true } }),
    prisma.billingCreditBudgetLegacyLiability.findMany({ where: {
      dispatchId: { in: idsInScope },
    }, select: { dispatchId: true, receiptId: true, sourceId: true } }),
  ]);
  const reservations = await prisma.billingPrepaidReservation.findMany({ where: {
    id: { in: legacy.map((row) => row.sourceId) },
  }, select: { id: true, rawCostActual: true } });
  const byReservation = new Map(reservations.map((row) => [row.id, row]));
  const rows = [...forward.map((row) => [row.dispatchId, row.receiptId,
    row.rawCostActual.toFixed(18)]), ...legacy.map((row) => [row.dispatchId,
    row.receiptId, byReservation.get(row.sourceId)?.rawCostActual?.toFixed(18) ?? 'missing'])]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0] ?? ''), Buffer.from(b[0] ?? '')));
  const paid = createHash('sha256').update('ledger-budget-receipt-set-v1:paid\n');
  for (const row of rows) paid.update(JSON.stringify(row)).update('\n');
  const active = holds.filter((row) => row.status === 'ACTIVE').map((row) => row.dispatchId)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const pending = createHash('sha256').update('ledger-budget-receipt-set-v1:pending\n');
  for (const id of active) pending.update(JSON.stringify([id])).update('\n');
  const body = { contract: 'ledger-budget-receipt-set-v1' as const,
    scope: { billing_product: scope.product,
      organization_id: scope.organisationId, team_id: scope.teamId,
      billing_month: scope.billingMonth,
      ...(scope.budgetScopeType ? { budget_scope_type: scope.budgetScopeType } : {}),
      ...(scope.excludeDispatchId ? { exclude_dispatch_id: scope.excludeDispatchId,
        exclude_request_fingerprint: scope.excludeRequestFingerprint!,
        exclude_team_id: scope.excludeTeamId! } : {}),
      ...(scope.nativeScopeType ? { native_scope_type: scope.nativeScopeType,
        native_scope_id: scope.nativeScopeId!, native_born_at: scope.nativeBornAt!,
        ...(scope.nativeOwnerSub ? { native_owner_sub: scope.nativeOwnerSub } : {}) } : {}) },
    snapshot: { cursor: `mpr_${randomUUID().replaceAll('-', '')}`,
      captured_at: new Date().toISOString(), immutable: true as const },
    paid_receipt_count: String(rows.length), paid_receipt_sha256: paid.digest('hex'),
    zero_incremental_count: '0', zero_incremental_sha256: createHash('sha256')
      .update('ledger-budget-receipt-set-v1:zero\n').digest('hex'),
    pending_dispatch_count: String(active.length), pending_dispatch_sha256: pending.digest('hex'),
    unresolved_paid_attempts: '0' };
  const signature = await new CompactSign(Buffer.from(JSON.stringify(body)))
    .setProtectedHeader({ alg: 'RS256', typ: 'ledger-budget-receipt-set+jws',
      kid: 'prepaid-test-key' }).sign(signingKey);
  const keys = createLocalJWKSet({ keys: [actorCredential.actorPublicJwk] });
  return verifyLedgerBudgetReceiptSet({ ...body, signature }, scope, keys);
}

export function beforeFinalAdmission(action: () => Promise<unknown>) {
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
       "markup_bps", "currency", "usage_currency", "usage_payment_mode")
      VALUES (${ids.tariff}, ${ids.service}, 'prepaid', 1, 'Prepaid', 'STANDARD',
        'NONE', 0, 'USD', 'USD', 'PREPAID')`);
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

export async function reserveFixture(index: number, cost = '0.00000000013',
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

export function setupPrepaidFixture() {
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
    // This routed PostgreSQL journey performs many signed-proof reads per transaction.
    const db = await createTestDb({ transactionTimeoutMs: 30_000 });
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
}
