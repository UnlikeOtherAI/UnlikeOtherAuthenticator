import { Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  listCreditAutoTopUpCandidateIds,
} from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import {
  runCreditAutoTopUpAccount,
} from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  user: 'usr_auto_top_up_runtime',
  org: 'org_auto_top_up_runtime',
  service: 'svc_auto_top_up_runtime',
  appKey: 'bak_auto_top_up_runtime',
  account: 'bsa_auto_top_up_runtime',
  policy: 'bcfp_auto_top_up_runtime',
  offer: 'bcto_auto_top_up_runtime',
  option: 'bcat_auto_top_up_runtime',
  catalog: 'bctc_auto_top_up_runtime',
} as const;

const stripeAccount = {
  id: ids.account,
  stripeAccountId: 'acct_auto_top_up_runtime',
  livemode: false,
};

function scopedIds(suffix: string) {
  return {
    team: `team_auto_top_up_${suffix}`,
    teamMember: `tm_auto_top_up_${suffix}`,
    customer: `bsc_auto_top_up_${suffix}`,
    creditAccount: `bca_auto_top_up_${suffix}`,
    revision: `bcar_auto_top_up_${suffix}`,
  };
}

const concurrency = scopedIds('concurrency');
const recovery = scopedIds('recovery');
const embeddedError = scopedIds('embedded');
const aboveThreshold = scopedIds('above');
const disabled = scopedIds('disabled');

