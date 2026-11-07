import { BillingAppKeyPurpose, Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { exportStripeUsage } from '../../src/services/billing-stripe-usage.service.js';
import type { NormalizedMeteringPortfolio, NormalizedMeteringUsage } from '../../src/services/billing-metering.types.js';
import { createTestDb } from '../helpers/test-db.js';
import { usageFixture } from '../unit/billing-stripe-usage.test-fixtures.js';

const enabled = process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);
const ids = {
  user: 'usr_credit_stripe_race', org: 'org_credit_stripe_race', team: 'team_credit_stripe_race',
  service: 'svc_credit_stripe_race', tariff: 'tariff_credit_stripe_race',
  appKey: 'bak_credit_stripe_race', account: 'bsa_credit_stripe_race',
  customer: 'bsc_credit_stripe_race', credit: 'bca_credit_stripe_race',
  checkout: 'bsch_credit_stripe_race', subscription: 'bss_credit_stripe_race',
} as const;
const month = '2026-10';
const currency = 'USD';
const initialMeterQuantity = 130_000_000n;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function withPayerLockHook(client: PrismaClient, afterAcquired: (tx: Prisma.TransactionClient) => Promise<void>): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        target.$transaction(async (tx) => callback(new Proxy(tx, {
          get(transaction, method, transactionReceiver) {
            if (method !== '$queryRaw') return Reflect.get(transaction, method, transactionReceiver);
            return async (...args: unknown[]) => {
              const result = await (transaction.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
              const sql = String((args[0] as { strings?: readonly string[] })?.strings?.join('') ?? '');
              if (sql.includes('billing_credit_accounts') && sql.includes('FOR UPDATE')) {
                await afterAcquired(transaction);
              }
              return result;
            };
          },
        })), options as never);
    },
  });
}

