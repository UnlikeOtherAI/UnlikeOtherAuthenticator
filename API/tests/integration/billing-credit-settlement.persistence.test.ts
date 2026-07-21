import {
  BillingAppKeyPurpose,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
  owner: 'usr_credit_settlement_owner',
  second: 'usr_credit_settlement_second',
  org: 'org_credit_settlement',
  team: 'team_credit_settlement',
  deepwater: 'svc_credit_settlement_deepwater',
  nessie: 'svc_credit_settlement_nessie',
  deepwaterTariff: 'tariff_credit_settlement_deepwater',
  nessieTariff: 'tariff_credit_settlement_nessie',
  deepwaterKey: 'bak_credit_settlement_deepwater',
  nessieKey: 'bak_credit_settlement_nessie',
  account: 'bsa_credit_settlement',
  customer: 'bsc_credit_settlement',
  creditAccount: 'bca_credit_settlement',
} as const;

function credential(
  id: string,
  service: { id: string; identifier: string; name: string },
) {
  return {
    id,
    purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
    actorIssuer: `https://${service.identifier}.example.com`,
    actorAudience: 'https://uoa.example.com/billing/v1/effective-tariff',
    actorKeyId: `${service.identifier}-key`,
    actorPublicJwk: {},
    checkoutReturnOrigins: [`https://${service.identifier}.example.com`],
    service,
  };
}

