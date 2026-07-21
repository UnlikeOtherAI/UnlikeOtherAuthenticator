import {
  BillingCreditPaymentAdjustmentKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyPaymentAdjustment } from '../../src/services/billing-credit-payment-adjustment-webhook.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  user: 'usr_payment_adjustment',
  org: 'org_payment_adjustment',
  team: 'team_payment_adjustment',
  service: 'svc_payment_adjustment',
  appKey: 'bak_payment_adjustment',
  account: 'bsa_payment_adjustment',
  customer: 'bsc_payment_adjustment',
  creditAccount: 'bca_payment_adjustment',
} as const;

const stripeAccount = {
  id: ids.account,
  stripeAccountId: 'acct_payment_adjustment',
  livemode: false,
};

async function seedPaidCredits(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'credits@example.com', 'credits@example.com', 'Credits Owner')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'credits.example.com', 'Credits Org', 'credits-org', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Credits Team', 'credits-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'credits-test', 'Credits Test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Credits test', 'uoa_test',
        ${'a'.repeat(64)}, 'https://credits.example.com', 'https://uoa.example.com',
        'credits-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://credits.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, ${stripeAccount.stripeAccountId}, false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key",
        "stripe_customer_id", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, 'cus_payment_adjustment', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${ids.creditAccount}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'USD', 20000000000, CURRENT_TIMESTAMP
      )
    `);
    for (const [suffix, balanceAfter] of [
      ['partial', 10_000_000_000n],
      ['overlap', 20_000_000_000n],
    ] as const) {
      const checkoutId = `checkout_${suffix}`;
      const entryId = `entry_${suffix}`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_credit_top_up_checkouts" (
          "id", "account_id", "credit_account_id", "customer_id", "catalog_id",
          "service_id", "app_key_id", "offer_id", "actor_jti", "requested_by_user_id",
          "payment_amount_minor", "credits_received_microcredits", "currency",
          "success_url_digest", "cancel_url_digest", "stripe_checkout_session_id",
          "stripe_payment_intent_id", "completion_webhook_event_id", "status",
          "lease_expires_at", "completed_at", "credit_entry_id", "updated_at"
        ) VALUES (
          ${checkoutId}, ${ids.account}, ${ids.creditAccount}, ${ids.customer}, 'catalog_seed',
          ${ids.service}, ${ids.appKey}, 'offer_seed', ${`actor_${suffix}`}, ${ids.user},
          1000, 10000000000, 'USD', ${'b'.repeat(64)}, ${'c'.repeat(64)},
          ${`cs_${suffix}`}, ${`pi_${suffix}`}, ${`webhook_success_${suffix}`}, 'COMPLETE',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ${entryId}, CURRENT_TIMESTAMP
        )
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_credit_entries" (
          "id", "credit_account_id", "service_id", "app_key_id", "attributed_user_id",
          "direction", "kind", "amount_microcredits", "balance_after_microcredits",
          "currency", "idempotency_key", "source_type", "source_id", "occurred_at"
        ) VALUES (
          ${entryId}, ${ids.creditAccount}, ${ids.service}, ${ids.appKey}, ${ids.user},
          'CREDIT', 'TOP_UP', 10000000000, ${balanceAfter}, 'USD', ${`paid_${suffix}`},
          'credit_top_up_checkout', ${checkoutId}, CURRENT_TIMESTAMP
        )
      `);
    }
  });
}

type AdjustmentInput = {
  checkout: 'overlap' | 'partial';
  kind: BillingCreditPaymentAdjustmentKind;
  objectId: string;
  amountMinor: bigint;
  eventType: string;
  status?: string;
};

