import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { claimCreditAutoTopUpAttempt } from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import {
  createAdminCreditAdjustment,
  previewAdminCreditAdjustment,
} from '../../src/services/billing-credit-admin-adjustment.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
const adminDomain = 'admin.credit-concurrency.test';
const confirmationSecret = 'credit-concurrency-confirmation-secret-32-chars';
const ids = {
  user: 'usr_credit_concurrency',
  org: 'org_credit_concurrency',
  account: 'bsa_credit_concurrency',
  service: 'svc_credit_concurrency',
  appKey: 'bak_credit_concurrency',
  policy: 'bcfp_credit_concurrency',
  offer: 'bcto_credit_concurrency',
  option: 'bcat_credit_concurrency',
  catalog: 'bctc_credit_concurrency',
} as const;

function scoped(suffix: string) {
  return {
    team: `team_credit_${suffix}`,
    customer: `bsc_credit_${suffix}`,
    creditAccount: `bca_credit_${suffix}`,
    revision: `bcar_credit_${suffix}`,
  };
}

async function seedCreditAccount(tx: Prisma.TransactionClient, suffix: string): Promise<void> {
  const row = scoped(suffix);
  const consentedAt = new Date('2026-07-21T12:00:00.000Z');
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
    VALUES (${row.team}, ${ids.org}, ${`Credit ${suffix}`}, ${`credit-${suffix}`}, CURRENT_TIMESTAMP)
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "billing_stripe_customers" (
      "id", "account_id", "org_id", "team_id", "scope", "scope_key",
      "stripe_customer_id", "updated_at"
    ) VALUES (
      ${row.customer}, ${ids.account}, ${ids.org}, ${row.team}, 'TEAM',
      ${`${ids.org}:${row.team}`}, ${`cus_credit_${suffix}`}, CURRENT_TIMESTAMP
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "billing_credit_auto_top_up_consent_revisions" (
      "id", "account_id", "credit_account_id", "org_id", "team_id", "service_id",
      "app_key_id", "policy_id", "option_id", "refill_offer_id", "source", "actor_jti",
      "consented_by_user_id", "consent_version", "threshold_microcredits",
      "refill_credits_microcredits", "refill_payment_amount_minor",
      "monthly_charge_cap_minor", "stripe_payment_method_id", "consented_at"
    ) VALUES (
      ${row.revision}, ${ids.account}, ${row.creditAccount}, ${ids.org}, ${row.team},
      ${ids.service}, ${ids.appKey}, ${ids.policy}, ${ids.option}, ${ids.offer},
      'CUSTOMER_UPDATE', ${`actor-${suffix}`}, ${ids.user}, 'auto-top-up-v1',
      200000000, 5000000000, 500, 1500, ${`pm_credit_${suffix}`}, ${consentedAt}
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "billing_credit_accounts" (
      "id", "account_id", "customer_id", "org_id", "team_id", "currency",
      "balance_microcredits", "auto_top_up_state", "auto_top_up_policy_id",
      "auto_top_up_service_id", "auto_top_up_app_key_id", "auto_top_up_consent_revision_id",
      "auto_top_up_option_id", "auto_top_up_threshold_microcredits",
      "auto_top_up_refill_offer_id", "auto_top_up_monthly_charge_cap_minor",
      "auto_top_up_consent_version", "auto_top_up_consented_at",
      "auto_top_up_consented_by_user_id", "stripe_payment_method_id", "updated_at"
    ) VALUES (
      ${row.creditAccount}, ${ids.account}, ${row.customer}, ${ids.org}, ${row.team}, 'USD',
      100000000, 'ACTIVE', ${ids.policy}, ${ids.service}, ${ids.appKey}, ${row.revision},
      ${ids.option}, 200000000, ${ids.offer}, 1500, 'auto-top-up-v1', ${consentedAt},
      ${ids.user}, ${`pm_credit_${suffix}`}, CURRENT_TIMESTAMP
    )
  `);
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'credit-concurrency@example.com', 'credit-concurrency@example.com', 'Credit Operator')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "domain_roles" ("domain", "user_id", "role")
      VALUES (${adminDomain}, ${ids.user}, 'SUPERUSER')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'credit-concurrency.example.com', 'Credit Concurrency', 'credit-concurrency', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'credit-concurrency', 'Credit Concurrency', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Credit concurrency',
        'uoa_credit_concurrency', ${'a'.repeat(64)}, 'https://credit.example.com',
        'https://uoa.example.com', 'credit-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://credit.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_credit_concurrency', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_funding_policies" (
        "id", "service_id", "currency", "version", "top_up_enabled",
        "automatic_top_up_enabled", "automatic_consent_version", "active", "updated_at"
      ) VALUES (${ids.policy}, ${ids.service}, 'USD', 1, true, true, 'auto-top-up-v1', true, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_offers" (
        "id", "policy_id", "service_id", "key", "version", "catalog_key",
        "catalog_version", "name", "description", "payment_amount_minor",
        "credits_received_microcredits", "automatic_top_up_eligible", "active", "updated_at"
      ) VALUES (
        ${ids.offer}, ${ids.policy}, ${ids.service}, 'refill', 1, 'credit-refill', 1,
        'Refill', 'Five thousand credits', 500, 5000000000, true, true, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_auto_top_up_options" (
        "id", "policy_id", "service_id", "refill_offer_id", "key", "version",
        "threshold_microcredits", "monthly_charge_cap_minor", "active", "updated_at"
      ) VALUES (
        ${ids.option}, ${ids.policy}, ${ids.service}, ${ids.offer}, 'low-balance', 1,
        200000000, 1500, true, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_catalogs" (
        "id", "account_id", "key", "version", "currency", "payment_amount_minor",
        "credits_received_microcredits", "stripe_lookup_key", "stripe_product_id",
        "stripe_price_id", "updated_at"
      ) VALUES (
        ${ids.catalog}, ${ids.account}, 'credit-refill', 1, 'USD', 500, 5000000000,
        'credit_refill_v1', 'prod_credit_concurrency', 'price_credit_concurrency', CURRENT_TIMESTAMP
      )
    `);
    await seedCreditAccount(tx, 'scheduler_first');
    await seedCreditAccount(tx, 'adjustment_first');
  });
}

