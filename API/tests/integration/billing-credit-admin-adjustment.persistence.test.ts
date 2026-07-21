import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAdminCreditAdjustment } from '../../src/services/billing-credit-admin-adjustment.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
const adminDomain = 'admin.credit-adjustment.test';
const ids = {
  user: 'usr_credit_admin',
  org: 'org_credit_admin',
  team: 'team_credit_admin',
  account: 'bsa_credit_admin',
  customer: 'bsc_credit_admin',
  creditAccount: 'credit_admin_account',
  service: 'svc_credit_admin',
  appKey: 'bak_credit_admin',
} as const;

async function seedAccount(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'credit-admin@example.com', 'credit-admin@example.com', 'Credit Admin')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "domain_roles" ("domain", "user_id", "role")
      VALUES (${adminDomain}, ${ids.user}, 'SUPERUSER')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'customer.example.com', 'Customer Org', 'customer-org', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Research Team', 'research-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_credit_admin_test', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${ids.creditAccount}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'USD', 5000000, CURRENT_TIMESTAMP
      )
    `);
  });
}

async function seedCrossSourceEntry(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'cross-source', 'Cross source', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Cross source', 'uoa_cross',
        ${'a'.repeat(64)}, 'https://cross.example.com', 'https://uoa.example.com',
        'cross-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://cross.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_entries" (
        "id", "credit_account_id", "service_id", "app_key_id", "attributed_user_id",
        "direction", "kind", "amount_microcredits", "balance_after_microcredits",
        "currency", "idempotency_key", "source_type", "source_id", "occurred_at"
      ) VALUES (
        'entry_cross_source', ${ids.creditAccount}, ${ids.service}, ${ids.appKey}, ${ids.user},
        'CREDIT', 'TOP_UP', 1000000, 5000000, 'USD', 'cross-source-key',
        'credit_top_up_checkout', 'checkout_cross_source', CURRENT_TIMESTAMP
      )
    `);
  });
}

function request(idempotencyKey: string) {
  return {
    creditAccountId: ids.creditAccount,
    organisationId: ids.org,
    teamId: ids.team,
    signedCredits: '1.25',
    reason: 'Restore the exact pre-test credit balance',
    idempotencyKey,
    actor: { userId: ids.user, email: 'credit-admin@example.com' },
  };
}

describe.skipIf(!databaseTestsEnabled)('superuser credit adjustment persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  }, 120_000);

  beforeEach(async () => {
    await handle!.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "billing_services", "billing_stripe_accounts" CASCADE',
    );
    await seedAccount(handle!.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('serializes concurrent exact retries into one entry and one audit event', async () => {
    const input = request('restore-concurrent-1');
    const results = await Promise.all([
      createAdminCreditAdjustment(input, { prisma: handle!.prisma, adminDomain }),
      createAdminCreditAdjustment(input, { prisma: handle!.prisma, adminDomain }),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);

    const [account, adjustments, entries, audits] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.creditAccount } }),
      handle!.prisma.billingCreditAdminAdjustment.findMany({
        where: { creditAccountId: ids.creditAccount, idempotencyKey: input.idempotencyKey },
      }),
      handle!.prisma.billingCreditEntry.findMany({
        where: { creditAccountId: ids.creditAccount, idempotencyKey: input.idempotencyKey },
      }),
      handle!.prisma.adminAuditLog.count({
        where: { action: 'billing.credit_adjustment_created' },
      }),
    ]);
    expect(account.balanceMicrocredits).toBe(6_250_000n);
    expect(adjustments).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(audits).toBe(1);

    await expect(
      handle!.prisma.billingCreditAdminAdjustment.update({
        where: { id: adjustments[0].id },
        data: { reason: 'Destructive rewrite' },
      }),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditAdminAdjustment.delete({ where: { id: adjustments[0].id } }),
    ).rejects.toBeDefined();
  }, 20_000);

  it('returns a deterministic conflict for a key owned by another entry source', async () => {
    await seedCrossSourceEntry(handle!.prisma);
    await expect(
      createAdminCreditAdjustment(request('cross-source-key'), {
        prisma: handle!.prisma,
        adminDomain,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT',
    });
    expect(
      await handle!.prisma.billingCreditAdminAdjustment.count({
        where: { creditAccountId: ids.creditAccount },
      }),
    ).toBe(0);
  });
});
