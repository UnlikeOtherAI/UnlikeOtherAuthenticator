import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyRecurringAddonWebhook } from '../../src/services/billing-recurring-addon-webhook-apply.service.js';
import type { PreparedRecurringAddonWebhook } from '../../src/services/billing-recurring-addon-webhook.service.js';
import type { StripeAccountContext } from '../../src/services/billing-stripe-client.service.js';
import { recurringAddonSubscriptionInclude } from '../../src/services/billing-recurring-addon-subscription.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  user: 'usr_addon_renewal',
  org: 'org_addon_renewal',
  team: 'team_addon_renewal',
  service: 'svc_addon_renewal',
  appKey: 'bak_addon_renewal',
  account: 'bsa_addon_renewal',
  customer: 'bsc_addon_renewal',
  offer: 'rao_addon_renewal',
  catalog: 'rac_addon_renewal',
  checkout: 'rco_addon_renewal',
  subscription: 'ras_addon_renewal',
  checkoutEvent: 'evt_addon_renewal_checkout',
  initialEvent: 'evt_addon_renewal_initial',
} as const;

const account: StripeAccountContext = {
  id: ids.account,
  stripeAccountId: 'acct_addon_renewal_test',
  livemode: false,
};
const initialPaidAt = new Date('2026-07-21T12:00:00.000Z');
const activatedAt = initialPaidAt;