function lockGate() {
  let announce!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => (announce = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    locked,
    release,
    hold: async () => {
      announce();
      await released;
    },
  };
}

function intent(suffix: string) {
  const row = scoped(suffix);
  return {
    creditAccountId: row.creditAccount,
    organisationId: ids.org,
    teamId: row.team,
    signedCredits: '150',
    reason: `Concurrency ordering ${suffix}`,
    idempotencyKey: `credit-concurrency:${suffix}`,
    actor: { userId: ids.user, email: 'credit-concurrency@example.com' },
  };
}

const serviceDeps = { adminDomain, confirmationSecret };

describe.skipIf(!enabled)('admin adjustment and automatic top-up lock ordering', () => {
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

  it('lets a scheduler-first claim commit and then rejects the adjustment under the same lock', async () => {
    const input = intent('scheduler_first');
    const preview = await previewAdminCreditAdjustment(input, {
      ...serviceDeps,
      prisma: handle!.prisma,
    });
    const gate = lockGate();
    const scheduler = claimCreditAutoTopUpAttempt(
      { accountId: ids.account, creditAccountId: input.creditAccountId },
      { prisma: handle!.prisma, afterAccountLock: gate.hold },
    );
    await gate.locked;
    const adjustmentPromise = createAdminCreditAdjustment(
      {
        creditAccountId: input.creditAccountId,
        confirmationToken: preview.confirmation_token,
        actor: input.actor,
      },
      { ...serviceDeps, prisma: handle!.prisma },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.release();

    await expect(scheduler).resolves.toMatchObject({ kind: 'dispatch', created: true });
    await expect(adjustmentPromise).rejects.toMatchObject({
      statusCode: 409,
      message: 'BILLING_CREDIT_ADJUSTMENT_AUTO_TOP_UP_PENDING',
    });
    expect(await handle!.prisma.billingCreditAdminAdjustment.count()).toBe(0);
  }, 20_000);

  it('lets an adjustment-first commit reprice the balance before the scheduler evaluates it', async () => {
    const input = intent('adjustment_first');
    const preview = await previewAdminCreditAdjustment(input, {
      ...serviceDeps,
      prisma: handle!.prisma,
    });
    const gate = lockGate();
    const adjustmentPromise = createAdminCreditAdjustment(
      {
        creditAccountId: input.creditAccountId,
        confirmationToken: preview.confirmation_token,
        actor: input.actor,
      },
      { ...serviceDeps, prisma: handle!.prisma, afterAccountLock: gate.hold },
    );
    await gate.locked;
    const scheduler = claimCreditAutoTopUpAttempt(
      { accountId: ids.account, creditAccountId: input.creditAccountId },
      { prisma: handle!.prisma },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.release();

    await expect(adjustmentPromise).resolves.toMatchObject({ replayed: false });
    await expect(scheduler).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'threshold_not_reached',
    });
    expect(await handle!.prisma.billingCreditAutoTopUpAttempt.count()).toBe(0);
    expect(
      (
        await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
          where: { id: input.creditAccountId },
        })
      ).balanceMicrocredits,
    ).toBe(250_000_000n);
  }, 20_000);
});
