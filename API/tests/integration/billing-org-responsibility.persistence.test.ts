import { BillingAppKeyPurpose, Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveCreditAccount } from '../../src/services/billing-credit-account.service.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import type { NormalizedMeteringPortfolio } from '../../src/services/billing-metering.types.js';
import {
  assertOrgBillingAssumable,
  BillingOrgResponsibilityBlockedError,
} from '../../src/services/billing-org-responsibility-guard.service.js';
import {
  assumeOrgBillingResponsibility,
  releaseOrgBillingResponsibility,
} from '../../src/services/billing-org-responsibility-lifecycle.service.js';
import { createTestDb } from '../helpers/test-db.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

const ids = {
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

const credential = {
  id: ids.appKey,
  purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
  actorIssuer: 'https://deepwater.example.com',
  actorAudience: 'https://uoa.example.com/billing/v1/effective-tariff',
  actorKeyId: 'dw-key',
  actorPublicJwk: {},
  checkoutReturnOrigins: ['https://deepwater.example.com'],
  service: { id: ids.service, identifier: 'deepwater', name: 'DeepWater' },
};

const stripeAccount = { id: ids.account, stripeAccountId: 'acct_org_billing', livemode: false };

const request = {
  product: 'deepwater',
  organisationId: ids.org,
  teamId: ids.teamA,
  userId: ids.owner,
};

const actor = { jti: 'actor_org_billing', tv: 0, exp: Math.floor(Date.now() / 1000) + 45 };

function lifecycleDeps(prisma: PrismaClient) {
  return {
    prisma,
    // The actor assertion, its TTL, the `tv` epoch and membership are the
    // entitlement path's job and are unit-tested there; this suite is about
    // what the database does.
    resolveTariff: vi.fn().mockResolvedValue({ actor, payload: {} }) as never,
    isOrganisationManager: vi.fn().mockResolvedValue(true) as never,
    authorizeAction: vi.fn().mockResolvedValue({}) as never,
  };
}

async function seed(prisma: PrismaClient): Promise<void> {
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
      INSERT INTO "billing_services" ("id", "identifier", "name", "updated_at")
      VALUES (${ids.service}, 'deepwater', 'DeepWater', CURRENT_TIMESTAMP)
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

function portfolio(teamId: string, cursor: string): NormalizedMeteringPortfolio {
  return {
    schemaVersion: 1,
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

describe.skipIf(!databaseTestsEnabled)('organisation billing responsibility persistence', () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for organisation billing tests');
    prisma = handle.prisma;
    cleanup = handle.cleanup;
    await seed(prisma);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('resolves the team account while no organisation has taken billing over', async () => {
    const resolved = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );

    expect(resolved.id).toBe(ids.teamCreditAccount);
    expect(resolved.scope).toBe('TEAM');
    expect(resolved.teamId).toBe(ids.teamA);
    expect(resolved.scopeKey).toBe(`${ids.org}:${ids.teamA}`);
  });

  it('refuses to assume while a team funding action is still in flight', async () => {
    // A cancellation preview the customer is still holding: it can be
    // confirmed a second later, against the team's own account.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "billing_cancellation_intents" (
        "id", "token_digest", "app_key_id", "service_id", "org_id", "team_id",
        "requested_by_user_id", "direct_service_ids", "direct_subscription_ids",
        "indirect_service_ids", "entitlement_fingerprint", "subscription_fingerprint",
        "state", "expires_at", "updated_at"
      ) VALUES (
        'bci_org_billing_open', ${'d'.repeat(64)}, ${ids.appKey}, ${ids.service}, ${ids.org},
        ${ids.teamA}, ${ids.owner}, ARRAY[${ids.service}], ARRAY['bss_org_billing_team'],
        ARRAY[]::text[],
        ${'e'.repeat(64)}, ${'f'.repeat(64)}, 'AVAILABLE',
        CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP
      )
    `);

    await expect(
      assertOrgBillingAssumable({ organisationId: ids.org, now: new Date() }, { prisma }),
    ).rejects.toThrow('FUNDING_ACTION_IN_FLIGHT');

    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "billing_cancellation_intents" WHERE "id" = 'bci_org_billing_open'
    `);
  });

  it('refuses to assume while a live team subscription exists, naming it', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_subscriptions" (
        "id", "account_id", "customer_id", "service_id", "tariff_id", "tariff_source",
        "org_id", "team_id", "scope", "scope_key", "checkout_id", "stripe_subscription_id",
        "stripe_usage_item_id", "status", "livemode", "updated_at"
      ) VALUES (
        'bss_org_billing_team', ${ids.account}, ${ids.teamCustomer}, ${ids.service}, ${ids.tariff},
        'SERVICE_DEFAULT', ${ids.org}, ${ids.teamA}, 'TEAM', ${`${ids.org}:${ids.teamA}`},
        'bsch_org_billing', 'sub_org_billing', 'si_org_billing', 'active', false, CURRENT_TIMESTAMP
      )
      `);
    });

    const error = await assertOrgBillingAssumable(
      { organisationId: ids.org, now: new Date() },
      { prisma },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BillingOrgResponsibilityBlockedError);
    expect((error as BillingOrgResponsibilityBlockedError).reason).toBe(
      'TEAM_SUBSCRIPTIONS_ACTIVE',
    );
    expect((error as BillingOrgResponsibilityBlockedError).subscriptions).toEqual([
      {
        subscriptionId: 'bss_org_billing_team',
        serviceId: ids.service,
        scopeKey: `${ids.org}:${ids.teamA}`,
        status: 'active',
      },
    ]);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_stripe_subscriptions" SET "status" = 'canceled'
        WHERE "id" = 'bss_org_billing_team'
      `);
    });
  });

  it('moves every team onto the organisation account once billing is assumed', async () => {
    const assumed = await assumeOrgBillingResponsibility(
      { request, actorToken: 'signed-actor', credential },
      lifecycleDeps(prisma),
    );
    expect(assumed).toMatchObject({ organisation_id: ids.org, active: true });

    const fromTeamA = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );
    const fromTeamB = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamB },
      { prisma },
    );

    // Both teams resolve to the one organisation account: this is the whole of
    // the money side. No caller had to change.
    expect(fromTeamA.id).toBe(fromTeamB.id);
    expect(fromTeamA.id).not.toBe(ids.teamCreditAccount);
    expect(fromTeamA.scope).toBe('ORGANISATION');
    expect(fromTeamA.teamId).toBeNull();
    expect(fromTeamA.scopeKey).toBe(ids.org);
    expect(fromTeamA.balanceMicrocredits).toBe(0n);

    // The team's own balance is not swept: it stays exactly where it was.
    const teamAccount = await prisma.billingCreditAccount.findUnique({
      where: { id: ids.teamCreditAccount },
    });
    expect(teamAccount?.balanceMicrocredits).toBe(500000000n);

    const audit = await prisma.orgAuditLog.findFirst({
      where: { orgId: ids.org, action: 'billing.org_responsibility_assumed' },
    });
    expect(audit).not.toBeNull();
  });

  it("settles a team's metered usage against the organisation account", async () => {
    const organisationAccount = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamB },
      { prisma },
    );

    await settleCreditPortfolio(
      {
        creditAccountId: organisationAccount.id,
        portfolio: portfolio(ids.teamB, 'mup_org_billing_team_b'),
        credential,
      },
      { prisma },
    );

    // The snapshot keeps the team it came from, even though the credits are
    // the organisation's.
    const snapshot = await prisma.billingCreditPortfolioSnapshot.findFirst({
      where: { creditAccountId: organisationAccount.id },
    });
    expect(snapshot?.teamId).toBe(ids.teamB);

    // The usage is rated against the organisation account, and attributed to a
    // user who belongs to the team the portfolio came from. Before this change
    // the attribution assert demanded membership of the *account's* team, and
    // an organisation account has none — this row is the proof it now asks the
    // organisation instead.
    const settlement = await prisma.billingCreditUsageSettlement.findFirst({
      where: { creditAccountId: organisationAccount.id, billingMonth: '2026-07' },
      include: { adjustments: { orderBy: { sequence: 'desc' }, take: 1 } },
    });
    expect(settlement).not.toBeNull();
    expect(settlement?.adjustments[0]?.cumulativeRatedUsageAmountMicroMinor).toBeGreaterThan(0n);

    const allocation = await prisma.billingCreditUsageAllocation.findFirst({
      where: { settlementId: settlement?.id ?? '' },
    });
    expect(allocation?.attributedUserId).toBe(ids.member);

    // How much of that rated usage is drawn down is the settlement rules'
    // business (a fresh account holds no credits to draw), and is covered by
    // billing-credit-settlement.persistence.test.ts. What matters here is that
    // the draw is aimed at the organisation's account at all.
  });

  it('returns teams to their own accounts on release, without re-scoping history', async () => {
    const organisationAccount = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );

    const released = await releaseOrgBillingResponsibility(
      { request, actorToken: 'signed-actor', credential },
      lifecycleDeps(prisma),
    );
    expect(released).toMatchObject({ active: false });
    expect(released.released_at).not.toBeNull();

    const resolved = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );
    expect(resolved.id).toBe(ids.teamCreditAccount);
    expect(resolved.balanceMicrocredits).toBe(500000000n);

    // The organisation account and everything settled against it stay exactly
    // where the spend was incurred.
    const organisationRows = await prisma.billingCreditPortfolioSnapshot.count({
      where: { creditAccountId: organisationAccount.id },
    });
    expect(organisationRows).toBeGreaterThan(0);
  });
});
