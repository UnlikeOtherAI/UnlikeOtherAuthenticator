import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('base Checkout locale immutability', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  });

  beforeEach(async () => {
    await handle.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "billing_stripe_checkout_sessions" CASCADE',
    );
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_stripe_checkout_sessions" (
          "id", "account_id", "app_key_id", "customer_id", "service_id", "tariff_id",
          "tariff_source", "org_id", "scope", "scope_key", "actor_jti",
          "requested_by_user_id", "success_url_digest", "cancel_url_digest",
          "checkout_locale", "lease_expires_at", "updated_at"
        ) VALUES (
          'checkout_locale_immutable', 'account_test', 'app_key_test', 'customer_test',
          'service_test', 'tariff_test', 'SERVICE_DEFAULT', 'org_test', 'ORGANISATION',
          'org_test', 'actor_test', 'user_test', ${'a'.repeat(64)}, ${'b'.repeat(64)},
          'cs', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);
    });
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('rejects changing the locale frozen on an existing checkout lease', async () => {
    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        UPDATE "billing_stripe_checkout_sessions"
        SET "checkout_locale" = 'de'
        WHERE "id" = 'checkout_locale_immutable'
      `),
    ).rejects.toThrow();

    const row = await handle.prisma.billingStripeCheckoutSession.findUniqueOrThrow({
      where: { id: 'checkout_locale_immutable' },
      select: { checkoutLocale: true },
    });
    expect(row.checkoutLocale).toBe('cs');
  });
});
