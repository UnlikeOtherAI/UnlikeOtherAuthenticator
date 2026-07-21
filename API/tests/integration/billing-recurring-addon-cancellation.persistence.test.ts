import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  owner: 'usr_addon_cancel_owner',
  member: 'usr_addon_cancel_member',
  org: 'org_addon_cancel',
  team: 'team_addon_cancel',
  otherTeam: 'team_addon_cancel_other',
  service: 'svc_addon_cancel',
  appKey: 'bak_addon_cancel',
  account: 'bsa_addon_cancel',
  customer: 'bsc_addon_cancel',
  creditAccount: 'bca_addon_cancel',
  fundingPolicy: 'bcfp_addon_cancel',
  topUpOffer: 'bctuo_addon_cancel',
  autoTopUpOption: 'bcatou_addon_cancel',
  topUpCatalog: 'bctuc_addon_cancel',
  offer: 'rao_addon_cancel',
  subscription: 'ras_addon_cancel',
} as const;

async function seedCancellationSubject(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name") VALUES
        (${ids.owner}, 'owner@example.com', 'owner@example.com', 'Owner'),
        (${ids.member}, 'member@example.com', 'member@example.com', 'Member')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" (
        "id", "domain", "name", "slug", "owner_id", "updated_at"
      ) VALUES (
        ${ids.org}, 'app.example.com', 'Cancellation Org', 'cancellation-org',
        ${ids.owner}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" (
        "id", "org_id", "user_id", "role", "status", "updated_at"
      ) VALUES
        ('om_addon_cancel_owner', ${ids.org}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('om_addon_cancel_member', ${ids.org}, ${ids.member}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at") VALUES
        (${ids.team}, ${ids.org}, 'Cancellation Team', 'cancellation-team', CURRENT_TIMESTAMP),
        (${ids.otherTeam}, ${ids.org}, 'Other Team', 'other-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" (
        "id", "team_id", "user_id", "team_role", "status", "updated_at"
      ) VALUES
        ('tm_addon_cancel_owner', ${ids.team}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('tm_addon_cancel_member', ${ids.team}, ${ids.member}, 'member', 'ACTIVE', CURRENT_TIMESTAMP),
        ('tm_addon_cancel_owner_other', ${ids.otherTeam}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'deepwater-cancel-test', 'DeepWater Test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Cancellation test',
        'uoa_test', ${'d'.repeat(64)}, 'https://app.example.com',
        'https://uoa.example.com', 'test-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://app.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" (
        "id", "stripe_account_id", "livemode", "updated_at"
      ) VALUES (${ids.account}, 'acct_cancel_test', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key",
        "stripe_customer_id", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, 'cus_credit_checkout_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_funding_policies" (
        "id", "service_id", "currency", "version", "top_up_enabled",
        "automatic_top_up_enabled", "automatic_consent_version", "updated_at"
      ) VALUES (
        ${ids.fundingPolicy}, ${ids.service}, 'USD', 1, true, true,
        'consent-v1', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_offers" (
        "id", "policy_id", "service_id", "key", "version", "catalog_key",
        "catalog_version", "name", "description", "payment_amount_minor",
        "credits_received_microcredits", "updated_at"
      ) VALUES (
        ${ids.topUpOffer}, ${ids.fundingPolicy}, ${ids.service}, 'standard', 1,
        'standard', 1, 'Standard top-up', 'Fixed-price test top-up', 5000,
        50000000000, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_auto_top_up_options" (
        "id", "policy_id", "service_id", "refill_offer_id", "key", "version",
        "threshold_microcredits", "monthly_charge_cap_minor", "updated_at"
      ) VALUES (
        ${ids.autoTopUpOption}, ${ids.fundingPolicy}, ${ids.service}, ${ids.topUpOffer},
        'standard-auto', 1, 5000000000, 10000, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_catalogs" (
        "id", "account_id", "key", "version", "currency", "payment_amount_minor",
        "credits_received_microcredits", "stripe_lookup_key", "stripe_product_id",
        "stripe_price_id", "updated_at"
      ) VALUES (
        ${ids.topUpCatalog}, ${ids.account}, 'standard', 1, 'USD', 5000,
        50000000000, 'credit-top-up-standard-v1', 'prod_credit_checkout_test',
        'price_credit_checkout_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "currency",
        "updated_at"
      ) VALUES (
        ${ids.creditAccount}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'USD', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_offers" (
        "id", "service_id", "key", "version", "name", "description",
        "monthly_amount_minor", "currency", "updated_at"
      ) VALUES (
        ${ids.offer}, ${ids.service}, 'privacy', 1, 'Private research',
        'Private research test offer', 5000, 'USD', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_subscriptions" (
        "id", "account_id", "checkout_id", "customer_id", "catalog_id",
        "service_id", "offer_id", "offer_key", "org_id", "team_id",
        "subscribing_user_id", "scope", "scope_key", "stripe_subscription_id",
        "stripe_item_id", "status", "cancel_at_period_end", "livemode", "updated_at"
      ) VALUES (
        ${ids.subscription}, ${ids.account}, 'checkout_seed', 'customer_seed', 'catalog_seed',
        ${ids.service}, ${ids.offer}, 'privacy', ${ids.org}, ${ids.team}, NULL,
        'TEAM', ${`${ids.org}:${ids.team}`}, 'sub_cancel_test', 'si_cancel_test',
        'active', false, false, CURRENT_TIMESTAMP
      )
    `);
  });
}

type IntentInput = {
  id: string;
  requester: string;
  tokenCharacter: string;
  idempotencyKey: string;
  requestedTeam?: string;
  createdAt?: Date;
  expiresAt?: Date;
};

async function insertIntent(prisma: PrismaClient, input: IntentInput): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + 5 * 60_000);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "billing_recurring_addon_cancellation_intents" (
      "id", "account_id", "app_key_id", "subscription_id", "service_id", "offer_id",
      "org_id", "team_id", "requested_team_id", "subscribing_user_id", "scope",
      "scope_key", "requested_by_user_id", "actor_jti", "token_digest",
      "subject_fingerprint", "idempotency_key", "expires_at", "created_at", "updated_at"
    ) VALUES (
      ${input.id}, ${ids.account}, ${ids.appKey}, ${ids.subscription}, ${ids.service},
      ${ids.offer}, ${ids.org}, ${ids.team}, ${input.requestedTeam ?? ids.team}, NULL, 'TEAM',
      ${`${ids.org}:${ids.team}`}, ${input.requester}, 'actor-jti-cancellation-test',
      ${input.tokenCharacter.repeat(64)}, ${'f'.repeat(64)}, ${input.idempotencyKey},
      ${expiresAt}, ${createdAt}, ${createdAt}
    )
  `);
}

async function insertTopUpCheckout(
  prisma: PrismaClient,
  id: string,
  requester: string,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "billing_credit_top_up_checkouts" (
      "id", "account_id", "credit_account_id", "customer_id", "catalog_id",
      "service_id", "app_key_id", "offer_id", "actor_jti", "requested_by_user_id",
      "payment_amount_minor", "credits_received_microcredits", "currency",
      "success_url_digest", "cancel_url_digest", "lease_expires_at", "updated_at"
    ) VALUES (
      ${id}, ${ids.account}, ${ids.creditAccount}, ${ids.customer}, ${ids.topUpCatalog},
      ${ids.service}, ${ids.appKey}, ${ids.topUpOffer}, ${`actor-${id}`}, ${requester},
      5000, 50000000000, 'USD', ${'a'.repeat(64)}, ${'b'.repeat(64)},
      CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP
    )
  `);
}

async function insertSetupCheckout(
  prisma: PrismaClient,
  id: string,
  requester: string,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "billing_credit_setup_checkouts" (
      "id", "account_id", "credit_account_id", "customer_id", "service_id",
      "app_key_id", "policy_id", "option_id", "actor_jti", "requested_by_user_id",
      "consent_version", "threshold_microcredits", "refill_offer_id",
      "refill_credits_microcredits", "refill_payment_amount_minor",
      "monthly_charge_cap_minor", "success_url_digest", "cancel_url_digest",
      "lease_expires_at", "updated_at"
    ) VALUES (
      ${id}, ${ids.account}, ${ids.creditAccount}, ${ids.customer}, ${ids.service},
      ${ids.appKey}, ${ids.fundingPolicy}, ${ids.autoTopUpOption}, ${`actor-${id}`},
      ${requester}, 'consent-v1', 5000000000, ${ids.topUpOffer}, 50000000000,
      5000, 10000, ${'c'.repeat(64)}, ${'d'.repeat(64)},
      CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP
    )
  `);
}

