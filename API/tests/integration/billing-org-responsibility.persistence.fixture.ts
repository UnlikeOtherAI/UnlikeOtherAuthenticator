import { BillingAppKeyPurpose, Prisma, type PrismaClient } from '@prisma/client';
import { vi } from 'vitest';

import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';

export const ids = {
  owner: 'usr_org_billing_owner',
  member: 'usr_org_billing_member',
  org: 'org_org_billing',
  teamA: 'team_org_billing_a',
  teamB: 'team_org_billing_b',
  service: 'svc_org_billing_deepwater',
  tariff: 'tariff_org_billing_deepwater',
  appKey: 'bak_org_billing_deepwater',
  account: 'bsa_org_billing',
  teamCustomer: 'bsc_org_billing_team_a',
  teamCreditAccount: 'bca_org_billing_team_a',
} as const;

export const credential = {
  id: ids.appKey,
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://deepwater.example.com',
  actorAudience: 'https://uoa.example.com/billing/v1/effective-tariff',
  actorKeyId: 'dw-key',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://deepwater.example.com'],
  service: { id: ids.service, identifier: 'deepwater', name: 'DeepWater' },
};

export const stripeAccount = { id: ids.account, stripeAccountId: 'acct_org_billing', livemode: false };

export const request = {
  product: 'deepwater',
  organisationId: ids.org,
  teamId: ids.teamA,
  userId: ids.owner,
};

const actor = { jti: 'actor_org_billing', tv: 0, exp: Math.floor(Date.now() / 1000) + 45 };

export function lifecycleDeps(prisma: PrismaClient, now?: Date) {
  return {
    prisma,
    ...(now ? { now: () => now } : {}),
    // The actor assertion, its TTL, the `tv` epoch and membership are the
    // entitlement path's job and are unit-tested there; this suite is about
    // what the database does.
    resolveTariff: vi.fn().mockResolvedValue({ actor, payload: {} }) as never,
    isOrganisationManager: vi.fn().mockResolvedValue(true) as never,
    authorizeAction: vi.fn().mockResolvedValue({}) as never,
  };
}

export async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "email", "user_key", "name") VALUES
        (${ids.owner}, 'org-billing-owner@example.com', 'org-billing-owner@example.com', 'Owner'),
        (${ids.member}, 'org-billing-member@example.com', 'org-billing-member@example.com', 'Member')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, 'org-billing.example.com', 'Acme', 'acme', ${ids.owner}, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "org_members" ("id", "org_id", "user_id", "role", "status", "updated_at") VALUES
        ('om_org_billing_owner', ${ids.org}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('om_org_billing_member', ${ids.org}, ${ids.member}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at") VALUES
        (${ids.teamA}, ${ids.org}, 'Research', 'research', CURRENT_TIMESTAMP),
        (${ids.teamB}, ${ids.org}, 'Support', 'support', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "team_members" ("id", "team_id", "user_id", "team_role", "status", "updated_at")
      VALUES
        ('tm_org_billing_a_owner', ${ids.teamA}, ${ids.owner}, 'owner', 'ACTIVE', CURRENT_TIMESTAMP),
        ('tm_org_billing_b_member', ${ids.teamB}, ${ids.member}, 'member', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_services" ("id", "identifier", "name", "tariff_history_from_month", "updated_at")
      VALUES (${ids.service}, 'deepwater', 'DeepWater', '2026-07', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariffs" (
        "id", "service_id", "key", "version", "name", "mode",
        "collection_mode", "markup_bps", "currency", "is_default"
      ) VALUES (
        ${ids.tariff}, ${ids.service}, 'standard', 1, 'DeepWater standard',
        'STANDARD', 'NONE', 0, 'USD', true
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_tariff_term_events" ("id", "service_id", "source", "scope_key",
        "effective_from_month", "tariff_id", "reason")
      VALUES ('btte_org_billing_default', ${ids.service}, 'SERVICE_DEFAULT', ${ids.service},
        '2026-07', ${ids.tariff}, 'test-fixture')
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_app_keys" (
        "id", "service_id", "purpose", "name", "key_prefix", "secret_digest",
        "actor_issuer", "actor_audience", "actor_key_id", "actor_public_jwk",
        "checkout_return_origins", "updated_at"
      ) VALUES (
        ${ids.appKey}, ${ids.service}, 'CUSTOMER_LIFECYCLE', 'DeepWater test',
        'uoa_dw_test', ${'a'.repeat(64)}, 'https://deepwater.example.com',
        'https://uoa.example.com', 'dw-key', ${JSON.stringify({ kty: 'RSA' })}::jsonb,
        ARRAY['https://deepwater.example.com'], CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_org_billing', false, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_customers" (
        "id", "account_id", "org_id", "team_id", "scope", "scope_key", "updated_at"
      ) VALUES (
        ${ids.teamCustomer}, ${ids.account}, ${ids.org}, ${ids.teamA}, 'TEAM',
        ${`${ids.org}:${ids.teamA}`}, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_credit_accounts" (
        "id", "account_id", "customer_id", "org_id", "team_id", "scope", "scope_key",
        "currency", "balance_microcredits", "updated_at"
      ) VALUES (
        ${ids.teamCreditAccount}, ${ids.account}, ${ids.teamCustomer}, ${ids.org}, ${ids.teamA},
        'TEAM', ${`${ids.org}:${ids.teamA}`}, 'USD', 500000000, CURRENT_TIMESTAMP
      )
    `);
  });
}

export function portfolio(teamId: string, cursor: string): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
    billingCompleteness: { state: 'complete', unresolvedPaidAttempts: '0' },
    contract: 'metering-portfolio-v1',
    perspectiveProduct: 'deepwater',
    groupBy: 'user',
    scope: {
      organizationId: ids.org,
      teamId,
      month: '2026-07',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z',
    },
    calls: '1',
    lines: [
      {
        serviceId: 'provider_openai',
        usageUnit: 'tokens',
        calls: '1',
        inputUnits: '0',
        cachedInputUnits: '0',
        outputUnits: '0',
        estimatedProviderCost: '1000',
        actualProviderCost: '1000',
        selectedProviderCost: '1000',
        currency: 'USD',
        costProvenance: 'actual',
        billingDisposition: 'paid',
        billingProduct: 'deepwater',
        callerProduct: 'deepwater',
        originProduct: 'deepwater',
        userId: teamId === ids.teamA ? ids.owner : ids.member,
      },
    ],
    snapshot: {
      id: cursor,
      cursor,
      capturedAt: '2026-07-20T11:59:00.000Z',
      immutable: true,
      sha256: 'c'.repeat(64),
    },
  };
}
