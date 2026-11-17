import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  grantOrganisationCredits, readOrganisationCreditGrants,
} from '../../src/services/billing-credit-admin-grant.service.js';
import {
  paidExceptionEvidenceDigest, registerPaidUsageException, writeOffPaidUsageException,
} from '../../src/services/billing-paid-usage-exception.service.js';
import { captureTestOrganisationFinancialBinding } from '../helpers/organisation-financial-binding.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const adminDomain = 'authentication.unlikeotherai.com';
const stripeAccountId = 'acct_CreditGrantLive';
const ids = { operator: 'usr_grant_operator', member: 'usr_grant_member', org: 'org_credit_grant',
  team: 'team_credit_grant', service: 'svc_credit_grant', tariff: 'tariff_credit_grant',
  key: 'key_credit_grant' };
const runtimeSecret = `uoa_ledger_${'g'.repeat(43)}`;
const operator = { userId: ids.operator, tokenVersion: 0, email: 'grant-operator@example.com', domain: adminDomain };
const reason = 'Launch allowance for the founding team';
const key = (seed: string) => createHash('sha256').update(seed).digest('hex');
let prisma: PrismaClient;
let cleanup: () => Promise<void>;

async function seed() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO users (id, email, user_key, name) VALUES
      (${ids.operator}, ${operator.email}, ${operator.email}, 'Operator'),
      (${ids.member}, 'grant-member@example.com', 'grant-member@example.com', 'Member')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO organisations (id, domain, name, slug, owner_id, updated_at)
      VALUES (${ids.org}, 'grant.example.com', 'Grant Org', 'grant-org', ${ids.member}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO teams (id, org_id, name, slug, updated_at)
      VALUES (${ids.team}, ${ids.org}, 'Grant', 'grant', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO domain_roles (domain, user_id, role) VALUES
      (${adminDomain}, ${ids.operator}, 'SUPERUSER'), (${adminDomain}, ${ids.member}, 'USER')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
      (id, identifier, name, tariff_history_from_month, updated_at)
      VALUES (${ids.service}, 'deepwater', 'DeepWater', '2026-10', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_tariffs
      (id, service_id, key, version, name, mode, collection_mode, markup_bps, currency, usage_currency, usage_payment_mode)
      VALUES (${ids.tariff}, ${ids.service}, 'grant', 1, 'Grant', 'STANDARD', 'NONE', 0, 'USD', 'USD', 'PREPAID')`);
  });
  await prisma.billingLedgerRuntimeKey.create({ data: {
    id: ids.key, serviceId: ids.service, secretDigest: createHash('sha256').update(runtimeSecret).digest('hex'),
    keyPrefix: runtimeSecret.slice(0, 18), ledgerAudience: 'https://ledger.example.com',
    sourceDomain: 'deepwater.example.com', createdByEmail: operator.email,
  } });
}

async function wallet() {
  return prisma.billingCreditAccount.findFirst({ where: { orgId: ids.org, teamId: null, scope: 'ORGANISATION' } });
}

describe.skipIf(!enabled)('platform credit grants PostgreSQL proof', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    vi.stubEnv('ADMIN_AUTH_DOMAIN', adminDomain);
    await seed();
    // Stubs the live account env and records the organisation's live source.
    await captureTestOrganisationFinancialBinding(prisma, ids.org, { stripeAccountId, livemode: true });
  });
  afterAll(async () => { if (cleanup) await cleanup(); vi.unstubAllEnvs(); });

  it('refuses a non-superuser before creating anything, and refuses non-positive amounts', async () => {
    await expect(grantOrganisationCredits({ organisationId: ids.org, credits: '100', reason,
      idempotencyKey: key('member'), actor: { userId: ids.member, tokenVersion: 0,
        email: 'grant-member@example.com', domain: adminDomain } }, { prisma }))
      .rejects.toThrow('BILLING_ADMIN_AUTHORITY_REQUIRED');
    for (const credits of ['0', '-100', '1.5', '10000001']) {
      await expect(grantOrganisationCredits({ organisationId: ids.org, credits, reason,
        idempotencyKey: key(credits), actor: operator }, { prisma }))
        .rejects.toThrow('BILLING_CREDIT_GRANT_AMOUNT_INVALID');
    }
    await expect(grantOrganisationCredits({ organisationId: ids.org, credits: '100', reason: 'short',
      idempotencyKey: key('short'), actor: operator }, { prisma }))
      .rejects.toThrow('BILLING_CREDIT_GRANT_REASON_INVALID');
    expect(await wallet()).toBeNull();
    expect((await readOrganisationCreditGrants(ids.org, { prisma })).credit_account_id).toBeNull();
  });

  it('grants spendable credits once, replays the same key and refuses a reused key', async () => {
    const operation = { organisationId: ids.org, credits: '10000', reason,
      idempotencyKey: key('first-grant'), actor: operator };
    const [first, race] = await Promise.all([
      grantOrganisationCredits(operation, { prisma }), grantOrganisationCredits(operation, { prisma })]);
    expect([first.replayed, race.replayed].sort()).toEqual([false, true]);
    expect(first.grant.id).toBe(race.grant.id);
    expect(first.grant.amount).toEqual({ microcredits: '10000000000', credits: '10000', usd: '10' });
    await expect(grantOrganisationCredits({ ...operation, credits: '20000' }, { prisma }))
      .rejects.toThrow('BILLING_CREDIT_GRANT_KEY_CONFLICT');

    const account = await wallet();
    expect(account?.balanceMicrocredits).toBe(10_000_000_000n);
    const entries = await prisma.billingCreditEntry.findMany({ where: { creditAccountId: account!.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'ADJUSTMENT', direction: 'CREDIT', serviceId: null,
      appKeyId: null, attributedUserId: null, sourceType: 'credit_admin_adjustment', sourceId: first.grant.id,
      amountMicrocredits: 10_000_000_000n, balanceAfterMicrocredits: 10_000_000_000n });
    // The grant opens its own USD lot with nothing paid for it.
    expect(await prisma.billingCreditLot.findUnique({ where: { sourceEntryId: entries[0]!.id } }))
      .toMatchObject({ currency: 'USD', paidAmountMinor: 0n, grantedMicrocredits: 10_000_000_000n,
        remainingMicrocredits: 10_000_000_000n });
    expect(await prisma.billingCreditAdminAdjustment.findUniqueOrThrow({ where: { id: first.grant.id } }))
      .toMatchObject({ createdByUserId: ids.operator, createdByAdminDomain: adminDomain,
        signedAmountMicrocredits: 10_000_000_000n, reason, teamId: null });
    const audit = await prisma.adminAuditLog.findMany({ where: { action: 'billing.credits_granted' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ organisation_id: ids.org, credits: '10000', reason,
      actor_user_id: ids.operator, amount_microcredits: '10000000000' });
    // No payment, checkout or invoice exists for it.
    expect(await prisma.billingCreditTopUpCheckout.count({ where: { creditAccountId: account!.id } })).toBe(0);
    expect(await prisma.billingCreditPaymentInvoice.count({ where: { creditAccountId: account!.id } })).toBe(0);
    // History is immutable.
    await expect(prisma.billingCreditEntry.update({ where: { id: entries[0]!.id },
      data: { amountMicrocredits: 1n } })).rejects.toThrow();
    await expect(prisma.billingCreditAdminAdjustment.update({ where: { id: first.grant.id },
      data: { reason: 'Rewritten afterwards by someone' } })).rejects.toThrow();

    const read = await readOrganisationCreditGrants(ids.org, { prisma });
    expect(read).toMatchObject({ mode: 'live', credit_account_id: account!.id,
      balance: { confirmed: { credits: '10000' }, reserved: { credits: '0' }, spendable: { credits: '10000' } } });
    expect(read.grants).toEqual([expect.objectContaining({ id: first.grant.id, reason,
      granted_by: operator.email, mode: 'live' })]);
  });

  it('the database refuses an adjustment whose creator is not a superuser', async () => {
    const account = (await wallet())!;
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)`);
      await tx.billingCreditAdminAdjustment.create({ data: { id: 'bcag_forged', accountId: account.accountId,
        creditAccountId: account.id, orgId: ids.org, signedAmountMicrocredits: 1_000_000n, reason,
        idempotencyKey: 'forged', createdByUserId: ids.member, createdByEmail: 'grant-member@example.com',
        createdByAdminDomain: adminDomain, creditEntryId: 'bceg_forged' } });
    })).rejects.toThrow(/superuser evidence/);
  });

  it('prepaid reservation holds and settlement spend the granted credits', async () => {
    const account = (await wallet())!;
    const dispatchId = 'dispatch-credit-grant';
    const receiptId = 'receipt-credit-grant';
    const bound = new Prisma.Decimal('0.000000001');
    const actual = new Prisma.Decimal('0.000000004');
    const [fingerprint, contextDigest] = ['f'.repeat(64), 'c'.repeat(64)];
    const startedAt = new Date('2026-10-04T12:00:00.000Z');
    await prisma.billingCreditBudgetDispatch.create({ data: {
      ...await captureTestOrganisationFinancialBinding(prisma, ids.org, { stripeAccountId, livemode: true }),
      dispatchId, contextDigest, serviceId: ids.service, providerServiceId: 'openai', orgId: ids.org,
      teamId: ids.team, userId: ids.member, billingMonth: '2026-10', currency: 'USD', tariffId: ids.tariff,
      frozenMarkupBps: 0, tariffMode: 'STANDARD', paymentMode: 'PREPAID', reservedMicrocredits: 1n } });
    await prisma.billingCreditBudgetDispatchScope.create({ data: { dispatchId, product: 'deepwater',
      orgId: ids.org, teamId: ids.team, scopeType: 'team', scopeId: ids.team, occurredAt: startedAt } });
    await prisma.billingPrepaidReservation.create({ data: { dispatchId, requestFingerprint: fingerprint,
      creditAccountId: account.id, tariffId: ids.tariff, serviceId: ids.service, providerServiceId: 'openai',
      appKeyId: ids.key, orgId: ids.org, teamId: ids.team, userId: ids.member, billingMonth: '2026-10',
      dispatchStartedAt: startedAt, currency: 'USD', rawCostBound: bound, reservedMicrocredits: 1n } });
    expect((await readOrganisationCreditGrants(ids.org, { prisma })).balance)
      .toMatchObject({ reserved: { microcredits: '1' }, spendable: { microcredits: '9999999999' } });

    const digest = paidExceptionEvidenceDigest({ dispatchId, receiptId, actual, currency: 'USD',
      requestFingerprint: fingerprint, rawCostBound: bound, contextDigest });
    await registerPaidUsageException({ runtimeSecret, dispatchId, receiptId, rawCostActual: actual.toFixed(18),
      currency: 'USD', evidenceDigest: digest }, { prisma });
    await writeOffPaidUsageException({ dispatchId, evidenceDigest: digest, idempotencyKey: key(dispatchId),
      reason: 'Verified provider receipt exceeded the frozen hold', actorUserId: ids.operator,
      actorTokenVersion: 0, adminDomain }, { prisma });
    const debit = await prisma.billingCreditEntry.findFirstOrThrow({ where: { creditAccountId: account.id,
      kind: 'PREPAID_USAGE' } });
    expect(debit.amountMicrocredits).toBe(1n);
    // The usage drew from the grant's lot.
    const movement = await prisma.billingCreditLotMovement.findFirstOrThrow({ where: { entryId: debit.id } });
    expect(movement.lotId).toBe(`bcl_${(await prisma.billingCreditAdminAdjustment.findFirstOrThrow({
      where: { orgId: ids.org } })).creditEntryId}`);
    expect((await readOrganisationCreditGrants(ids.org, { prisma })).balance)
      .toMatchObject({ confirmed: { microcredits: '9999999999' }, reserved: { microcredits: '0' } });
  });
});
