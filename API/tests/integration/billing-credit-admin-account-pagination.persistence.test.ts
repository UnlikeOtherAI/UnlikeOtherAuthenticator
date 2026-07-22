import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listAdminCreditAccounts } from '../../src/services/billing-credit-admin-account.service.js';
import {
  createAdminCreditAdjustment,
  previewAdminCreditAdjustment,
} from '../../src/services/billing-credit-admin-adjustment.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
const adminDomain = 'admin.credit-pagination.test';
const confirmationSecret = 'credit-pagination-confirmation-secret-32-chars';
const ids = {
  user: 'usr_credit_pagination',
  org: 'org_credit_pagination',
  account: 'bsa_credit_pagination',
} as const;

function teamId(position: number): string {
  return `team_credit_pagination_${position}`;
}

function customerId(position: number): string {
  return `bsc_credit_pagination_${position}`;
}

function creditAccountId(position: number): string {
  return `bca_credit_pagination_${position}`;
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'credit-pagination@example.com', 'credit-pagination@example.com', 'Credit Pagination')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "domain_roles" ("domain", "user_id", "role")
      VALUES (${adminDomain}, ${ids.user}, 'SUPERUSER')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'credit-pagination.example.com', 'Credit Pagination', 'credit-pagination', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_credit_pagination', false, CURRENT_TIMESTAMP)
    `);
    for (const position of [1, 2, 3, 4]) {
      const createdAt = new Date(`2026-07-21T12:0${position}:00.000Z`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
        VALUES (${teamId(position)}, ${ids.org}, ${`Pagination ${position}`}, ${`pagination-${position}`}, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_stripe_customers" (
          "id", "account_id", "org_id", "team_id", "scope", "scope_key", "updated_at"
        ) VALUES (
          ${customerId(position)}, ${ids.account}, ${ids.org}, ${teamId(position)}, 'TEAM',
          ${`${ids.org}:${teamId(position)}`}, CURRENT_TIMESTAMP
        )
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_credit_accounts" (
          "id", "account_id", "customer_id", "org_id", "team_id", "currency",
          "balance_microcredits", "created_at", "updated_at"
        ) VALUES (
          ${creditAccountId(position)}, ${ids.account}, ${customerId(position)}, ${ids.org},
          ${teamId(position)}, 'USD', 10000000, ${createdAt}, ${createdAt}
        )
      `);
    }
  });
}

describe.skipIf(!enabled)('admin credit account pagination persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  }, 120_000);

  beforeEach(async () => {
    await handle!.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "billing_services", "billing_stripe_accounts" CASCADE',
    );
    await seed(handle!.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('does not skip or duplicate an unseen account adjusted between pages', async () => {
    const query = { organisationId: ids.org, limit: 2 };
    const first = await listAdminCreditAccounts(query, { prisma: handle!.prisma });
    expect(first.accounts.map((account) => account.id)).toEqual([
      creditAccountId(4),
      creditAccountId(3),
    ]);

    const adjustment = {
      creditAccountId: creditAccountId(2),
      organisationId: ids.org,
      teamId: teamId(2),
      signedCredits: '1',
      reason: 'Exercise immutable pagination under a real balance change',
      idempotencyKey: 'credit-pagination:between-pages',
      actor: { userId: ids.user, email: 'credit-pagination@example.com' },
    };
    const preview = await previewAdminCreditAdjustment(adjustment, {
      prisma: handle!.prisma,
      adminDomain,
      confirmationSecret,
    });
    await createAdminCreditAdjustment(
      {
        creditAccountId: adjustment.creditAccountId,
        confirmationToken: preview.confirmation_token,
        actor: adjustment.actor,
      },
      { prisma: handle!.prisma, adminDomain, confirmationSecret },
    );

    const second = await listAdminCreditAccounts(
      { ...query, cursor: first.next_cursor! },
      { prisma: handle!.prisma },
    );
    expect(second.accounts.map((account) => account.id)).toEqual([
      creditAccountId(2),
      creditAccountId(1),
    ]);
    const allIds = [...first.accounts, ...second.accounts].map((account) => account.id);
    expect(new Set(allIds).size).toBe(4);
    expect(second.has_more).toBe(false);
  });
});