async function waitForCollectionLockWait(prisma: PrismaClient, blockingPid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waits = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND ${blockingPid} = ANY(pg_blocking_pids(pid))
        AND query LIKE '%assert_billing_period_mode%'
    `);
    if ((waits[0]?.count ?? 0n) > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('competing transaction never waited on the winning collection fence');
}

async function waitUntil(ready: Promise<void>, task: Promise<unknown>) {
  await Promise.race([ready, task.then(() => { throw new Error('Billing task completed before its expected lock'); })]);
}

function portfolio(cursor: string, capturedAt: string, cost: string): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1, contract: 'metering-portfolio-v1', perspectiveProduct: 'deepwater',
    groupBy: 'user', billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    scope: {
      organizationId: ids.org, teamId: ids.team, month,
      startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z',
    },
    calls: '1',
    lines: [{
      serviceId: 'provider_openai', usageUnit: 'tokens', calls: '1', inputUnits: '0',
      cachedInputUnits: '0', outputUnits: '0', estimatedProviderCost: cost,
      actualProviderCost: cost, selectedProviderCost: cost, currency,
      costProvenance: 'actual', billingDisposition: 'paid', billingProduct: 'deepwater',
      callerProduct: 'deepwater', originProduct: 'deepwater', userId: ids.user,
    }],
    snapshot: { id: cursor, cursor, capturedAt, immutable: true, sha256: 'a'.repeat(64) },
  };
}

function usage(cursor: string, capturedAt: string, cost: string): NormalizedMeteringUsage {
  const fixture = usageFixture(cost, cursor);
  return {
    ...fixture,
    scope: {
      ...fixture.scope, organizationId: ids.org, teamId: ids.team, month,
      startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z',
    },
    lines: fixture.lines.map((line) => ({
      ...line, callerProduct: 'deepwater', originProduct: 'deepwater', userId: ids.user,
    })),
    snapshot: { ...fixture.snapshot, id: cursor, cursor, capturedAt },
  };
}

const credential = {
  id: ids.appKey, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://deepwater.example.com',
  actorAudience: 'https://uoa.example.com/billing/v1/effective-tariff',
  actorKeyId: 'deepwater-key', actorPublicJwk: {},
  checkoutReturnOrigins: ['https://deepwater.example.com'],
  service: { id: ids.service, identifier: 'deepwater', name: 'DeepWater' },
};

async function seed(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'credit-race@example.test', 'credit-race@example.test', 'Race User')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'credit-race.example.test', 'Race Org', 'credit-race', ${ids.user}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" ("id", "org_id", "user_id", "role", "status", "updated_at")
      VALUES ('om_credit_stripe_race', ${ids.org}, ${ids.user}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Race Team', 'race-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" ("id", "team_id", "user_id", "team_role", "status", "updated_at")
      VALUES ('tm_credit_stripe_race', ${ids.team}, ${ids.user}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "tariff_history_from_month", "updated_at")
      VALUES (${ids.service}, 'deepwater', 'DeepWater', '2026-10', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariffs" ("id", "service_id", "key", "version", "name", "mode",
        "collection_mode", "markup_bps", "currency", "is_default")
      VALUES (${ids.tariff}, ${ids.service}, 'stripe', 1, 'Stripe race', 'STANDARD',
        'STRIPE', 0, 'USD', true)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariff_term_events" ("id", "service_id", "source", "scope_key",
        "effective_from_month", "tariff_id", "reason")
      VALUES ('btte_credit_stripe_race', ${ids.service}, 'SERVICE_DEFAULT', ${ids.service},
        '2026-10', ${ids.tariff}, 'test-fixture')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" ("id", "service_id", "purpose", "name", "key_prefix",
        "secret_digest", "actor_issuer", "actor_audience", "actor_key_id",
        "actor_public_jwk", "checkout_return_origins", "updated_at")
      VALUES (${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'Race key', 'uoa_race',
        ${'a'.repeat(64)}, 'https://deepwater.example.com', 'https://uoa.example.com',
        'deepwater-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://deepwater.example.com'], CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_credit_stripe_race', false, CURRENT_TIMESTAMP)
    `);
  });
  await prisma.billingTeamMode.create({ data: { teamId: ids.team, sandbox: true, revision: 1 } });
  await prisma.billingStripeCustomer.create({
    data: { id: ids.customer, accountId: ids.account, orgId: ids.org, teamId: ids.team,
      scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`, stripeCustomerId: 'cus_credit_stripe_race' },
  });
  await prisma.billingCreditAccount.create({
    data: {
      createdAt: new Date('2026-01-01T00:00:00Z'), id: ids.credit, accountId: ids.account, customerId: ids.customer,
      orgId: ids.org, teamId: ids.team, scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`,
      currency, balanceMicrocredits: 0n },
  });
  const catalog = await prisma.billingStripeCatalog.create({
    data: { accountId: ids.account, serviceId: ids.service, currency,
      meterEventName: 'uoa_race_usage', stripeProductId: 'prod_credit_stripe_race',
      stripeMeterId: 'mtr_credit_stripe_race', stripeUsagePriceId: 'price_credit_stripe_race' },
  });
  await prisma.billingStripeTariffPrice.create({
    data: { accountId: ids.account, tariffId: ids.tariff, catalogId: catalog.id,
      monthlyAmountMinor: 0n },
  });
  await prisma.billingStripeCheckoutSession.create({
    data: {
      billingModeTeamId: ids.team, billingModeRevision: 1, id: ids.checkout, accountId: ids.account, appKeyId: ids.appKey,
      customerId: ids.customer, serviceId: ids.service, tariffId: ids.tariff,
      tariffSource: 'SERVICE_DEFAULT', orgId: ids.org, teamId: ids.team,
      scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`, actorJti: 'race-checkout',
      requestedByUserId: ids.user, successUrlDigest: 'a'.repeat(64),
      cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date('2026-10-05T00:00:00.000Z') },
  });
  await prisma.billingStripeSubscription.create({
    data: {
      createdAt: new Date('2026-01-01T00:00:00Z'), id: ids.subscription, accountId: ids.account, checkoutId: ids.checkout,
      customerId: ids.customer, serviceId: ids.service, tariffId: ids.tariff,
      tariffSource: 'SERVICE_DEFAULT', orgId: ids.org, teamId: ids.team,
      scope: 'TEAM', scopeKey: `${ids.org}:${ids.team}`,
      stripeSubscriptionId: 'sub_credit_stripe_race',
      stripeUsageItemId: 'si_credit_stripe_race', status: 'active', livemode: false,
      currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z') },
  });
  await prisma.billingStripeUsageExport.create({
    data: { accountId: ids.account, subscriptionId: ids.subscription,
      ledgerSnapshotCursor: 'bus_race_initial_123456789', billingMonth: month,
      billingProduct: 'deepwater', callerProduct: 'deepwater', currency,
      cumulativeCustomerCharge: '1.3', cumulativeGrossMeterQuantity: initialMeterQuantity,
      cumulativeMeterQuantity: initialMeterQuantity, deltaMeterQuantity: initialMeterQuantity,
      stripeMeterEventIdentifier: 'uoa_race_initial', stripeMeterEventState: 'ACCEPTED',
      stripeMeterEventCreatedAt: new Date('2026-10-04T08:01:00.000Z'),
      stripeMeterEventFirstAttemptedAt: new Date('2026-10-04T08:00:00.000Z'),
      stripeMeterEventAttemptedAt: new Date('2026-10-04T08:00:00.000Z'),
      createdAt: new Date('2026-10-04T08:00:00.000Z') },
  });
  await prisma.domainRole.create({
    data: { domain: 'credit-race-admin.example.test', userId: ids.user, role: 'SUPERUSER' },
  });
}

async function grantCredits(prisma: PrismaClient, suffix: string) {
  const amount = 1_300_000_000n;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT set_config('app.admin_auth_domain', 'credit-race-admin.example.test', true)
    `);
    await tx.billingCreditAdminAdjustment.create({
      data: { id: `bcaa_race_${suffix}`, accountId: ids.account, creditAccountId: ids.credit,
        orgId: ids.org, teamId: ids.team, signedAmountMicrocredits: amount,
        reason: 'Concurrent billing funding proof', idempotencyKey: `race-grant-${suffix}`,
        createdByUserId: ids.user, createdByEmail: 'credit-race@example.test',
        createdByAdminDomain: 'credit-race-admin.example.test', creditEntryId: `bce_race_${suffix}` },
    });
    await tx.billingCreditEntry.create({
      data: { id: `bce_race_${suffix}`, creditAccountId: ids.credit, direction: 'CREDIT',
        kind: 'ADJUSTMENT', amountMicrocredits: amount, balanceAfterMicrocredits: amount,
        idempotencyKey: `race-grant-${suffix}`, sourceType: 'credit_admin_adjustment',
        sourceId: `bcaa_race_${suffix}`, occurredAt: new Date('2026-10-04T09:00:00.000Z') },
    });
  });
}

