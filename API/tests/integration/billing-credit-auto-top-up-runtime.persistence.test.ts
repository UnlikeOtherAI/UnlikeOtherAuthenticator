import {
  BillingAssignmentScope,
  BillingCreditAutoTopUpConsentSource,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  claimCreditAutoTopUpAttempt,
  listCreditAutoTopUpCandidateIds,
  listCreditAutoTopUpWebhookCandidates,
} from '../../src/services/billing-credit-auto-top-up-attempt.service.js';
import {
  runCreditAutoTopUpCycle,
  runCreditAutoTopUpAccount,
} from '../../src/services/billing-credit-auto-top-up-runtime.service.js';
import { disableBillingCreditAutoTopUp } from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { applyTrustedCreditFundingStripeEvent } from '../../src/services/billing-stripe-webhook-event.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  user: 'usr_auto_top_up_runtime',
  org: 'org_auto_top_up_runtime',
  service: 'svc_auto_top_up_runtime',
  appKey: 'bak_auto_top_up_runtime',
  otherService: 'svc_auto_top_up_other',
  otherAppKey: 'bak_auto_top_up_other',
  rotatedAppKey: 'bak_auto_top_up_rotated',
  nonManagerUser: 'usr_auto_top_up_non_manager',
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
const pendingDisabled = scopedIds('pending-disabled');

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
        "id", "account_id", "customer_id", "org_id", "team_id", "scope", "scope_key", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${row.creditAccount}, ${ids.account}, ${row.customer}, ${ids.org}, ${row.team},
        'TEAM', ${`${ids.org}:${row.team}`}, 'USD', ${balanceMicrocredits}, CURRENT_TIMESTAMP
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
      "id", "account_id", "customer_id", "org_id", "team_id", "scope", "scope_key", "currency",
      "balance_microcredits", "auto_top_up_state", "auto_top_up_policy_id",
      "auto_top_up_service_id", "auto_top_up_app_key_id", "auto_top_up_consent_revision_id",
      "auto_top_up_option_id", "auto_top_up_threshold_microcredits",
      "auto_top_up_refill_offer_id", "auto_top_up_monthly_charge_cap_minor",
      "auto_top_up_consent_version", "auto_top_up_consented_at",
      "auto_top_up_consented_by_user_id", "stripe_payment_method_id",
      "payment_method_summary", "updated_at"
    ) VALUES (
      ${row.creditAccount}, ${ids.account}, ${row.customer}, ${ids.org}, ${row.team},
      'TEAM', ${`${ids.org}:${row.team}`}, 'USD',
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
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.otherService}, 'auto-top-up-other-test', 'Other Top Up Test', CURRENT_TIMESTAMP)
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
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES
        (
          ${ids.otherAppKey}, ${ids.otherService}, 'CUSTOMER_LIFECYCLE', 'Other top-up service',
          'uoa_auto_other', ${'b'.repeat(64)}, 'https://other-auto-top-up.example.com',
          'https://uoa.example.com', 'other-auto-top-up-key',
          ${JSON.stringify({ kty: 'RSA' })}::jsonb,
          ARRAY['https://other-auto-top-up.example.com'], CURRENT_TIMESTAMP
        ),
        (
          ${ids.rotatedAppKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Rotated top-up key',
          'uoa_auto_rotated', ${'c'.repeat(64)}, 'https://auto-top-up.example.com',
          'https://uoa.example.com', 'rotated-auto-top-up-key',
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
    await seedCreditAccount(tx, 'pending-disabled', 100_000_000n, true);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (
        ${ids.nonManagerUser}, 'auto-top-up-member@example.com',
        'auto-top-up-member@example.com', 'Auto Top Up Member'
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" (
        "id", "org_id", "user_id", "role", "status", "updated_at"
      ) VALUES (
        'om_auto_top_up_non_manager', ${ids.org}, ${ids.nonManagerUser}, 'member',
        'ACTIVE', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" (
        "id", "team_id", "user_id", "team_role", "status", "updated_at"
      ) VALUES (
        'tm_auto_top_up_non_manager', ${embeddedError.team}, ${ids.nonManagerUser},
        'member', 'ACTIVE', CURRENT_TIMESTAMP
      )
    `);
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

async function disableCreditAccountWithAuditEvidence(
  prisma: PrismaClient,
  creditAccountId: string,
  actorJti: string,
  requestTeamId: string,
  authorityScope: 'TEAM' | 'ORGANISATION' = 'TEAM',
  actor = { serviceId: ids.service, appKeyId: ids.appKey, product: 'auto-top-up-test' },
  userId = ids.user,
): Promise<void> {
  const original = await prisma.billingCreditAccount.findUniqueOrThrow({
    where: { id: creditAccountId },
  });
  const request = {
    product: actor.product,
    organisationId: ids.org,
    teamId: requestTeamId,
    userId,
  };
  await disableBillingCreditAutoTopUp(
    {
      request,
      actorToken: 'synthetic-manager-token',
      credential: { id: actor.appKeyId, service: { id: actor.serviceId } } as never,
      endpoint: '/billing/v1/credits/auto-top-up/disable' as never,
    },
    {
      prisma,
      resolveContext: vi.fn().mockResolvedValue({
        actor: { jti: actorJti, tv: 0, exp: 1_893_456_000 },
        account: stripeAccount,
        creditAccount: original,
        authorizeAction: async (tx: Prisma.TransactionClient) =>
          tx.billingCustomerActionIntent.create({
            data: {
              appKeyId: actor.appKeyId,
              serviceId: actor.serviceId,
              orgId: ids.org,
              teamId: requestTeamId,
              requestedByUserId: userId,
              authorityScope,
              operation: 'credit_auto_top_up_disable',
              actorJti,
              actorTokenVersion: 0,
              actorExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
              requestDigest: 'd'.repeat(64),
            },
          }),
      }) as never,
    },
  );
}

describe.skipIf(!databaseTestsEnabled)('credit automatic top-up PostgreSQL runtime', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('selects only active exact-team accounts below their configured threshold', async () => {
    const candidates = await listCreditAutoTopUpCandidateIds(
      { accountId: ids.account, limit: 10 },
      { prisma: handle!.prisma },
    );

    expect(candidates).toEqual(
      [
        concurrency.creditAccount,
        recovery.creditAccount,
        embeddedError.creditAccount,
        pendingDisabled.creditAccount,
      ].sort(),
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
        description: 'Automatic credit top-up',
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

  it('recovers the original PaymentIntent after a lost create response and credits it once under concurrent scans', async () => {
    const claim = await claimCreditAutoTopUpAttempt(
      { accountId: ids.account, creditAccountId: pendingDisabled.creditAccount },
      { prisma: handle!.prisma },
    );
    expect(claim.kind).toBe('dispatch');
    if (claim.kind !== 'dispatch') throw new Error('Expected a pending attempt');
    const attemptBeforeDisable = await handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({
      where: { id: claim.attemptId },
    });
    const intentId = 'pi_auto_top_up_pending_disabled';
    const candidateIds = await listCreditAutoTopUpCandidateIds(
      { accountId: ids.account, limit: 20 },
      { prisma: handle!.prisma },
    );
    expect(candidateIds).toContain(pendingDisabled.creditAccount);
    const webhookCandidates = await listCreditAutoTopUpWebhookCandidates(
      {
        accountId: ids.account,
        creditAccountIds: [pendingDisabled.creditAccount],
        limit: 20,
      },
      { prisma: handle!.prisma },
    );
    expect(webhookCandidates).toMatchObject([
      {
        attemptId: claim.attemptId,
        creditAccountId: pendingDisabled.creditAccount,
        stripePaymentIntentId: null,
      },
    ]);

    // A manager can revoke future consent while the original Stripe request is
    // unresolved. The old attempt remains bound to its original consent and
    // can settle only from the matching payment event.
    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: pendingDisabled.creditAccount },
        data: { stripePaymentMethodId: 'pm_unapproved_change' },
      }),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: pendingDisabled.creditAccount },
        data: {
          autoTopUpGeneration: { increment: 1 },
          autoTopUpState: 'DISABLED',
          autoTopUpPolicyId: null,
          autoTopUpServiceId: null,
          autoTopUpAppKeyId: null,
          autoTopUpConsentRevisionId: null,
          autoTopUpOptionId: null,
          autoTopUpThresholdMicrocredits: null,
          autoTopUpRefillOfferId: null,
          autoTopUpMonthlyChargeCapMinor: null,
          autoTopUpConsentVersion: null,
          autoTopUpConsentedAt: null,
          autoTopUpConsentedByUserId: null,
          stripePaymentMethodId: null,
          paymentMethodSummary: Prisma.DbNull,
        },
      }),
    ).rejects.toBeDefined();
    const disableActorJti = 'actor_auto_top_up_pending_disabled';
    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      pendingDisabled.creditAccount,
      disableActorJti,
      pendingDisabled.team,
      'TEAM',
      {
        serviceId: ids.otherService,
        appKeyId: ids.otherAppKey,
        product: 'auto-top-up-other-test',
      },
    );
    const disableEvent = await handle!.prisma.billingCreditAutoTopUpDisableEvent.findUniqueOrThrow({
      where: { appKeyId_actorJti: { appKeyId: ids.otherAppKey, actorJti: disableActorJti } },
    });
    expect(disableEvent).toMatchObject({
      serviceId: ids.otherService,
      appKeyId: ids.otherAppKey,
      teamId: pendingDisabled.team,
      previousConsentRevisionId: attemptBeforeDisable.consentRevisionId,
      previousGeneration: 0,
    });

    const now = new Date();
    const metadata = {
      uoa_credit_auto_top_up_attempt_id: claim.attemptId,
      uoa_service_id: ids.service,
      uoa_app_key_id: ids.appKey,
      uoa_credit_account_id: pendingDisabled.creditAccount,
    };
    const paidIntent = {
      id: intentId,
      object: 'payment_intent',
      amount: 500,
      amount_received: 500,
      currency: 'usd',
      customer: `cus_auto_top_up_pending-disabled`,
      payment_method: `pm_auto_top_up_pending-disabled`,
      latest_charge: 'ch_auto_top_up_pending_disabled',
      livemode: false,
      status: 'succeeded',
      metadata,
    } as Stripe.PaymentIntent;
    const successEvent = {
      id: 'evt_auto_top_up_pending_disabled_success',
      type: 'payment_intent.succeeded',
      api_version: '2026-06-24.dahlia',
      account: stripeAccount.stripeAccountId,
      livemode: false,
      created: Math.floor(now.getTime() / 1000),
      data: { object: paidIntent },
    } as Stripe.Event;
    const failedEvent = {
      ...successEvent,
      id: 'evt_auto_top_up_pending_disabled_failure',
      type: 'payment_intent.payment_failed',
      created: Math.floor(now.getTime() / 1000) - 1,
      data: {
        object: {
          ...paidIntent,
          status: 'requires_payment_method',
          last_payment_error: { code: 'card_declined' },
        },
      },
    } as Stripe.Event;
    const stripe = {
      accounts: {
        retrieveCurrent: vi.fn().mockResolvedValue({ id: stripeAccount.stripeAccountId }),
      },
      events: {
        list: vi.fn().mockResolvedValue({ data: [successEvent, failedEvent], has_more: false }),
      },
      paymentIntents: {
        create: vi.fn(),
        retrieve: vi.fn().mockResolvedValue(paidIntent),
      },
      checkout: { sessions: { retrieve: vi.fn(), list: vi.fn() } },
      paymentMethods: { retrieve: vi.fn() },
      prices: { retrieve: vi.fn() },
      products: { retrieve: vi.fn() },
      disputes: { retrieve: vi.fn() },
      refunds: { retrieve: vi.fn() },
      setupIntents: { retrieve: vi.fn() },
    } as never;
    const runCycle = () =>
      runCreditAutoTopUpCycle({
        prisma: handle!.prisma,
        stripe,
        stripeLivemode: false,
        listCandidates: vi.fn().mockResolvedValue([pendingDisabled.creditAccount]),
        now: () => now,
    });
    const [first, second] = await Promise.all([runCycle(), runCycle()]);
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({
      where: { id: claim.attemptId },
    });
    const entries = await handle!.prisma.billingCreditEntry.findMany({
      where: {
        sourceType: 'credit_auto_top_up_attempt',
        sourceId: claim.attemptId,
      },
    });
    const creditAccount = await handle!.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: pendingDisabled.creditAccount },
    });

    expect(attempt.status).toBe('SUCCEEDED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amountMicrocredits).toBe(5_000_000_000n);
    expect(creditAccount.balanceMicrocredits).toBe(5_100_000_000n);
    expect(creditAccount.autoTopUpState).toBe('DISABLED');
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripe.events.list).toHaveBeenCalledTimes(2);
    expect([first, second].map((result) => result.recovered).sort()).toEqual([0, 1]);

    const replay = await applyTrustedCreditFundingStripeEvent({
      event: successEvent,
      expectedPaymentIntentId: intentId,
      stripe,
      account: stripeAccount,
      prisma: handle!.prisma,
    });
    expect(replay).toEqual({ duplicate: true, applied: false });
    await expect(
      handle!.prisma.billingCreditEntry.count({
        where: {
          sourceType: 'credit_auto_top_up_attempt',
          sourceId: claim.attemptId,
        },
      }),
    ).resolves.toBe(1);
  }, 20_000);

  it('requires current manager authority and allows an audited disable with a rotated key', async () => {
    const attempt = await handle!.prisma.billingCreditAutoTopUpAttempt.findFirstOrThrow({
      where: { creditAccountId: embeddedError.creditAccount },
    });
    expect(attempt.stripePaymentIntentId).toBe('pi_auto_top_up_embedded');

    await expect(
      handle!.prisma.billingCreditAccount.update({
        where: { id: embeddedError.creditAccount },
        data: { autoTopUpThresholdMicrocredits: 150_000_000n },
      }),
    ).rejects.toBeDefined();

    await expect(
      disableCreditAccountWithAuditEvidence(
        handle!.prisma,
        embeddedError.creditAccount,
        'actor_auto_top_up_non_manager_disable',
        embeddedError.team,
        'TEAM',
        undefined,
        ids.nonManagerUser,
      ),
    ).rejects.toBeDefined();
    await expect(
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: embeddedError.creditAccount },
      }),
    ).resolves.toMatchObject({ autoTopUpState: 'ACTIVE' });

    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      embeddedError.creditAccount,
      'actor_auto_top_up_embedded_disable',
      embeddedError.team,
      'TEAM',
      { serviceId: ids.service, appKeyId: ids.rotatedAppKey, product: 'auto-top-up-test' },
    );

    const [creditAccount, savedAttempt, disableEvent] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({
        where: { id: embeddedError.creditAccount },
      }),
      handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      handle!.prisma.billingCreditAutoTopUpDisableEvent.findUniqueOrThrow({
        where: {
          appKeyId_actorJti: {
            appKeyId: ids.rotatedAppKey,
            actorJti: 'actor_auto_top_up_embedded_disable',
          },
        },
      }),
    ]);
    expect(creditAccount.autoTopUpState).toBe('DISABLED');
    expect(disableEvent).toMatchObject({
      serviceId: ids.service,
      appKeyId: ids.rotatedAppKey,
      teamId: embeddedError.team,
      previousConsentRevisionId: attempt.consentRevisionId,
      previousGeneration: 0,
    });
    expect(savedAttempt).toMatchObject({
      consentRevisionId: attempt.consentRevisionId,
      stripePaymentIntentId: 'pi_auto_top_up_embedded',
    });
  }, 20_000);

  it('matches the audited disable to a NULL team for organization-scoped credits', async () => {
    const customerId = 'bsc_auto_top_up_organization';
    const creditAccountId = 'bca_auto_top_up_organization';
    const revisionId = 'bcar_auto_top_up_organization';
    const attemptId = 'bcattempt_auto_top_up_organization';
    const paymentMethodSummary = { type: 'card', brand: 'visa', last4: '4242' };
    const consentedAt = new Date('2026-07-21T12:00:00.000Z');

    await handle!.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingStripeCustomer.create({
        data: {
          id: customerId,
          accountId: ids.account,
          orgId: ids.org,
          scope: BillingAssignmentScope.ORGANISATION,
          scopeKey: ids.org,
          stripeCustomerId: 'cus_auto_top_up_organization',
        },
      });
      await tx.billingCreditAccount.create({
        data: {
          id: creditAccountId,
          accountId: ids.account,
          customerId,
          orgId: ids.org,
          teamId: null,
          scope: BillingAssignmentScope.ORGANISATION,
          scopeKey: ids.org,
        },
      });
      await tx.billingCreditAutoTopUpConsentRevision.create({
        data: {
          id: revisionId,
          accountId: ids.account,
          creditAccountId,
          orgId: ids.org,
          teamId: null,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          policyId: ids.policy,
          optionId: ids.option,
          refillOfferId: ids.offer,
          source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
          actorJti: 'actor_auto_top_up_organization_setup',
          consentedByUserId: ids.user,
          consentVersion: 'auto-top-up-v1',
          thresholdMicrocredits: 200_000_000n,
          refillCreditsMicrocredits: 5_000_000_000n,
          refillPaymentAmountMinor: 500n,
          monthlyChargeCapMinor: 1_500n,
          stripePaymentMethodId: 'pm_auto_top_up_organization',
          paymentMethodSummary,
          consentedAt,
        },
      });
      await tx.billingCreditAccount.update({
        where: { id: creditAccountId },
        data: {
          autoTopUpGeneration: 1,
          autoTopUpState: 'ACTIVE',
          autoTopUpPolicyId: ids.policy,
          autoTopUpServiceId: ids.service,
          autoTopUpAppKeyId: ids.appKey,
          autoTopUpConsentRevisionId: revisionId,
          autoTopUpOptionId: ids.option,
          autoTopUpThresholdMicrocredits: 200_000_000n,
          autoTopUpRefillOfferId: ids.offer,
          autoTopUpMonthlyChargeCapMinor: 1_500n,
          autoTopUpConsentVersion: 'auto-top-up-v1',
          autoTopUpConsentedAt: consentedAt,
          autoTopUpConsentedByUserId: ids.user,
          stripePaymentMethodId: 'pm_auto_top_up_organization',
          paymentMethodSummary,
        },
      });
      await tx.billingCreditAutoTopUpAttempt.create({
        data: {
          id: attemptId,
          accountId: ids.account,
          creditAccountId,
          catalogId: ids.catalog,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          attributedUserId: ids.user,
          optionId: ids.option,
          offerId: ids.offer,
          consentRevisionId: revisionId,
          consentVersion: 'auto-top-up-v1',
          thresholdMicrocredits: 200_000_000n,
          monthlyChargeCapMinor: 1_500n,
          chargedThisMonthBeforeMinor: 0n,
          observedBalanceMicrocredits: 0n,
          paymentAmountMinor: 500n,
          creditsReceivedMicrocredits: 5_000_000_000n,
          billingMonth: '2026-10',
          idempotencyKey: `uoa:auto-top-up:${attemptId}`,
        },
      });
    });

    await expect(
      handle!.prisma.$transaction(async (tx) => {
        await tx.billingCreditAutoTopUpDisableEvent.create({
          data: {
            accountId: ids.account,
            creditAccountId,
            orgId: ids.org,
            teamId: concurrency.team,
            serviceId: ids.service,
            appKeyId: ids.appKey,
            previousConsentRevisionId: revisionId,
            previousGeneration: 1,
            actorJti: 'actor_auto_top_up_wrong_team',
            requestedByUserId: ids.user,
          },
        });
      }),
    ).rejects.toBeDefined();

    await disableCreditAccountWithAuditEvidence(
      handle!.prisma,
      creditAccountId,
      'actor_auto_top_up_organization_disable',
      concurrency.team,
      'ORGANISATION',
    );
    const [creditAccount, attempt] = await Promise.all([
      handle!.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: creditAccountId } }),
      handle!.prisma.billingCreditAutoTopUpAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    ]);
    expect(creditAccount).toMatchObject({
      teamId: null,
      autoTopUpGeneration: 2,
      autoTopUpState: 'DISABLED',
    });
    expect(attempt).toMatchObject({ status: 'PENDING', consentRevisionId: revisionId });
  }, 20_000);
});