async function applyAdjustment(prisma: PrismaClient, input: AdjustmentInput): Promise<void> {
  const paymentIntentId = `pi_${input.checkout}`;
  const chargeId = `ch_${input.checkout}`;
  const occurredAt = new Date(Date.now() + Math.floor(Math.random() * 10_000));
  const eventId = `evt_${input.kind.toLowerCase()}_${input.objectId}`;
  await prisma.$transaction(async (tx) => {
    const webhook = await tx.billingStripeWebhookEvent.create({
      data: {
        accountId: ids.account,
        stripeEventId: eventId,
        type: input.eventType,
        apiVersion: '2026-06-24.dahlia',
        livemode: false,
        stripeCreatedAt: occurredAt,
        stripeObjectId: input.objectId,
        stripeObjectStatus: input.status ?? null,
        stripeCustomerId: 'cus_payment_adjustment',
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        amountMinor: input.amountMinor,
        currency: 'USD',
      },
    });
    await applyPaymentAdjustment(
      tx,
      {
        kind: 'payment_adjustment',
        localId: `checkout_${input.checkout}`,
        localType: 'top_up',
        adjustmentKind: input.kind,
        stripeObjectId: input.objectId,
        paymentIntent: {
          id: paymentIntentId,
          customer: 'cus_payment_adjustment',
          latest_charge: chargeId,
          payment_method: 'pm_payment_adjustment',
        } as never,
        paymentIntentId,
        chargeId,
        amountMinor: input.amountMinor,
        currency: 'USD',
        occurredAt,
      },
      webhook.id,
      stripeAccount,
    );
  });
}

describe.skipIf(!databaseTestsEnabled)('credit payment adjustment persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
  }, 60_000);

  beforeEach(async () => {
    await handle.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "users", "billing_services", "billing_stripe_accounts" CASCADE',
    );
    await seedPaidCredits(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('applies and partially reinstates exact dispute principal across GBP settlement', async () => {
    await applyAdjustment(handle.prisma, {
      checkout: 'partial',
      kind: BillingCreditPaymentAdjustmentKind.DISPUTE,
      objectId: 'dp_partial',
      amountMinor: 1000n,
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await applyAdjustment(handle.prisma, {
      checkout: 'partial',
      kind: BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL,
      objectId: 'dp_partial',
      amountMinor: 400n,
      eventType: 'charge.dispute.funds_reinstated',
    });

    const rows = await handle.prisma.billingCreditPaymentAdjustment.findMany({
      where: { originalEntryId: 'entry_partial' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.amountMicrocredits)).toEqual([
      10_000_000_000n,
      4_000_000_000n,
    ]);
  });

  it('reconciles refund/dispute overlap without restoring credits still under dispute', async () => {
    const initial = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    await applyAdjustment(handle.prisma, {
      checkout: 'overlap',
      kind: BillingCreditPaymentAdjustmentKind.REFUND,
      objectId: 're_overlap',
      amountMinor: 200n,
      eventType: 'refund.updated',
      status: 'succeeded',
    });
    await applyAdjustment(handle.prisma, {
      checkout: 'overlap',
      kind: BillingCreditPaymentAdjustmentKind.DISPUTE,
      objectId: 'dp_overlap',
      amountMinor: 1000n,
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await applyAdjustment(handle.prisma, {
      checkout: 'overlap',
      kind: BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL,
      objectId: 're_overlap',
      amountMinor: 200n,
      eventType: 'refund.failed',
      status: 'failed',
    });
    await applyAdjustment(handle.prisma, {
      checkout: 'overlap',
      kind: BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL,
      objectId: 'dp_overlap',
      amountMinor: 1000n,
      eventType: 'charge.dispute.funds_reinstated',
    });

    const rows = await handle.prisma.billingCreditPaymentAdjustment.findMany({
      where: { originalEntryId: 'entry_overlap' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.amountMicrocredits)).toEqual([
      2_000_000_000n,
      8_000_000_000n,
      0n,
      10_000_000_000n,
    ]);
    expect(rows[2].creditEntryId).toBeNull();
    const account = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    expect(account.balanceMicrocredits).toBe(initial.balanceMicrocredits);
  });
});