const deepwaterCredential = credential(ids.deepwaterKey, {
  id: ids.deepwater,
  identifier: 'deepwater',
  name: 'DeepWater',
});
const nessieCredential = credential(ids.nessieKey, {
  id: ids.nessie,
  identifier: 'nessie',
  name: 'Nessie',
});

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name") VALUES
        (${ids.owner}, 'credit-owner@example.com', 'credit-owner@example.com', 'Credit Owner'),
        (${ids.second}, 'credit-second@example.com', 'credit-second@example.com', 'Second User')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" (
        "id", "domain", "name", "slug", "owner_id", "updated_at"
      ) VALUES (
        ${ids.org}, 'credit-settlement.example.com', 'Credit Settlement Org',
        'credit-settlement-org', ${ids.owner}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" (
        "id", "org_id", "user_id", "role", "status", "updated_at"
      ) VALUES
        ('om_credit_settlement_owner', ${ids.org}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('om_credit_settlement_second', ${ids.org}, ${ids.second}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Credit Settlement Team', 'credit-settlement-team', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" (
        "id", "team_id", "user_id", "team_role", "status", "updated_at"
      ) VALUES
        ('tm_credit_settlement_owner', ${ids.team}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('tm_credit_settlement_second', ${ids.team}, ${ids.second}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at") VALUES
        (${ids.deepwater}, 'deepwater', 'DeepWater', CURRENT_TIMESTAMP),
        (${ids.nessie}, 'nessie', 'Nessie', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariffs" (
        "id", "service_id", "key", "version", "name", "mode",
        "collection_mode", "markup_bps", "currency", "is_default"
      ) VALUES
        (${ids.deepwaterTariff}, ${ids.deepwater}, 'standard', 1, 'DeepWater standard',
         'STANDARD', 'NONE', 0, 'USD', true),
        (${ids.nessieTariff}, ${ids.nessie}, 'standard', 1, 'Nessie standard',
         'STANDARD', 'NONE', 0, 'USD', true)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES
        (${ids.deepwaterKey}, ${ids.deepwater}, 'CUSTOMER_LIFECYCLE', 'DeepWater test',
         'uoa_dw_test', ${'a'.repeat(64)}, 'https://deepwater.example.com',
         'https://uoa.example.com', 'dw-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
         ARRAY['https://deepwater.example.com'], CURRENT_TIMESTAMP),
        (${ids.nessieKey}, ${ids.nessie}, 'CUSTOMER_LIFECYCLE', 'Nessie test',
         'uoa_ne_test', ${'b'.repeat(64)}, 'https://nessie.example.com',
         'https://uoa.example.com', 'ne-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
         ARRAY['https://nessie.example.com'], CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" (
        "id", "stripe_account_id", "livemode", "updated_at"
      ) VALUES (${ids.account}, 'acct_credit_settlement', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key",
        "stripe_customer_id", "updated_at"
      ) VALUES (
        ${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, 'cus_credit_settlement', CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${ids.creditAccount}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'USD', 750000000, CURRENT_TIMESTAMP
      )
    `);
  });
}

function line(product: string, userId: string | null, cost: string) {
  return {
    serviceId: 'provider_openai',
    usageUnit: 'tokens',
    calls: '1',
    inputUnits: '0',
    cachedInputUnits: '0',
    outputUnits: '0',
    estimatedProviderCost: cost,
    actualProviderCost: cost,
    selectedProviderCost: cost,
    currency: 'USD',
    costProvenance: 'actual',
    billingProduct: product,
    callerProduct: product,
    originProduct: product,
    userId,
  };
}

function portfolio(
  cursor: string,
  capturedAt: string,
  lines: NormalizedMeteringPortfolio['lines'],
  sha256 = 'a'.repeat(64),
): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
    contract: 'metering-portfolio-v1',
    perspectiveProduct: 'deepwater',
    groupBy: 'user',
    scope: {
      organizationId: ids.org,
      teamId: ids.team,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: lines.length.toString(),
    lines,
    snapshot: {
      id: cursor,
      cursor,
      capturedAt,
      immutable: true,
      sha256,
    },
  };
}

describe.skipIf(!databaseTestsEnabled)('credit settlement persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('settles every service once under concurrent sibling storefront retries', async () => {
    if (!handle) throw new Error('db handle missing');
    const first = portfolio('mup_cursor_001', '2026-07-21T12:00:00.000Z', [
      line('deepwater', ids.owner, '1'),
      line('nessie', null, '1'),
    ]);
    const results = await Promise.all([
      settleCreditPortfolio(
        { creditAccountId: ids.creditAccount, portfolio: first, credential: deepwaterCredential },
        { prisma: handle.prisma },
      ),
      settleCreditPortfolio(
        { creditAccountId: ids.creditAccount, portfolio: first, credential: nessieCredential },
        { prisma: handle.prisma },
      ),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const account = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
      include: { adjustments: true },
    });
    expect(account.balanceMicrocredits).toBe(0n);
    expect(settlements).toHaveLength(2);
    expect(settlements.every((row) => row.adjustments.length === 1)).toBe(true);
    expect(new Set(settlements.map((row) => row.adjustments[0]?.portfolioSnapshotId)).size).toBe(1);
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      100_000_000n,
      100_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeCreditsConsumedMicrocredits)).toEqual([
      375_000_000n,
      375_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeRemainingUsageAmountMicroMinor)).toEqual([
      62_500_000n,
      62_500_000n,
    ]);
  }, 20_000);

  it('replays the same cursor across storefront keys without another debit', async () => {
    if (!handle) throw new Error('db handle missing');
    const replay = await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_001', '2026-07-21T12:00:00.000Z', [
          line('deepwater', ids.owner, '1'),
          line('nessie', null, '1'),
        ]),
        credential: nessieCredential,
      },
      { prisma: handle.prisma },
    );

    expect(replay.replayed).toBe(true);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(2);
    expect(await handle.prisma.billingCreditUsageSettlementAdjustment.count()).toBe(2);
  });

  it('rejects changed evidence for an already pinned cursor', async () => {
    if (!handle) throw new Error('db handle missing');
    const snapshotCount = await handle.prisma.billingCreditPortfolioSnapshot.count();

    await expect(
      settleCreditPortfolio(
        {
          creditAccountId: ids.creditAccount,
          portfolio: portfolio(
            'mup_cursor_001',
            '2026-07-21T12:00:00.000Z',
            [line('deepwater', ids.owner, '1'), line('nessie', null, '1')],
            'b'.repeat(64),
          ),
          credential: deepwaterCredential,
        },
        { prisma: handle.prisma },
      ),
    ).rejects.toThrow('LEDGER_CREDIT_SNAPSHOT_MUTATED');
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(snapshotCount);
  });

  it('refunds a lower snapshot and reallocates user attribution deterministically', async () => {
    if (!handle) throw new Error('db handle missing');
    await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_002', '2026-07-21T12:01:00.000Z', [
          line('deepwater', ids.second, '0.2'),
          line('nessie', null, '0.2'),
        ]),
        credential: deepwaterCredential,
      },
      { prisma: handle.prisma },
    );

    const account = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: ids.creditAccount },
    });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
    });
    const deepwater = settlements.find((row) => row.serviceId === ids.deepwater);
    const latestSecond = await handle.prisma.billingCreditUsageAllocation.findFirst({
      where: { settlementId: deepwater?.id, attributedUserId: ids.second },
      orderBy: { adjustment: { sequence: 'desc' } },
    });
    expect(account.balanceMicrocredits).toBe(350_000_000n);
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      20_000_000n,
      20_000_000n,
    ]);
    expect(settlements.map((row) => row.cumulativeCreditsConsumedMicrocredits)).toEqual([
      200_000_000n,
      200_000_000n,
    ]);
    expect(latestSecond?.cumulativeCreditsConsumedMicrocredits).toBe(200_000_000n);
  });

  it('rejects an unknown non-null user without persisting a partial snapshot', async () => {
    if (!handle) throw new Error('db handle missing');
    const snapshotCount = await handle.prisma.billingCreditPortfolioSnapshot.count();

    await expect(
      settleCreditPortfolio(
        {
          creditAccountId: ids.creditAccount,
          portfolio: portfolio('mup_cursor_003', '2026-07-21T12:02:00.000Z', [
            line('deepwater', 'user_not_in_team', '1'),
          ]),
          credential: deepwaterCredential,
        },
        { prisma: handle.prisma },
      ),
    ).rejects.toThrow('LEDGER_CREDIT_USER_INVALID');
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(snapshotCount);
    expect(
      (
        await handle.prisma.billingCreditAccount.findUniqueOrThrow({
          where: { id: ids.creditAccount },
        })
      ).balanceMicrocredits,
    ).toBe(350_000_000n);
  });
});