async function seedRenewalSubject(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'addon-renewal@example.com', 'addon-renewal@example.com', 'Renewal Test')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'addon-renewal.example.com', 'Renewal Org', 'addon-renewal', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Renewal Team', 'addon-renewal', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'addon-renewal-test', 'Add-on Renewal Test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Renewal test',
        'uoa_renewal', ${'d'.repeat(64)}, 'https://addon.example.com',
        'https://uoa.example.com', 'renewal-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://addon.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, ${account.stripeAccountId}, false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key",
        "stripe_customer_id", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, 'cus_addon_renewal_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_offers" (
        "id", "service_id", "key", "version", "name", "description",
        "monthly_amount_minor", "currency", "updated_at"
      ) VALUES (
        ${ids.offer}, ${ids.service}, 'privacy', 1, 'Privacy', 'Renewal fixture',
        5000, 'USD', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_catalogs" (
        "id", "account_id", "service_id", "offer_id", "currency",
        "monthly_amount_minor", "stripe_lookup_key", "stripe_product_id", "stripe_price_id", "updated_at"
      ) VALUES (
        ${ids.catalog}, ${ids.account}, ${ids.service}, ${ids.offer}, 'USD',
        5000, 'addon-renewal-v1', 'prod_addon_renewal_test', 'price_addon_renewal_test', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_webhook_events" (
        "id", "account_id", "stripe_event_id", "type", "api_version", "livemode",
        "stripe_created_at", "stripe_object_id", "stripe_object_status", "stripe_customer_id",
        "stripe_checkout_session_id", "stripe_subscription_id"
      ) VALUES (
        ${ids.checkoutEvent}, ${ids.account}, 'evt_checkout_addon_renewal', 'checkout.session.completed',
        '2026-06-24.dahlia', false, ${initialPaidAt}, 'cs_addon_renewal_test', 'complete',
        'cus_addon_renewal_test', 'cs_addon_renewal_test', 'sub_addon_renewal_test'
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_webhook_events" (
        "id", "account_id", "stripe_event_id", "type", "api_version", "livemode",
        "stripe_created_at", "stripe_object_id", "stripe_object_status", "stripe_customer_id",
        "stripe_subscription_id", "stripe_subscription_item_id", "stripe_invoice_id", "amount_minor", "currency"
      ) VALUES (
        ${ids.initialEvent}, ${ids.account}, 'evt_initial_addon_renewal', 'invoice.paid',
        '2026-06-24.dahlia', false, ${initialPaidAt}, 'in_addon_initial_test', 'paid',
        'cus_addon_renewal_test', 'sub_addon_renewal_test', 'si_addon_renewal_test',
        'in_addon_initial_test', 5000, 'USD'
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_checkouts" (
        "id", "account_id", "app_key_id", "customer_id", "catalog_id", "service_id", "offer_id", "offer_key",
        "org_id", "team_id", "requested_team_id", "scope", "scope_key", "actor_jti", "subject_fingerprint",
        "requested_by_user_id", "success_url_digest", "cancel_url_digest", "stripe_checkout_session_id",
        "stripe_subscription_id", "completion_webhook_event_id", "status", "lease_expires_at", "completed_at", "updated_at"
      ) VALUES (
        ${ids.checkout}, ${ids.account}, ${ids.appKey}, ${ids.customer}, ${ids.catalog}, ${ids.service}, ${ids.offer}, 'privacy',
        ${ids.org}, ${ids.team}, ${ids.team}, 'TEAM', ${`${ids.org}:${ids.team}`}, 'addon-renewal-jti', ${'a'.repeat(64)},
        ${ids.user}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'cs_addon_renewal_test', 'sub_addon_renewal_test',
        ${ids.checkoutEvent}, 'COMPLETE', ${initialPaidAt}, ${initialPaidAt}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_recurring_addon_subscriptions" (
        "id", "account_id", "checkout_id", "customer_id", "catalog_id", "service_id", "offer_id", "offer_key",
        "org_id", "team_id", "scope", "scope_key", "stripe_subscription_id", "stripe_item_id", "status",
        "current_period_start", "current_period_end", "initial_invoice_paid_at", "initial_invoice_id",
        "activation_webhook_event_id", "entitlement_activated_at", "livemode", "updated_at"
      ) VALUES (
        ${ids.subscription}, ${ids.account}, ${ids.checkout}, ${ids.customer}, ${ids.catalog}, ${ids.service}, ${ids.offer}, 'privacy',
        ${ids.org}, ${ids.team}, 'TEAM', ${`${ids.org}:${ids.team}`}, 'sub_addon_renewal_test', 'si_addon_renewal_test', 'active',
        ${initialPaidAt}, ${new Date('2026-08-01T00:00:00.000Z')}, ${initialPaidAt}, 'in_addon_initial_test',
        ${ids.initialEvent}, ${activatedAt}, false, CURRENT_TIMESTAMP
      )
    `);
  });
}

function renewalPrepared(
  local: NonNullable<
    Awaited<ReturnType<PrismaClient['billingRecurringAddonSubscription']['findUnique']>>
  >,
  remoteStatus: string,
  periodEndSeconds: number,
  eventAt: Date,
): PreparedRecurringAddonWebhook {
  const remote = {
    id: 'sub_addon_renewal_test',
    status: remoteStatus,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_start: periodEndSeconds - 2_678_400,
          current_period_end: periodEndSeconds,
        },
      ],
    },
  } as unknown as import('stripe').default.Subscription;
  return {
    kind: 'invoice_renewal',
    local: local as never,
    remote,
    invoice: {} as never,
    eventAt,
    eventFields: {},
  };
}

describe.skipIf(!databaseTestsEnabled)('recurring add-on renewal database lifecycle', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seedRenewalSubject(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('advances paid renewal periods while preserving initial proof and terminal cancellation', async () => {
    if (!handle) throw new Error('db handle missing');

    const initial = await handle.prisma.billingRecurringAddonSubscription.findUniqueOrThrow({
      where: { id: ids.subscription },
      include: recurringAddonSubscriptionInclude,
    });
    const periodEnd1 = Math.floor(new Date('2026-09-01T00:00:00.000Z').getTime() / 1000);
    await handle.prisma.$transaction(async (tx) => {
      const event = await tx.billingStripeWebhookEvent.create({
        data: {
          accountId: ids.account,
          stripeEventId: 'evt_cycle_addon_month_1',
          type: 'invoice.paid',
          livemode: false,
          stripeCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
          stripeObjectId: 'in_addon_cycle_1',
          stripeCustomerId: 'cus_addon_renewal_test',
          stripeSubscriptionId: 'sub_addon_renewal_test',
          stripeSubscriptionItemId: 'si_addon_renewal_test',
          stripeInvoiceId: 'in_addon_cycle_1',
          amountMinor: 5000n,
          currency: 'USD',
        },
      });
      await applyRecurringAddonWebhook(
        tx,
        renewalPrepared(initial, 'active', periodEnd1, new Date('2026-08-01T00:00:00.000Z')),
        event.id,
        account,
      );
    });

    const renewed = await handle.prisma.billingRecurringAddonSubscription.findUniqueOrThrow({
      where: { id: ids.subscription },
    });
    expect(renewed.currentPeriodEnd).toEqual(new Date(periodEnd1 * 1000));
    expect(renewed.initialInvoiceId).toBe('in_addon_initial_test');
    expect(renewed.initialInvoicePaidAt).toEqual(initialPaidAt);
    expect(renewed.activationWebhookEventId).toBe(ids.initialEvent);
    expect(renewed.entitlementActivatedAt).toEqual(activatedAt);

    const canceledAt = new Date('2026-08-02T00:00:00.000Z');
    const terminalLocal = await handle.prisma.billingRecurringAddonSubscription.findUniqueOrThrow({
      where: { id: ids.subscription },
      include: recurringAddonSubscriptionInclude,
    });
    await handle.prisma.$transaction(async (tx) => {
      const event = await tx.billingStripeWebhookEvent.create({
        data: {
          accountId: ids.account,
          stripeEventId: 'evt_addon_terminal',
          type: 'customer.subscription.deleted',
          livemode: false,
          stripeCreatedAt: canceledAt,
        },
      });
      await applyRecurringAddonWebhook(
        tx,
        {
          kind: 'subscription_sync',
          local: terminalLocal,
          remote: null,
          eventAt: canceledAt,
          eventFields: {},
        },
        event.id,
        account,
      );
    });

    const terminal = await handle.prisma.billingRecurringAddonSubscription.findUniqueOrThrow({
      where: { id: ids.subscription },
      include: recurringAddonSubscriptionInclude,
    });
    const latePeriodEnd = Math.floor(new Date('2026-10-01T00:00:00.000Z').getTime() / 1000);
    await handle.prisma.$transaction(async (tx) => {
      const event = await tx.billingStripeWebhookEvent.create({
        data: {
          accountId: ids.account,
          stripeEventId: 'evt_addon_late_renewal',
          type: 'invoice.paid',
          livemode: false,
          stripeCreatedAt: new Date('2026-09-01T00:00:00.000Z'),
          stripeObjectId: 'in_addon_cycle_late',
          stripeCustomerId: 'cus_addon_renewal_test',
          stripeSubscriptionId: 'sub_addon_renewal_test',
          stripeSubscriptionItemId: 'si_addon_renewal_test',
          stripeInvoiceId: 'in_addon_cycle_late',
          amountMinor: 5000n,
          currency: 'USD',
        },
      });
      await applyRecurringAddonWebhook(
        tx,
        renewalPrepared(terminal, 'active', latePeriodEnd, new Date('2026-09-01T00:00:00.000Z')),
        event.id,
        account,
      );
    });

    const afterLateRenewal =
      await handle.prisma.billingRecurringAddonSubscription.findUniqueOrThrow({
        where: { id: ids.subscription },
      });
    expect(afterLateRenewal.status).toBe('canceled');
    expect(afterLateRenewal.currentPeriodEnd).toEqual(new Date(periodEnd1 * 1000));
    expect(afterLateRenewal.entitlementDeactivatedAt).toEqual(canceledAt);
    expect(afterLateRenewal.initialInvoiceId).toBe('in_addon_initial_test');
    expect(afterLateRenewal.activationWebhookEventId).toBe(ids.initialEvent);
  });
});