async function seedCreditAccount(
  tx: Prisma.TransactionClient,
  suffix: string,
  balanceMicrocredits: bigint,
  active: boolean,
): Promise<void> {
  const row = scopedIds(suffix);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
    VALUES (
      ${row.team}, ${ids.org}, ${`Auto Top Up ${suffix}`}, ${`auto-top-up-${suffix}`},
      CURRENT_TIMESTAMP
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "team_members" (
      "id", "team_id", "user_id", "team_role", "status", "updated_at"
    ) VALUES (
      ${row.teamMember}, ${row.team}, ${ids.user}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP
    )
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "billing_stripe_customers" (
      "id", "account_id", "org_id", "team_id", "scope", "scope_key",
      "stripe_customer_id", "updated_at"
    ) VALUES (
      ${row.customer}, ${ids.account}, ${ids.org}, ${row.team}, 'TEAM',
      ${`${ids.org}:${row.team}`}, ${`cus_auto_top_up_${suffix}`}, CURRENT_TIMESTAMP
    )
  `);
  if (!active) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${row.creditAccount}, ${ids.account}, ${row.customer}, ${ids.org}, ${row.team},
        'USD', ${balanceMicrocredits}, CURRENT_TIMESTAMP
      )
    `);
    return;
  }
  const consentedAt = new Date('2026-07-21T12:00:00.000Z');
  const paymentMethodSummary = JSON.stringify({ type: 'card', brand: 'visa', last4: '4242' });
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "billing_credit_auto_top_up_consent_revisions" (
      "id", "account_id", "credit_account_id", "org_id", "team_id", "service_id",
      "app_key_id", "policy_id", "option_id", "refill_offer_id", "source", "actor_jti",
      "consented_by_user_id", "consent_version", "threshold_microcredits",
      "refill_credits_microcredits", "refill_payment_amount_minor",
      "monthly_charge_cap_minor", "stripe_payment_method_id", "payment_method_summary",
      "consented_at"
    ) VALUES (
      ${row.revision}, ${ids.account}, ${row.creditAccount}, ${ids.org}, ${row.team},
      ${ids.service}, ${ids.appKey}, ${ids.policy}, ${ids.option}, ${ids.offer},
      'CUSTOMER_UPDATE', ${`actor-auto-top-up-${suffix}`}, ${ids.user}, 'auto-top-up-v1',
      200000000, 5000000000, 500, 1500, ${`pm_auto_top_up_${suffix}`},
      ${paymentMethodSummary}::jsonb, ${consentedAt}
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
      "auto_top_up_consented_by_user_id", "stripe_payment_method_id",
      "payment_method_summary", "updated_at"
    ) VALUES (
      ${row.creditAccount}, ${ids.account}, ${row.customer}, ${ids.org}, ${row.team}, 'USD',
      ${balanceMicrocredits}, 'ACTIVE', ${ids.policy}, ${ids.service}, ${ids.appKey},
      ${row.revision}, ${ids.option}, 200000000, ${ids.offer}, 1500, 'auto-top-up-v1',
      ${consentedAt}, ${ids.user}, ${`pm_auto_top_up_${suffix}`},
      ${paymentMethodSummary}::jsonb, CURRENT_TIMESTAMP
    )
  `);
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (
        ${ids.user}, 'auto-top-up@example.com', 'auto-top-up@example.com', 'Auto Top Up Owner'
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" (
        "id", "domain", "name", "slug", "owner_id", "updated_at"
      ) VALUES (
        ${ids.org}, 'auto-top-up.example.com', 'Auto Top Up Org', 'auto-top-up-org',
        ${ids.user}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" (
        "id", "org_id", "user_id", "role", "status", "updated_at"
      ) VALUES (
        'om_auto_top_up_runtime', ${ids.org}, ${ids.user}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'auto-top-up-test', 'Auto Top Up Test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Auto top-up runtime',
        'uoa_auto_test', ${'a'.repeat(64)}, 'https://auto-top-up.example.com',
        'https://uoa.example.com', 'auto-top-up-key',
        ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://auto-top-up.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" (
        "id", "stripe_account_id", "livemode", "updated_at"
      ) VALUES (${ids.account}, ${stripeAccount.stripeAccountId}, false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_funding_policies" (
        "id", "service_id", "currency", "version", "top_up_enabled",
        "automatic_top_up_enabled", "automatic_consent_version", "active", "updated_at"
      ) VALUES (
        ${ids.policy}, ${ids.service}, 'USD', 1, true, true, 'auto-top-up-v1', true,
        CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_offers" (
        "id", "policy_id", "service_id", "key", "version", "catalog_key",
        "catalog_version", "name", "description", "payment_amount_minor",
        "credits_received_microcredits", "automatic_top_up_eligible", "active", "updated_at"
      ) VALUES (
        ${ids.offer}, ${ids.policy}, ${ids.service}, 'five-dollar-refill', 1,
        'credits-five-dollar', 1, 'Five dollar refill', 'Five thousand credits',
        500, 5000000000, true, true, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_auto_top_up_options" (
        "id", "policy_id", "service_id", "refill_offer_id", "key", "version",
        "threshold_microcredits", "monthly_charge_cap_minor", "active", "updated_at"
      ) VALUES (
        ${ids.option}, ${ids.policy}, ${ids.service}, ${ids.offer}, 'low-balance-refill', 1,
        200000000, 1500, true, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_top_up_catalogs" (
        "id", "account_id", "key", "version", "currency", "payment_amount_minor",
        "credits_received_microcredits", "stripe_lookup_key", "stripe_product_id",
        "stripe_price_id", "updated_at"
      ) VALUES (
        ${ids.catalog}, ${ids.account}, 'credits-five-dollar', 1, 'USD', 500,
        5000000000, 'uoa_credits_five_dollar_v1', 'prod_auto_top_up',
        'price_auto_top_up', CURRENT_TIMESTAMP
      )
    `);
    await seedCreditAccount(tx, 'concurrency', 100_000_000n, true);
    await seedCreditAccount(tx, 'recovery', 100_000_000n, true);
    await seedCreditAccount(tx, 'embedded', 100_000_000n, true);
    await seedCreditAccount(tx, 'above', 300_000_000n, true);
    await seedCreditAccount(tx, 'disabled', 100_000_000n, false);
  });
}

function paymentIntent(attemptId: string, suffix: string): Stripe.PaymentIntent {
  return {
    id: `pi_auto_top_up_${suffix}`,
    object: 'payment_intent',
    amount: 500,
    currency: 'usd',
    customer: `cus_auto_top_up_${suffix}`,
    payment_method: `pm_auto_top_up_${suffix}`,
    metadata: {
      uoa_credit_auto_top_up_attempt_id: attemptId,
      uoa_service_id: ids.service,
      uoa_app_key_id: ids.appKey,
      uoa_credit_account_id: scopedIds(suffix).creditAccount,
    },
    livemode: false,
    status: 'processing',
  } as Stripe.PaymentIntent;
}

