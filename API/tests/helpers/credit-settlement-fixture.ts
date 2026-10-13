import { BillingAppKeyPurpose, Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll } from 'vitest';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';
import { createTestDb } from '../helpers/test-db.js';

export const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

export const ids = {
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

export function credential(id: string, service: { id: string; identifier: string; name: string }) {
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

export const deepwaterCredential = credential(ids.deepwaterKey, {
  id: ids.deepwater,
  identifier: 'deepwater',
  name: 'DeepWater',
});

export const nessieCredential = credential(ids.nessieKey, {
  id: ids.nessie,
  identifier: 'nessie',
  name: 'Nessie',
});

export async function seed(prisma: PrismaClient): Promise<void> {
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
      INSERT INTO "billing_services"
        ("id", "identifier", "name", "tariff_history_from_month", "updated_at") VALUES
        (${ids.deepwater}, 'deepwater', 'DeepWater', '2026-07', CURRENT_TIMESTAMP),
        (${ids.nessie}, 'nessie', 'Nessie', '2026-07', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariffs" (
        "id", "service_id", "key", "version", "name", "mode",
        "collection_mode", "markup_bps", "currency", "usage_currency", "is_default"
      ) VALUES
        (${ids.deepwaterTariff}, ${ids.deepwater}, 'standard', 1, 'DeepWater standard',
         'STANDARD', 'NONE', 0, 'USD', 'USD', true),
        (${ids.nessieTariff}, ${ids.nessie}, 'standard', 1, 'Nessie standard',
         'STANDARD', 'NONE', 0, 'USD', 'USD', true)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariff_term_events"
        ("id", "service_id", "source", "scope_key", "effective_from_month", "tariff_id", "reason")
      VALUES
        ('term_credit_deepwater', ${ids.deepwater}, 'SERVICE_DEFAULT', ${ids.deepwater},
          '2026-07', ${ids.deepwaterTariff}, 'test-fixture'),
        ('term_credit_nessie', ${ids.nessie}, 'SERVICE_DEFAULT', ${ids.nessie},
          '2026-07', ${ids.nessieTariff}, 'test-fixture')
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

export function line(product: string, userId: string | null, cost: string) {
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

export function portfolio(
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

export async function settleConcurrently(
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

export let handle: Awaited<ReturnType<typeof createTestDb>>;

export function setupCreditSettlementFixture() {
  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    await seed(handle.prisma);
  });
  afterAll(async () => {
    if (handle) await handle.cleanup();
  });
}
