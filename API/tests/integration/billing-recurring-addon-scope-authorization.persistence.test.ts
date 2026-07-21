import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  orgOwner: 'usr_addon_scope_org_owner',
  teamAdmin: 'usr_addon_scope_team_admin',
  org: 'org_addon_scope',
  team: 'team_addon_scope',
  service: 'svc_addon_scope',
  appKey: 'bak_addon_scope',
  account: 'bsa_addon_scope',
  customer: 'bsc_addon_scope',
  offer: 'rao_addon_scope',
  catalog: 'rac_addon_scope',
  subscription: 'ras_addon_scope',
} as const;

async function seedOrganisationSubscription(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name") VALUES
        (${ids.orgOwner}, 'scope-owner@example.com', 'scope-owner@example.com', 'Scope Owner'),
        (${ids.teamAdmin}, 'scope-team-admin@example.com', 'scope-team-admin@example.com', 'Team Admin')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" (
        "id", "domain", "name", "slug", "owner_id", "updated_at"
      ) VALUES (
        ${ids.org}, 'scope.example.com', 'Scope Org', 'scope-org',
        ${ids.orgOwner}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" (
        "id", "org_id", "user_id", "role", "status", "updated_at"
      ) VALUES
        ('om_scope_owner', ${ids.org}, ${ids.orgOwner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('om_scope_team_admin', ${ids.org}, ${ids.teamAdmin}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Scope Team', 'scope-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" (
        "id", "team_id", "user_id", "team_role", "status", "updated_at"
      ) VALUES
        ('tm_scope_owner', ${ids.team}, ${ids.orgOwner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('tm_scope_team_admin', ${ids.team}, ${ids.teamAdmin}, 'admin', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'deepwater-scope-test', 'DeepWater Scope Test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Scope authorization test',
        'uoa_scope', ${'a'.repeat(64)}, 'https://scope.example.com',
        'https://uoa.example.com', 'scope-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://scope.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_scope_test', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key",
        "stripe_customer_id", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, NULL, 'ORGANISATION', ${ids.org},
        'cus_scope_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_offers" (
        "id", "service_id", "key", "version", "name", "description",
        "monthly_amount_minor", "currency", "updated_at"
      ) VALUES (
        ${ids.offer}, ${ids.service}, 'privacy', 1, 'Private research',
        'Organisation scope test offer', 5000, 'USD', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_catalogs" (
        "id", "account_id", "service_id", "offer_id", "currency",
        "monthly_amount_minor", "stripe_lookup_key", "stripe_product_id",
        "stripe_price_id", "updated_at"
      ) VALUES (
        ${ids.catalog}, ${ids.account}, ${ids.service}, ${ids.offer}, 'USD', 5000,
        'addon-scope-privacy-v1', 'prod_scope_test', 'price_scope_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_subscriptions" (
        "id", "account_id", "checkout_id", "customer_id", "catalog_id",
        "service_id", "offer_id", "offer_key", "org_id", "team_id",
        "subscribing_user_id", "scope", "scope_key", "stripe_subscription_id",
        "stripe_item_id", "status", "cancel_at_period_end", "livemode", "updated_at"
      ) VALUES (
        ${ids.subscription}, ${ids.account}, 'checkout_scope_seed', ${ids.customer}, ${ids.catalog},
        ${ids.service}, ${ids.offer}, 'privacy', ${ids.org}, NULL, NULL,
        'ORGANISATION', ${ids.org}, 'sub_scope_test', 'si_scope_test',
        'active', false, false, CURRENT_TIMESTAMP
      )
    `);
  });
}

describe.skipIf(!databaseTestsEnabled)('recurring add-on scope authorization', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedOrganisationSubscription(handle.prisma);
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('does not let an exact-team admin buy or cancel an organisation add-on', async () => {
    if (!handle) throw new Error('db handle missing');

    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "billing_recurring_addon_checkouts" (
          "id", "account_id", "app_key_id", "customer_id", "catalog_id",
          "service_id", "offer_id", "offer_key", "org_id", "team_id",
          "requested_team_id", "subscribing_user_id", "scope", "scope_key",
          "actor_jti", "subject_fingerprint", "requested_by_user_id",
          "success_url_digest", "cancel_url_digest", "lease_expires_at", "updated_at"
        ) VALUES (
          'rac_scope_team_admin', ${ids.account}, ${ids.appKey}, ${ids.customer}, ${ids.catalog},
          ${ids.service}, ${ids.offer}, 'privacy', ${ids.org}, NULL, ${ids.team}, NULL,
          'ORGANISATION', ${ids.org}, 'actor-scope-team-admin', ${'b'.repeat(64)},
          ${ids.teamAdmin}, ${'c'.repeat(64)}, ${'d'.repeat(64)},
          CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow('recurring add-on checkout requires a billing manager');

    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "billing_recurring_addon_cancellation_intents" (
          "id", "account_id", "app_key_id", "subscription_id", "service_id", "offer_id",
          "org_id", "team_id", "requested_team_id", "subscribing_user_id", "scope",
          "scope_key", "requested_by_user_id", "actor_jti", "token_digest",
          "subject_fingerprint", "idempotency_key", "expires_at", "updated_at"
        ) VALUES (
          'raci_scope_team_admin', ${ids.account}, ${ids.appKey}, ${ids.subscription},
          ${ids.service}, ${ids.offer}, ${ids.org}, NULL, ${ids.team}, NULL, 'ORGANISATION',
          ${ids.org}, ${ids.teamAdmin}, 'actor-scope-cancel', ${'e'.repeat(64)},
          ${'f'.repeat(64)}, 'scope-cancel-team-admin',
          CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow('new recurring add-on cancellation intent is not available');
  });
});
