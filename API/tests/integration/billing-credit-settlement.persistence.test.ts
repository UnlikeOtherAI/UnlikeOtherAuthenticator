import { BillingAppKeyPurpose, Prisma, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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

function credential(id: string, service: { id: string; identifier: string; name: string }) {
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
        "id", "account_id", "customer_id", "org_id", "team_id", "scope", "scope_key", "currency",
        "balance_microcredits", "updated_at"
      ) VALUES (
        ${ids.creditAccount}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team},
        'TEAM', ${`${ids.org}:${ids.team}`}, 'USD', 750000000, CURRENT_TIMESTAMP
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
    billingDisposition: 'paid',
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
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
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

async function settleConcurrently(
  databaseUrl: string,
  requests: Array<{
    portfolio: NormalizedMeteringPortfolio;
    credential: typeof deepwaterCredential;
  }>,
) {
  const clients = requests.map(
    () => new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
  );
  await Promise.all(clients.map((client) => client.$connect()));
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const waves = requests.map((_, wave) => {
    const allArrived = deferred();
    const winnerCommitted = deferred();
    let arrivals = 0;
    return {
      allArrived: allArrived.promise,
      winnerCommitted: winnerCommitted.promise,
      arrive() {
        arrivals += 1;
        if (arrivals === requests.length - wave) allArrived.resolve();
      },
      commit: winnerCommitted.resolve,
    };
  });
  const attempts = requests.map(() => 0);
  const concurrentClients = clients.map((client, index) => {
    return {
      async $transaction<T>(
        callback: (tx: Prisma.TransactionClient) => Promise<T>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ): Promise<T> {
        const waveIndex = attempts[index] ?? 0;
        attempts[index] = waveIndex + 1;
        const wave = waves[waveIndex];
        if (!wave) throw new Error('unexpected credit settlement retry wave');
        try {
          return await client.$transaction(async (tx) => {
            await tx.billingCreditAccount.findUniqueOrThrow({
              where: { id: ids.creditAccount },
            });
            wave.arrive();
            await wave.allArrived;
            if (index !== waveIndex) await wave.winnerCommitted;
            return callback(tx);
          }, options);
        } finally {
          if (index === waveIndex) wave.commit();
        }
      },
    } as unknown as PrismaClient;
  });

  try {
    const results = await Promise.allSettled(
      concurrentClients.map((client, index) => {
        const request = requests[index];
        if (!request) throw new Error('concurrency fixture missing');
        return settleCreditPortfolio(
          {
            creditAccountId: ids.creditAccount,
            portfolio: request.portfolio,
            credential: request.credential,
          },
          { prisma: client },
        );
      }),
    );
    return { attempts, results };
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
}

describe.skipIf(!databaseTestsEnabled)('credit settlement persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('settles four independent storefront cursors without duplicate debits', async () => {
    if (!handle) throw new Error('db handle missing');
    const cursors = [
      ['mup_cursor_001', '2026-07-21T12:00:00.000Z'],
      ['mup_cursor_001_nessie', '2026-07-21T12:00:01.000Z'],
      ['mup_cursor_001_deepsignal', '2026-07-21T12:00:02.000Z'],
      ['mup_cursor_001_deeptest', '2026-07-21T12:00:03.000Z'],
    ] as const;
    const credentials = [
      deepwaterCredential,
      nessieCredential,
      deepwaterCredential,
      nessieCredential,
    ];

    const { attempts, results } = await settleConcurrently(
      handle.databaseUrl,
      cursors.map((cursor, index) => {
        const storefrontCredential = credentials[index];
        if (!storefrontCredential) throw new Error('concurrency fixture missing');
        return {
          portfolio: portfolio(cursor[0], cursor[1], [
            line('deepwater', ids.owner, '1'),
            line('nessie', null, '1'),
          ]),
          credential: storefrontCredential,
        };
      }),
    );
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(
      results.every(
        (result) =>
          result.status === 'fulfilled' && !result.value.replayed && !result.value.superseded,
      ),
    ).toBe(true);
    expect(attempts).toEqual([1, 2, 3, 4]);

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
    expect(settlements.every((row) => row.adjustments.length === 4)).toBe(true);
    expect(
      new Set(settlements.flatMap((row) => row.adjustments.map((item) => item.portfolioSnapshotId)))
        .size,
    ).toBe(4);
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(4);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(2);
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
  }, 30_000);

  it('supersedes older and equal captures that arrive after the newest cursor', async () => {
    if (!handle) throw new Error('db handle missing');
    const cursors = [
      ['mup_cursor_newest_first', '2026-07-21T12:00:07.000Z'],
      ['mup_cursor_older_second', '2026-07-21T12:00:06.000Z'],
      ['mup_cursor_older_third', '2026-07-21T12:00:05.000Z'],
      ['mup_cursor_equal_fourth', '2026-07-21T12:00:07.000Z'],
    ] as const;
    const credentials = [
      deepwaterCredential,
      nessieCredential,
      deepwaterCredential,
      nessieCredential,
    ];
    const beforeSnapshots = await handle.prisma.billingCreditPortfolioSnapshot.count();
    const beforeAdjustments = await handle.prisma.billingCreditUsageSettlementAdjustment.count();

    const { attempts, results } = await settleConcurrently(
      handle.databaseUrl,
      cursors.map((cursor, index) => {
        const storefrontCredential = credentials[index];
        if (!storefrontCredential) throw new Error('concurrency fixture missing');
        return {
          portfolio: portfolio(cursor[0], cursor[1], [
            line('deepwater', ids.owner, index === 0 ? '1' : '9'),
            line('nessie', null, index === 0 ? '1' : '9'),
          ]),
          credential: storefrontCredential,
        };
      }),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const outcomes = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });
    expect(outcomes.map(({ replayed, superseded }) => ({ replayed, superseded }))).toEqual([
      { replayed: false, superseded: false },
      { replayed: false, superseded: true },
      { replayed: false, superseded: true },
      { replayed: false, superseded: true },
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.snapshotId)).size).toBe(1);
    expect(attempts).toEqual([1, 2, 2, 2]);

    const replay = await settleCreditPortfolio(
      {
        creditAccountId: ids.creditAccount,
        portfolio: portfolio('mup_cursor_newest_first', '2026-07-21T12:00:07.000Z', [
          line('deepwater', ids.owner, '1'),
          line('nessie', null, '1'),
        ]),
        credential: nessieCredential,
      },
      { prisma: handle.prisma },
    );
    expect(replay).toMatchObject({
      snapshotId: outcomes[0]?.snapshotId,
      replayed: true,
      superseded: false,
    });
    expect(await handle.prisma.billingCreditPortfolioSnapshot.count()).toBe(beforeSnapshots + 1);
    expect(await handle.prisma.billingCreditUsageSettlementAdjustment.count()).toBe(
      beforeAdjustments + 2,
    );
    expect(
      await handle.prisma.billingCreditPortfolioSnapshot.findFirstOrThrow({
        where: { creditAccountId: ids.creditAccount },
        orderBy: [{ capturedAt: 'desc' }, { ledgerSnapshotCursor: 'desc' }],
        select: { ledgerSnapshotCursor: true },
      }),
    ).toEqual({ ledgerSnapshotCursor: 'mup_cursor_newest_first' });
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: ids.creditAccount },
      orderBy: { serviceId: 'asc' },
    });
    expect(settlements.map((row) => row.cumulativeRatedUsageAmountMicroMinor)).toEqual([
      100_000_000n,
      100_000_000n,
    ]);
  }, 30_000);

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
    expect(replay.superseded).toBe(false);
    expect(await handle.prisma.billingCreditEntry.count()).toBe(2);
    expect(await handle.prisma.billingCreditUsageSettlementAdjustment.count()).toBe(10);
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

  it('keeps two source teams separate while debiting their shared organisation payer', async () => {
    if (!handle) throw new Error('db handle missing');
    const secondTeam = 'team_credit_settlement_other';
    const orgCustomer = 'bsc_credit_settlement_org';
    const orgAccount = 'bca_credit_settlement_org';
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
        VALUES (${secondTeam}, ${ids.org}, 'Second Team', 'second-team', CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "team_members" ("id", "team_id", "user_id", "team_role", "status", "updated_at")
        VALUES ('tm_credit_settlement_other', ${secondTeam}, ${ids.second}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_stripe_customers"
          ("id", "account_id", "org_id", "scope", "scope_key", "updated_at")
        VALUES (${orgCustomer}, ${ids.account}, ${ids.org}, 'ORGANISATION', ${ids.org}, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_credit_accounts"
          ("id", "account_id", "customer_id", "org_id", "scope", "scope_key", "currency",
           "balance_microcredits", "updated_at")
        VALUES (${orgAccount}, ${ids.account}, ${orgCustomer}, ${ids.org}, 'ORGANISATION',
          ${ids.org}, 'USD', 2000000000, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_org_responsibilities"
          ("id", "org_id", "active", "assumed_at", "assumed_by_user_id", "updated_at")
        VALUES ('bor_credit_settlement_org', ${ids.org}, true,
          '2026-06-01T00:00:00.000Z', ${ids.owner}, CURRENT_TIMESTAMP)
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "billing_org_responsibility_transitions"
          ("id", "responsibility_id", "org_id", "kind", "effective_at", "actor_user_id", "source")
        VALUES ('bort_credit_settlement_org', 'bor_credit_settlement_org', ${ids.org},
          'ASSUMED', '2026-06-01T00:00:00.000Z', ${ids.owner}, 'legacy_backfill')
      `);
    });
    const first = portfolio('mup_org_team_a_123456789012345678901234',
      '2026-07-21T13:00:00.000Z', [line('deepwater', ids.owner, '1')]);
    const second = portfolio('mup_org_team_b_123456789012345678901234',
      '2026-07-21T12:00:00.000Z', [line('deepwater', ids.second, '0.2')]);
    second.scope.teamId = secondTeam;
    await settleCreditPortfolio(
      { creditAccountId: orgAccount, portfolio: first, credential: deepwaterCredential },
      { prisma: handle.prisma },
    );
    await settleCreditPortfolio(
      { creditAccountId: orgAccount, portfolio: second, credential: deepwaterCredential },
      { prisma: handle.prisma },
    );
    const settlements = await handle.prisma.billingCreditUsageSettlement.findMany({
      where: { creditAccountId: orgAccount },
      orderBy: { teamId: 'asc' },
    });
    expect(settlements).toHaveLength(2);
    expect(new Set(settlements.map((row) => row.teamId))).toEqual(new Set([ids.team, secondTeam]));
    expect(settlements.reduce((sum, row) => sum + row.cumulativeCreditsConsumedMicrocredits, 0n))
      .toBe(1_200_000_000n);
    const payer = await handle.prisma.billingCreditAccount.findUniqueOrThrow({
      where: { id: orgAccount },
    });
    expect(payer.balanceMicrocredits).toBe(800_000_000n);
  });

  it('attributes delayed paid usage to the original user after membership becomes inactive', async () => {
    if (!handle) throw new Error('db handle missing');
    await handle.prisma.teamMember.update({
      where: { teamId_userId: { teamId: 'team_credit_settlement_other', userId: ids.second } },
      data: { status: 'DEACTIVATED', statusChangedAt: new Date('2026-09-15T00:00:00.000Z') },
    });
    const delayed = portfolio('mup_departed_user_1234567890123456789012',
      '2026-09-20T12:00:00.000Z', [line('deepwater', ids.second, '0.2')]);
    delayed.scope = {
      ...delayed.scope,
      teamId: 'team_credit_settlement_other',
      month: '2026-09',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
    };
    await settleCreditPortfolio({
      creditAccountId: 'bca_credit_settlement_org',
      portfolio: delayed,
      credential: deepwaterCredential,
    }, { prisma: handle.prisma });
    const allocation = await handle.prisma.billingCreditUsageAllocation.findFirstOrThrow({
      where: { attributedUserId: ids.second, settlement: { billingMonth: '2026-09' } },
    });
    expect(allocation.cumulativeCreditsConsumedMicrocredits).toBe(200_000_000n);
  });

  it('upgrades populated legacy history without altering totals and restores identity protection', async () => {
    if (!handle) throw new Error('db handle missing');
    const prisma = handle.prisma;
    const before = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, teamId: true, billingMonth: true,
        cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true },
      orderBy: { id: 'asc' },
    });
    const orgRows = before.filter((row) =>
      row.creditAccountId === 'bca_credit_settlement_org' && row.billingMonth === '2026-07');
    expect(orgRows).toHaveLength(2);
    const retained = orgRows[0];
    const removed = orgRows[1];
    if (!retained || !removed) throw new Error('org fixture incomplete');
    // Model a historical overwritten organisation row with adjustments from
    // two source teams. This schema is disposable and isolated to this test.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_credit_usage_settlement_adjustments"
        SET "settlement_id" = ${retained.id}, "sequence" = 2
        WHERE "settlement_id" = ${removed.id}
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_credit_usage_allocations"
        SET "settlement_id" = ${retained.id}
        WHERE "settlement_id" = ${removed.id}
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "billing_credit_usage_settlements" WHERE "id" = ${removed.id}
      `);
    });
    const financialBefore = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true }, orderBy: { id: 'asc' },
    });
    for (const sql of [
      'DROP INDEX "billing_credit_settlement_team_service_month_key"',
      'DROP INDEX "billing_credit_portfolio_snapshot_team_ledger_id_key"',
      'DROP INDEX "billing_credit_portfolio_snapshot_team_cursor_key"',
      'ALTER TABLE "billing_credit_usage_settlements" DROP CONSTRAINT "billing_credit_usage_settlements_team_id_fkey"',
      'ALTER TABLE "billing_credit_usage_settlements" DROP COLUMN "team_id"',
      'CREATE UNIQUE INDEX "billing_credit_usage_settlements_credit_account_id_service__key" ON "billing_credit_usage_settlements"("credit_account_id", "service_id", "billing_month")',
      'CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_ledger_id_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_id")',
      'CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_cursor_key" ON "billing_credit_portfolio_snapshots"("credit_account_id", "ledger_snapshot_cursor")',
    ]) await prisma.$executeRawUnsafe(sql);
    const migration = path.resolve(process.cwd(),
      'prisma/migrations/20261004120000_scope_credit_settlements_by_origin_team/migration.sql');
    const migrationSource = readFileSync(migration, 'utf8');
    const failingSource = migrationSource.replace(
      'ALTER TABLE "billing_credit_usage_settlements"\n  ENABLE TRIGGER',
      'DO $$ BEGIN RAISE EXCEPTION \'forced upgrade rollback proof\'; END $$;\n' +
        'ALTER TABLE "billing_credit_usage_settlements"\n  ENABLE TRIGGER',
    );
    expect(failingSource).not.toBe(migrationSource);
    expect(() => execFileSync(process.execPath, [
      createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma',
    ], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: handle.databaseUrl },
      input: failingSource, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();
    const trigger = await prisma.$queryRaw<Array<{ tgenabled: string }>>(Prisma.sql`
      SELECT tgenabled FROM pg_trigger
      WHERE tgrelid = 'billing_credit_usage_settlements'::regclass
        AND tgname = 'billing_credit_usage_settlements_immutable_identity'
    `);
    expect(trigger).toEqual([{ tgenabled: 'O' }]);
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "billing_credit_usage_settlements"
      SET "billing_month" = '2026-08' WHERE "id" = ${retained.id}
    `)).rejects.toThrow();
    execFileSync(process.execPath, [
      createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'db', 'execute', '--file', migration, '--schema', 'prisma/schema.prisma',
    ], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: handle.databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const after = await prisma.billingCreditUsageSettlement.findMany({
      select: { id: true, creditAccountId: true, teamId: true, cumulativeCreditsConsumedMicrocredits: true,
        cumulativeRatedUsageAmountMicroMinor: true }, orderBy: { id: 'asc' },
    });
    expect(after.map(({ teamId: _teamId, ...row }) => row)).toEqual(financialBefore);
    expect(after.find((row) => row.id === retained.id)?.teamId).toBeNull();
    expect(after.filter((row) => row.creditAccountId === ids.creditAccount)
      .every((row) => row.teamId === ids.team)).toBe(true);
    const teamRow = after.find((row) => row.teamId === ids.team);
    if (!teamRow) throw new Error('team lineage missing');
    await expect(prisma.billingCreditUsageSettlement.update({
      where: { id: teamRow.id },
      data: { teamId: 'team_credit_settlement_other' },
    })).rejects.toThrow();
  }, 30_000);
});
