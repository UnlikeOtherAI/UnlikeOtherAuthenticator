import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { finalizePrepaidDispatch, getLedgerDispatchDecision, reservePrepaidDispatch } from
  '../../src/services/billing-prepaid-reservation.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';

const secret = `uoa_ledger_${'p'.repeat(43)}`;
const serviceId = 'service-payg-finalization';
const runtimeKeyId = 'key-payg-finalization';
const tariffId = 'tariff-payg-finalization';
let prisma: PrismaClient;
let cleanup: (() => Promise<void>) | undefined;
let signingKey: KeyLike;
const issuer = 'https://authentication.unlikeotherai.com';
const originalEnv = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK };

async function reserveAgain(dispatchId: string) {
  const now = Math.floor(Date.now() / 1000);
  const delegation = await new SignJWT({ tv: 0, email: 'payg@example.com', source_domain: 'deepwater.example.com',
    azp: 'deepwater.example.com', product: 'deepwater', scope: 'ai.invoke',
    active: { orgId: 'org-payg', teamId: 'team-payg' },
    org: { org_id: 'org-payg', org_role: 'owner', teams: ['team-payg'],
      team_roles: { 'team-payg': 'admin' } },
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'payg-test' })
    .setIssuer(issuer).setAudience('https://ledger.example.com').setSubject('user-payg')
    .setJti(`payg-${dispatchId}`).setIssuedAt(now).setExpirationTime(now + 45).sign(signingKey);
  return reservePrepaidDispatch({ runtimeSecret: secret, delegation, input: {
    dispatchId, requestFingerprint: 'a'.repeat(64),
    dispatchStartedAt: '2026-10-07T08:00:00.000Z', product: 'deepwater',
    providerServiceId: 'openai', organisationId: 'org-payg', teamId: 'team-payg',
    userId: 'user-payg', rawCostBound: '0.01', currency: 'USD',
  } }, { prisma });
}

async function admit(dispatchId: string, withHold = true) {
  await prisma.billingLedgerDispatchDecision.create({ data: {
    dispatchId, runtimeKeyId, serviceId, providerServiceId: 'openai',
    requestFingerprint: 'a'.repeat(64), status: 'PAY_AS_YOU_GO',
    orgId: 'org-payg', teamId: 'team-payg', userId: 'user-payg',
    billingMonth: '2026-10', dispatchStartedAt: new Date('2026-10-07T08:00:00Z'),
    currency: 'USD', rawCostBound: '0.01',
  } });
  if (withHold) await prisma.billingCreditBudgetDispatch.create({ data: {
    dispatchId, contextDigest: 'b'.repeat(64), serviceId,
    providerServiceId: 'openai', orgId: 'org-payg', teamId: 'team-payg',
    userId: 'user-payg', billingMonth: '2026-10', currency: 'USD',
    tariffId, frozenMarkupBps: 0, tariffMode: 'STANDARD',
    paymentMode: 'PAY_AS_YOU_GO', reservedMicrocredits: 10_000_000n,
  } });
}

function settle(dispatchId: string, receiptId = `receipt-${dispatchId}`, cost = '0.001') {
  return finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId, receiptId,
    kind: 'settle', rawCostActual: cost, currency: 'USD' }, { prisma });
}
function release(dispatchId: string, receiptId = `release-${dispatchId}`) {
  return finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId, receiptId,
    kind: 'release' }, { prisma });
}
function read(dispatchId: string) {
  return getLedgerDispatchDecision({ runtimeSecret: secret, dispatchId }, { prisma });
}