describe.skipIf(!databaseTestsEnabled)('credit automatic top-up PostgreSQL runtime', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('selects only active exact-team accounts below their configured threshold', async () => {
    const candidates = await listCreditAutoTopUpCandidateIds(
      { accountId: ids.account, limit: 10 },
      { prisma: handle!.prisma },
    );

    expect(candidates).toEqual(
      [concurrency.creditAccount, recovery.creditAccount, embeddedError.creditAccount].sort(),
    );
    expect(candidates).not.toContain(aboveThreshold.creditAccount);
    expect(candidates).not.toContain(disabled.creditAccount);
  });

  it('commits one attempt before Stripe and serializes concurrent dispatch per account', async () => {
    const create = vi.fn(async (_params: unknown, options: { idempotencyKey?: string }) => {
      const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
        where: { creditAccountId: concurrency.creditAccount },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].stripePaymentIntentId).toBeNull();
      expect(options.idempotencyKey).toBe(attempts[0].idempotencyKey);
      return paymentIntent(attempts[0].id, 'concurrency');
    });
    const stripe = { paymentIntents: { create } } as never;

    const results = await Promise.all([
      runCreditAutoTopUpAccount(
        { account: stripeAccount, creditAccountId: concurrency.creditAccount },
        { prisma: handle!.prisma, stripe },
      ),
      runCreditAutoTopUpAccount(
        { account: stripeAccount, creditAccountId: concurrency.creditAccount },
        { prisma: handle!.prisma, stripe },
      ),
    ]);

    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: concurrency.creditAccount },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].stripePaymentIntentId).toBe('pi_auto_top_up_concurrency');
    expect(attempts[0]).toMatchObject({
      serviceId: ids.service,
      appKeyId: ids.appKey,
      attributedUserId: ids.user,
      paymentAmountMinor: 500n,
      creditsReceivedMicrocredits: 5_000_000_000n,
      observedBalanceMicrocredits: 100_000_000n,
      chargedThisMonthBeforeMinor: 0n,
    });
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'awaiting_webhook',
      'submitted',
    ]);
    expect(create).toHaveBeenCalledWith(
      {
        amount: 500,
        currency: 'usd',
        customer: 'cus_auto_top_up_concurrency',
        payment_method: 'pm_auto_top_up_concurrency',
        confirm: true,
        off_session: true,
        metadata: {
          uoa_credit_auto_top_up_attempt_id: attempts[0].id,
          uoa_service_id: ids.service,
          uoa_app_key_id: ids.appKey,
          uoa_credit_account_id: concurrency.creditAccount,
        },
        description: 'UOA automatic credit top-up',
      },
      { idempotencyKey: attempts[0].idempotencyKey },
    );
  }, 20_000);

  it('recovers an ambiguous Stripe create with the same durable attempt and key', async () => {
    const firstCreate = vi.fn().mockRejectedValue(new Error('socket closed after request write'));
    const first = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: recovery.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create: firstCreate } } as never },
    );
    const pending = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: recovery.creditAccount },
    });

    expect(first).toMatchObject({ outcome: 'failed', attemptId: pending[0].id });
    expect(pending).toHaveLength(1);
    expect(pending[0].stripePaymentIntentId).toBeNull();
    const recoveredCreate = vi.fn().mockResolvedValue(paymentIntent(pending[0].id, 'recovery'));
    const recovered = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: recovery.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create: recoveredCreate } } as never },
    );
    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { creditAccountId: recovery.creditAccount },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(pending[0].id);
    expect(attempts[0].stripePaymentIntentId).toBe('pi_auto_top_up_recovery');
    expect(recovered).toMatchObject({
      outcome: 'submitted',
      attemptId: pending[0].id,
      recoveredAttempt: true,
    });
    expect(firstCreate.mock.calls[0]?.[1]).toEqual({ idempotencyKey: pending[0].idempotencyKey });
    expect(recoveredCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: pending[0].idempotencyKey,
    });
  }, 20_000);

  it('attaches an exact PaymentIntent returned inside an off-session Stripe error', async () => {
    const create = vi.fn(async (_params: unknown, options: { idempotencyKey?: string }) => {
      const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
        where: { creditAccountId: embeddedError.creditAccount },
      });
      expect(options.idempotencyKey).toBe(attempt.idempotencyKey);
      throw Object.assign(new Error('card requires customer action'), {
        payment_intent: paymentIntent(attempt.id, 'embedded'),
      });
    });

    const result = await runCreditAutoTopUpAccount(
      { account: stripeAccount, creditAccountId: embeddedError.creditAccount },
      { prisma: handle!.prisma, stripe: { paymentIntents: { create } } as never },
    );
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
      where: { creditAccountId: embeddedError.creditAccount },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(attempt.stripePaymentIntentId).toBe('pi_auto_top_up_embedded');
    expect(result).toMatchObject({
      outcome: 'submitted',
      attemptId: attempt.id,
      stripePaymentIntentId: 'pi_auto_top_up_embedded',
      stripeStatus: 'processing',
    });
  }, 20_000);
});