describe.skipIf(!databaseTestsEnabled)('recurring add-on cancellation persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let secondPrisma: PrismaClient;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedCancellationSubject(handle.prisma);
    secondPrisma = new PrismaClient({ datasources: { db: { url: handle.databaseUrl } } });
    await secondPrisma.$connect();
  }, 60_000);

  afterAll(async () => {
    await secondPrisma?.$disconnect();
    if (handle) await handle.cleanup();
  });

  it('rejects member-forged top-up and automatic-top-up setup checkouts', async () => {
    if (!handle) throw new Error('db handle missing');

    await expect(
      insertTopUpCheckout(handle.prisma, 'bctuc_member_forgery', ids.member),
    ).rejects.toThrow('billing action requires an active exact-team manager');
    await expect(
      insertSetupCheckout(handle.prisma, 'bcsc_member_forgery', ids.member),
    ).rejects.toThrow('billing action requires an active exact-team manager');

    await expect(
      insertTopUpCheckout(handle.prisma, 'bctuc_owner_valid', ids.owner),
    ).resolves.toBeUndefined();
    await expect(
      insertSetupCheckout(handle.prisma, 'bcsc_owner_valid', ids.owner),
    ).resolves.toBeUndefined();
  });

  it('allows exactly one concurrent cancellation preview for a subscription', async () => {
    if (!handle) throw new Error('db handle missing');

    const results = await Promise.allSettled([
      insertIntent(handle.prisma, {
        id: 'raci_race_primary',
        requester: ids.owner,
        tokenCharacter: '8',
        idempotencyKey: 'cancel-race-primary',
      }),
      insertIntent(secondPrisma, {
        id: 'raci_race_secondary',
        requester: ids.owner,
        tokenCharacter: '9',
        idempotencyKey: 'cancel-race-secondary',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await handle.prisma.billingRecurringAddonCancellationIntent.count({
        where: { subscriptionId: ids.subscription, state: 'AVAILABLE' },
      }),
    ).toBe(1);

    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_cancellation_intents"
        SET "state" = 'EXPIRED', "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" IN ('raci_race_primary', 'raci_race_secondary')
      `);
    });
  });

  it('requires active exact tenancy and manager authority before minting a preview', async () => {
    if (!handle) throw new Error('db handle missing');

    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_member',
        requester: ids.member,
        tokenCharacter: '1',
        idempotencyKey: 'cancel-member-0001',
      }),
    ).rejects.toThrow('new recurring add-on cancellation intent is not available');

    await handle.prisma.$executeRaw(Prisma.sql`
      UPDATE "org_members"
      SET "status" = 'DEACTIVATED', "status_changed_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "org_id" = ${ids.org} AND "user_id" = ${ids.owner}
    `);
    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_inactive_owner',
        requester: ids.owner,
        tokenCharacter: '2',
        idempotencyKey: 'cancel-inactive-0001',
      }),
    ).rejects.toThrow('recurring add-on cancellation actor tenancy is inactive');
    await handle.prisma.$executeRaw(Prisma.sql`
      UPDATE "org_members"
      SET "status" = 'ACTIVE', "status_changed_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "org_id" = ${ids.org} AND "user_id" = ${ids.owner}
    `);

    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_cross_team',
        requester: ids.owner,
        requestedTeam: ids.otherTeam,
        tokenCharacter: '5',
        idempotencyKey: 'cancel-cross-team-01',
      }),
    ).rejects.toThrow();

    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_valid',
        requester: ids.owner,
        tokenCharacter: '3',
        idempotencyKey: 'cancel-valid-000001',
      }),
    ).resolves.toBeUndefined();
    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_duplicate',
        requester: ids.owner,
        tokenCharacter: '4',
        idempotencyKey: 'cancel-duplicate-01',
      }),
    ).rejects.toThrow();
  });

  it('enforces expiry, one-way processing, exact subscription state, and replay safety', async () => {
    if (!handle) throw new Error('db handle missing');

    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_cancellation_intents"
        SET "state" = 'COMPLETED', "confirmation_request_digest" = ${'a'.repeat(64)},
            "result" = ${JSON.stringify({ status: 'scheduled' })}::jsonb,
            "consumed_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'raci_valid'
      `),
    ).rejects.toThrow('recurring add-on cancellation intent transition is invalid');

    await handle.prisma.$executeRaw(Prisma.sql`
      UPDATE "billing_recurring_addon_cancellation_intents"
      SET "state" = 'PROCESSING', "confirmation_request_digest" = ${'a'.repeat(64)},
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'raci_valid'
    `);
    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_cancellation_intents"
        SET "state" = 'COMPLETED', "result" = ${JSON.stringify({ status: 'scheduled' })}::jsonb,
            "consumed_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'raci_valid'
      `),
    ).rejects.toThrow('completed cancellation requires the bound subscription to be canceled');

    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_subscriptions"
        SET "cancel_at_period_end" = true, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${ids.subscription}
      `);
    });
    await handle.prisma.$executeRaw(Prisma.sql`
      UPDATE "billing_recurring_addon_cancellation_intents"
      SET "state" = 'COMPLETED', "result" = ${JSON.stringify({ status: 'scheduled' })}::jsonb,
          "consumed_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'raci_valid'
    `);
    await expect(
      handle.prisma.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_cancellation_intents"
        SET "result" = ${JSON.stringify({ status: 'changed' })}::jsonb,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'raci_valid'
      `),
    ).rejects.toThrow('completed recurring add-on cancellation proof is immutable');

    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_recurring_addon_subscriptions"
        SET "cancel_at_period_end" = false, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${ids.subscription}
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_recurring_addon_cancellation_intents" (
          "id", "account_id", "app_key_id", "subscription_id", "service_id", "offer_id",
          "org_id", "team_id", "requested_team_id", "subscribing_user_id", "scope",
          "scope_key", "requested_by_user_id", "actor_jti", "token_digest",
          "subject_fingerprint", "idempotency_key", "state", "expires_at", "created_at",
          "updated_at"
        ) VALUES (
          'raci_expired', ${ids.account}, ${ids.appKey}, ${ids.subscription}, ${ids.service},
          ${ids.offer}, ${ids.org}, ${ids.team}, ${ids.team}, NULL, 'TEAM',
          ${`${ids.org}:${ids.team}`}, ${ids.owner}, 'actor-jti-expired', ${'6'.repeat(64)},
          ${'e'.repeat(64)}, 'cancel-expired-0001', 'AVAILABLE',
          CURRENT_TIMESTAMP - INTERVAL '1 minute', CURRENT_TIMESTAMP - INTERVAL '2 minutes',
          CURRENT_TIMESTAMP - INTERVAL '2 minutes'
        )
      `);
    });
    await handle.prisma.$executeRaw(Prisma.sql`
      UPDATE "billing_recurring_addon_cancellation_intents"
      SET "state" = 'EXPIRED', "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'raci_expired'
    `);
    await expect(
      insertIntent(handle.prisma, {
        id: 'raci_after_expiry',
        requester: ids.owner,
        tokenCharacter: '7',
        idempotencyKey: 'cancel-after-expiry-01',
      }),
    ).resolves.toBeUndefined();
  });
});