describe.skipIf(!process.env.DATABASE_URL)('PAYG finalization with immutable admission', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    const pair = await generateKeyPair('RS256', { extractable: true });
    signingKey = pair.privateKey;
    process.env.PUBLIC_BASE_URL = issuer;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({
      ...await exportJWK(pair.privateKey), kid: 'payg-test', alg: 'RS256', use: 'sig',
    });
    resetAccessTokenKeyCache();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`INSERT INTO users (id, email, user_key, name)
        VALUES ('user-payg', 'payg@example.com', 'payg@example.com', 'PAYG')`;
      await tx.$executeRaw`INSERT INTO organisations (id, domain, name, slug, owner_id, updated_at)
        VALUES ('org-payg', 'deepwater.example.com', 'PAYG', 'payg', 'user-payg', CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO teams (id, org_id, name, slug, updated_at)
        VALUES ('team-payg', 'org-payg', 'PAYG', 'payg', CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO org_members (id, org_id, user_id, domain, role, updated_at)
        VALUES ('org-member-payg', 'org-payg', 'user-payg', 'deepwater.example.com', 'owner', CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO team_members (id, team_id, user_id, team_role, updated_at)
        VALUES ('team-member-payg', 'team-payg', 'user-payg', 'admin', CURRENT_TIMESTAMP)`;
    });
    await prisma.$executeRaw(Prisma.sql`INSERT INTO billing_services
      (id, identifier, name, tariff_history_from_month, updated_at)
      VALUES (${serviceId}, 'deepwater', 'DeepWater', '2026-10', CURRENT_TIMESTAMP)`);
    await prisma.$executeRaw(Prisma.sql`INSERT INTO billing_tariffs
      (id, service_id, key, version, name, mode, collection_mode,
       markup_bps, currency, usage_payment_mode)
      VALUES (${tariffId}, ${serviceId}, 'payg', 1, 'PAYG', 'STANDARD',
        'NONE', 0, 'USD', 'PAY_AS_YOU_GO')`);
    await prisma.billingLedgerRuntimeKey.create({ data: {
      id: runtimeKeyId, serviceId,
      secretDigest: createHash('sha256').update(secret).digest('hex'),
      keyPrefix: secret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
      sourceDomain: 'deepwater.example.com', createdByEmail: 'operator@example.com',
    } });
  });
  afterAll(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    resetAccessTokenKeyCache();
    await cleanup?.();
  });

  it('settles once, replays the receipt, and preserves the admission record', async () => {
    const id = 'payg-settled';
    await admit(id);
    expect(await reserveAgain(id)).toMatchObject({ payment_mode: 'pay_as_you_go' });
    const before = await prisma.billingLedgerDispatchDecision.findUniqueOrThrow({
      where: { dispatchId: id },
    });
    const first = await settle(id);
    expect(first).toMatchObject({ status: 'SETTLED', debited_microcredits: '0',
      rated_microcredits: '1000000' });
    expect(await settle(id)).toEqual(first);
    expect(await read(id)).toMatchObject({ payment_mode: 'pay_as_you_go',
      status: 'SETTLED', receipt_id: `receipt-${id}`, context_digest: 'b'.repeat(64) });
    expect(await prisma.billingLedgerDispatchDecision.findUniqueOrThrow({
      where: { dispatchId: id },
    })).toEqual(before);
    expect(await prisma.billingPaidUsageLiability.count({ where: { dispatchId: id } })).toBe(1);
    await expect(settle(id, `receipt-${id}`, '0.002')).rejects.toThrow('PAID_RECEIPT_CONFLICT');
    await expect(settle(id, 'other-receipt')).rejects.toThrow('PAID_RECEIPT_CONFLICT');
    await expect(release(id)).rejects.toThrow('PAID_RECEIPT_CONFLICT');
    await expect(reserveAgain(id)).rejects.toThrow('PREPAID_DISPATCH_CONFLICT');
    await expect(prisma.billingLedgerDispatchDecision.update({
      where: { dispatchId: id }, data: { receiptId: 'rewrite' },
    })).rejects.toThrow('ledger dispatch decisions are append-only');
  });

  it('releases once without rewriting admission and refuses settlement afterwards', async () => {
    const id = 'payg-released';
    await admit(id);
    expect(await release(id)).toMatchObject({ status: 'RELEASED', debited_microcredits: '0' });
    expect(await release(id)).toMatchObject({ status: 'RELEASED' });
    expect(await read(id)).toMatchObject({ payment_mode: 'cancelled', status: 'CANCELLED',
      receipt_id: `release-${id}`, context_digest: 'b'.repeat(64) });
    expect(await prisma.billingLedgerDispatchDecision.findUniqueOrThrow({
      where: { dispatchId: id },
    })).toMatchObject({ status: 'PAY_AS_YOU_GO', receiptId: null });
    expect(await prisma.billingCreditBudgetDispatch.findUniqueOrThrow({
      where: { dispatchId: id },
    })).toMatchObject({ status: 'RELEASED' });
    await expect(release(id, 'different-release')).rejects.toThrow('PAID_RECEIPT_CONFLICT');
    await expect(settle(id)).rejects.toThrow('PAID_RECEIPT_CONFLICT');
    await expect(reserveAgain(id)).rejects.toThrow('PREPAID_DISPATCH_CONFLICT');
    expect(await prisma.billingPaidUsageLiability.count({ where: { dispatchId: id } })).toBe(0);
    await expect(prisma.billingLedgerDispatchRelease.update({
      where: { dispatchId: id }, data: { receiptId: 'rewrite' },
    })).rejects.toThrow('ledger dispatch releases are append-only');
    await expect(prisma.billingLedgerDispatchRelease.delete({
      where: { dispatchId: id },
    })).rejects.toThrow('ledger dispatch releases are append-only');
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      return tx.billingLedgerDispatchRelease.findMany();
    })).rejects.toThrow();
  });

  it('serializes competing terminal requests and leaves exactly one outcome', async () => {
    const id = 'payg-race';
    await admit(id);
    const outcomes = await Promise.allSettled([settle(id), release(id)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const result = await read(id);
    expect(['SETTLED', 'CANCELLED']).toContain(result.status);
    const expected = result.status === 'SETTLED' ? 'SETTLED' : 'RELEASED';
    expect(await prisma.billingCreditBudgetDispatch.findUniqueOrThrow({
      where: { dispatchId: id },
    })).toMatchObject({ status: expected });
  });

  it('keeps historical reconciliation and no-admission tombstones intact', async () => {
    await admit('payg-legacy', false);
    await expect(settle('payg-legacy')).rejects.toThrow('LEGACY_PAYG_RECONCILIATION_REQUIRED');
    expect(await release('payg-never-admitted')).toMatchObject({ status: 'RELEASED' });
    expect(await read('payg-never-admitted')).toMatchObject({ payment_mode: 'cancelled',
      status: 'CANCELLED', receipt_id: 'release-payg-never-admitted' });
    await expect(release('payg-never-admitted', 'wrong')).rejects.toThrow('PREPAID_RECEIPT_CONFLICT');
  });
});