function stripeStub() {
  return {
    accounts: { retrieveCurrent: async () => ({ id: 'acct_credit_stripe_race' }) },
    billing: { meterEvents: { create: vi.fn().mockImplementation(async () => ({
      id: 'mtr_evt_race', livemode: false, created: 1791115500,
    })) } },
  };
}

describe.skipIf(!enabled)('credit and Stripe export payer lock', () => {
  let prisma: PrismaClient;
  let databaseUrl: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required');
    ({ prisma, databaseUrl, cleanup } = handle);
    await seed(prisma);
  });
  afterAll(async () => { await cleanup?.(); });

  async function exerciseRace(prisma: PrismaClient, databaseUrl: string,
    waitForLock = waitForCollectionLockWait) {
    // The prior $1.30 was already accepted by Stripe. A later top-up must be
    // allocatable only to the next $1.30 of usage.
    await grantCredits(prisma, 'before_credit_wins');
    const settlementClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const exportClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await Promise.all([settlementClient.$connect(), exportClient.$connect()]);
    const releases: Array<() => void> = [];
    const running: Promise<unknown>[] = [];
    const signal = () => { const value = deferred(); releases.push(value.release); return value; };
    const observe = <T>(task: Promise<T>) => {
      // Attach rejection handling immediately, before any lock/barrier await.
      void task.catch(() => {}); running.push(task); return task;
    };
    try {
      const staleQuoteReady = signal();
      const releaseStaleQuote = signal();
      const creditLocked = signal();
      const releaseCreditLock = signal();
      let creditPid = 0;
      const stripe = stripeStub();
      const firstUsage = usage('bus_race_credit_wins_123456789',
        '2026-10-04T10:00:00.000Z', '2.6');
      const exportAttempt = observe(exportStripeUsage({ subscriptionId: ids.subscription, billingMonth: month }, {
        prisma: exportClient, stripe: stripe as never, stripeLivemode: false,
        fetchUsage: async () => firstUsage,
        settleCredits: async () => {
          staleQuoteReady.release();
          await releaseStaleQuote.promise;
          return 0n;
        },
        now: () => new Date('2026-10-04T10:05:00.000Z'),
      }));
      await waitUntil(staleQuoteReady.promise, exportAttempt);
      const firstSettlement = observe(settleCreditPortfolio({ creditAccountId: ids.credit,
        portfolio: portfolio('mup_race_credit_wins_123456789',
          '2026-10-04T10:01:00.000Z', '2.6'), credential }, {
        prisma: withPayerLockHook(settlementClient, async (tx) => {
          creditPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          creditLocked.release();
          await releaseCreditLock.promise;
        }),
      }));
      await waitUntil(creditLocked.promise, firstSettlement);
      releaseStaleQuote.release();
      await waitForLock(prisma, creditPid);
      releaseCreditLock.release();
      await firstSettlement;
      await expect(exportAttempt).rejects.toThrow('BILLING_CREDIT_ALLOCATION_CHANGED_DURING_EXPORT');
      expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
      expect(await prisma.billingStripeUsageExport.count({ where: { subscriptionId: ids.subscription } }))
        .toBe(1);
      let settlement = await prisma.billingCreditUsageSettlement.findFirstOrThrow({
        where: { creditAccountId: ids.credit, billingMonth: month },
      });
      expect(settlement.cumulativeCreditsConsumedMicrocredits).toBe(1_300_000_000n);
      expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.credit } }))
        .balanceMicrocredits).toBe(0n);

      // A second funding event follows the first export. Let Stripe reserve
      // the next unexported $1.30 while the credit settlement is waiting.
      await grantCredits(prisma, 'before_stripe_wins');
      const exportLocked = signal();
      const releaseExportLock = signal();
      let exportPid = 0;
      const wrappedExportClient = withPayerLockHook(exportClient, async (tx) => {
        exportPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        exportLocked.release();
        await releaseExportLock.promise;
      });
      const secondUsage = usage('bus_race_stripe_wins_123456789',
        '2026-10-04T10:10:00.000Z', '3.9');
      const secondExport = observe(exportStripeUsage({ subscriptionId: ids.subscription, billingMonth: month }, {
        prisma: wrappedExportClient, stripe: stripe as never, stripeLivemode: false,
        fetchUsage: async () => secondUsage,
        settleCredits: async () => 130_000_000n,
        now: () => new Date('2026-10-04T10:15:00.000Z'),
      }));
      await waitUntil(exportLocked.promise, secondExport);
      const secondSettlement = observe(settleCreditPortfolio({ creditAccountId: ids.credit,
        portfolio: portfolio('mup_race_stripe_wins_123456789',
          '2026-10-04T10:11:00.000Z', '3.9'), credential }, { prisma: settlementClient }));
      await waitForLock(prisma, exportPid);
      releaseExportLock.release();
      await Promise.all([secondExport, secondSettlement]);
      settlement = await prisma.billingCreditUsageSettlement.findUniqueOrThrow({
        where: { id: settlement.id },
      });
      expect(settlement.cumulativeCreditsConsumedMicrocredits).toBe(1_300_000_000n);
      expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.credit } }))
        .balanceMicrocredits).toBe(1_300_000_000n);
      const latest = await prisma.billingStripeUsageExport.findFirstOrThrow({
        where: { subscriptionId: ids.subscription }, orderBy: { createdAt: 'desc' },
      });
      expect(latest.cumulativeGrossMeterQuantity).toBe(390_000_000n);
      expect(latest.cumulativeMeterQuantity).toBe(260_000_000n);
      expect(latest.deltaMeterQuantity).toBe(130_000_000n);
      expect(latest.stripeMeterEventState).toBe('ACCEPTED');
      expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(1);
    } finally {
      releases.forEach(release => release());
      await Promise.allSettled(running);
      await Promise.all([settlementClient.$disconnect(), exportClient.$disconnect()]);
    }
  }

  it('serializes both winners without consuming exported usage twice', async () => {
    await exerciseRace(prisma, databaseUrl);
  }, 30_000);

  it('releases and awaits both competing tasks when lock observation fails', async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required');
    try {
      await seed(handle.prisma);
      await expect(exerciseRace(handle.prisma, handle.databaseUrl, async (db, pid) => {
        await waitForCollectionLockWait(db, pid);
        throw new Error('Synthetic lock observation failure');
      })).rejects.toThrow('Synthetic lock observation failure');
      // Cleanup drained the admitted settlement and stale export before closing
      // either client. No unhandled provider task or extra exported usage remains.
      expect((await handle.prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.credit } }))
        .balanceMicrocredits).toBe(0n);
      expect(await handle.prisma.billingStripeUsageExport.count()).toBe(1);
      expect((await handle.prisma.billingCreditUsageSettlement.findFirstOrThrow())
        .cumulativeCreditsConsumedMicrocredits).toBe(1_300_000_000n);
    } finally { await handle.cleanup(); }
  });
});
