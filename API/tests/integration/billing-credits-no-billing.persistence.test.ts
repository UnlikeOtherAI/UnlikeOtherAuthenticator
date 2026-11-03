import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertBillingCreditsContract } from '../../src/routes/billing/credits.js';
import { resolveCreditCollectionContextForRead } from '../../src/services/billing-credit-account.service.js';
import { getBillingCredits } from '../../src/services/billing-credits.service.js';
import { resolveEffectiveTariffContext } from '../../src/services/billing-entitlement.service.js';
import {
  billingRegionView,
  readOrganisationBillingRegion,
  setOrganisationBillingRegion,
} from '../../src/services/billing-organisation-region.service.js';
import { AppError } from '../../src/utils/errors.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const now = new Date('2026-11-03T10:00:00.000Z');
const ids = {
  user: 'usr_no_billing',
  org: 'org_no_billing',
  team: 'team_no_billing',
  service: 'svc_no_billing',
  appKey: 'bak_no_billing',
  account: 'bsa_no_billing',
  tariff: 'btf_no_billing',
  // An organisation that has assumed billing responsibility: its team's own
  // credit account and the organisation's coexist, both on the one test-mode
  // provider account. A team balance is never swept on assume or release.
  assumedOrg: 'org_assumed',
  assumedTeam: 'team_assumed',
  assumedCustomer: 'bsc_assumed',
  assumedTeamCredit: 'bca_assumed_team',
  assumedOrgCredit: 'bca_assumed_org',
};

const credential = {
  id: ids.appKey,
  purpose: 'CUSTOMER_LIFECYCLE',
  actorIssuer: 'https://product.example.test',
  actorAudience: 'https://uoa.example.test/billing',
  actorKeyId: 'k1',
  actorPublicJwk: { kty: 'RSA' },
  checkoutReturnOrigins: ['https://product.example.test'],
  service: { id: ids.service, identifier: 'no-billing', name: 'No Billing' },
} as never;

const request = { product: 'no-billing', organisationId: ids.org, teamId: ids.team, userId: ids.user };

/** The organisation exactly as `createOrganisation` leaves it: owner, team, no billing rows at all. */
async function seed(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.user.create({ data: { id: ids.user, email: 'founder@no-billing.test',
      userKey: 'founder@no-billing.test', name: 'Founder' } });
    await tx.billingService.create({ data: { id: ids.service, identifier: 'no-billing', name: 'No Billing',
      tariffHistoryFromMonth: '2026-01' } });
    await tx.billingAppKey.create({ data: { id: ids.appKey, serviceId: ids.service,
      purpose: 'CUSTOMER_LIFECYCLE', name: 'Lifecycle', keyPrefix: 'uoa_nob', secretDigest: 'd'.repeat(64),
      actorIssuer: 'https://product.example.test', actorAudience: 'https://uoa.example.test/billing',
      actorKeyId: 'k1', actorPublicJwk: { kty: 'RSA' },
      checkoutReturnOrigins: ['https://product.example.test'] } });
    await tx.billingStripeAccount.create({ data: { id: ids.account, stripeAccountId: 'acct_no_billing',
      livemode: false } });
    // A service default is the only commercial record a founded organisation inherits.
    await tx.billingTariff.create({ data: { id: ids.tariff, serviceId: ids.service, key: 'standard',
      version: 1, name: 'Standard', mode: 'STANDARD', collectionMode: 'STRIPE', markupBps: 0,
      currency: 'USD', isDefault: true } });
    await tx.billingTariffTermEvent.create({ data: { serviceId: ids.service, source: 'SERVICE_DEFAULT',
      scopeKey: ids.service, effectiveFromMonth: '2026-01', tariffId: ids.tariff, reason: 'seed' } });
    await tx.organisation.create({ data: { id: ids.org, domain: 'no-billing.example.test',
      name: 'Divergent Games', slug: 'divergent-games', ownerId: ids.user } });
    await tx.orgMember.create({ data: { orgId: ids.org, userId: ids.user, role: 'owner', status: 'ACTIVE' } });
    await tx.team.create({ data: { id: ids.team, orgId: ids.org, name: 'Divergent Games',
      slug: 'divergent-games' } });
    await tx.teamMember.create({ data: { teamId: ids.team, userId: ids.user, teamRole: 'owner',
      status: 'ACTIVE' } });

    await tx.organisation.create({ data: { id: ids.assumedOrg, domain: 'assumed.example.test',
      name: 'Assumed', slug: 'assumed', ownerId: ids.user } });
    await tx.team.create({ data: { id: ids.assumedTeam, orgId: ids.assumedOrg, name: 'Assumed',
      slug: 'assumed' } });
    await tx.billingStripeCustomer.create({ data: { id: ids.assumedCustomer, accountId: ids.account,
      orgId: ids.assumedOrg, teamId: null, scope: 'ORGANISATION', scopeKey: ids.assumedOrg } });
    await tx.billingCreditAccount.create({ data: { id: ids.assumedTeamCredit, accountId: ids.account,
      customerId: ids.assumedCustomer, orgId: ids.assumedOrg, teamId: ids.assumedTeam, scope: 'TEAM',
      scopeKey: `${ids.assumedOrg}:${ids.assumedTeam}`, currency: 'USD',
      balanceMicrocredits: 500_000_000n } });
    await tx.billingCreditAccount.create({ data: { id: ids.assumedOrgCredit, accountId: ids.account,
      customerId: ids.assumedCustomer, orgId: ids.assumedOrg, teamId: null, scope: 'ORGANISATION',
      scopeKey: ids.assumedOrg, currency: 'USD' } });

  });
}

describe.skipIf(!enabled)('credits for an organisation with no billing set up (PostgreSQL)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const db = () => handle!.prisma;

  beforeAll(async () => {
    handle = await createTestDb();
    if (handle) await seed(handle.prisma);
  });
  afterAll(async () => { await handle?.cleanup(); });

  function deps(overrides: object = {}) {
    return {
      prisma: db(),
      now: () => now,
      resolveEntitlement: (p: never, d: never) => resolveEffectiveTariffContext(p, {
        ...(d as object),
        verifyActor: vi.fn().mockResolvedValue({ iss: 'https://product.example.test',
          aud: 'https://uoa.example.test/billing', sub: ids.user, product: 'no-billing',
          organisation_id: ids.org, team_id: ids.team, tv: 0, jti: 'jti-1',
          iat: Math.floor(now.getTime() / 1000), exp: Math.floor(now.getTime() / 1000) + 60 }),
      } as never),
      // No usage has ever been metered for this organisation.
      fetchPortfolio: vi.fn().mockRejectedValue(
        new AppError('INTERNAL', 502, 'LEDGER_METERING_PORTFOLIO_REQUEST_FAILED')),
      ...overrides,
    } as never;
  }

  const providerUnavailable = () => vi.fn().mockRejectedValue(
    new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE'));

  /** A configured credential, as production has. The env schema requires the pair. */
  const configureKey = (secretKey = 'sk_test_no_billing') => {
    vi.stubEnv('STRIPE_SECRET_KEY', secretKey);
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_no_billing');
  };

  /** The read's fallback with a test-mode key configured, as production has. */
  const outageFallback = async (organisationId: string, teamId: string) => {
    configureKey();
    try {
      return await resolveCreditCollectionContextForRead({ organisationId, teamId },
        { prisma: db(), resolveCollection: providerUnavailable() });
    } finally {
      vi.unstubAllEnvs();
    }
  };

  const read = (extra: object = {}) => getBillingCredits({
    request, actorToken: 'actor', credential, endpoint: '/billing/v1/credits' as never,
    locale: 'en-US' as never, supportsBillingStatus: true, supportsPurchaseCurrency: true,
    supportsReloadCurrency: true, supportsRegionValue: true,
  }, deps(extra));

  it('projects no credits, no payment method and no offers instead of refusing', async () => {
    const credits = await read();

    assertBillingCreditsContract(credits);
    expect(credits).toMatchObject({
      subject: { organisation_id: ids.org, team_id: ids.team, user_id: ids.user },
      credit_balance: { credits: '0', state: 'zero' },
      pending_credits: { top_up_count: 0 },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      viewer: { role: 'billing_manager' },
    });
    expect(credits).not.toHaveProperty('controlled_by');
    // The founder is the organisation's own credit account holder from the first read.
    const creditAccounts = await db().billingCreditAccount.findMany({ where: { orgId: ids.org } });
    expect(creditAccounts).toHaveLength(1);
    expect(creditAccounts[0]).toMatchObject({ balanceMicrocredits: 0n, stripePaymentMethodId: null });
  });

  it('still answers when the configured payment credential has expired', async () => {
    // Exactly the production failure: Stripe refuses configured account resolution
    // with api_key_expired, which `resolveStripeAccountContext` maps to this refusal.
    const log = { error: vi.fn() };
    const expired = providerUnavailable();
    configureKey();
    const frozen = await resolveCreditCollectionContextForRead(
      { organisationId: ids.org, teamId: ids.team },
      { prisma: db(), log, resolveCollection: expired },
    );

    expect(frozen).toMatchObject({ stripeCollectionEnabled: false, stripe: null,
      account: { id: ids.account, stripeAccountId: 'acct_no_billing', livemode: false } });
    expect(log.error).toHaveBeenCalledOnce();

    const credits = await read({
      resolveCollection: (p: never, d: never) => resolveCreditCollectionContextForRead(p,
        { ...(d as object), resolveCollection: expired } as never),
    }).finally(() => { vi.unstubAllEnvs(); });

    assertBillingCreditsContract(credits);
    expect(credits).toMatchObject({
      collection: { stripe_collection_enabled: false },
      credit_balance: { credits: '0', state: 'zero' },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
    });
  });

  it('refuses a payment-provider failure that is not the provider being unreachable', async () => {
    const other = vi.fn().mockRejectedValue(
      new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS'));
    await expect(resolveCreditCollectionContextForRead({ organisationId: ids.org, teamId: ids.team },
      { prisma: db(), resolveCollection: other })).rejects.toMatchObject({ statusCode: 409,
      message: 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS' });
  });

  it('still resolves while the team and organisation accounts coexist', async () => {
    // Assuming organisation billing leaves both rows in place on the one
    // provider account, and releasing it leaves them too. Two rows are not two
    // identities, so an outage read must not call this ambiguous.
    const frozen = await outageFallback(ids.assumedOrg, ids.assumedTeam);

    expect(frozen).toMatchObject({ stripeCollectionEnabled: false, stripe: null,
      account: { id: ids.account, livemode: false } });
  });

  describe('the configured key\'s mode decides which persisted account will do', () => {
    const live = { id: 'bsa_live', stripeAccountId: 'acct_live', livemode: true };
    const test = { id: 'bsa_test', stripeAccountId: 'acct_test', livemode: false };
    /** Records the `where` each lookup was given, so the mode filter is visible. */
    const lookups = (creditAccounts: object[], providerAccounts: object[]) => {
      const seen: unknown[] = [];
      const match = (rows: object[], where: unknown) => {
        seen.push(where);
        const wanted = (where as { livemode?: boolean } | undefined)?.livemode
          ?? (where as { account?: { livemode?: boolean } } | undefined)?.account?.livemode;
        return wanted === undefined ? rows
          : rows.filter((row) => {
            const account = (row as { account?: { livemode: boolean }; livemode?: boolean });
            return (account.account?.livemode ?? account.livemode) === wanted;
          });
      };
      return { seen, prisma: {
        billingCreditAccount: { findMany: async ({ where }: { where?: unknown }) =>
          match(creditAccounts, where) },
        billingStripeAccount: { findMany: async ({ where }: { where?: unknown }) =>
          match(providerAccounts, where) },
      } as never };
    };

    it('never settles against the other mode when its own mode is available', async () => {
      // The organisation transacted in live mode before the deployment moved to
      // a test key. The test-mode account is the only safe one to settle on.
      const { prisma, seen } = lookups([{ account: live }], [live, test]);
      configureKey();
      try {
        await expect(resolveCreditCollectionContextForRead(
          { organisationId: ids.org, teamId: ids.team },
          { prisma, resolveCollection: providerUnavailable() },
        )).resolves.toMatchObject({ stripeCollectionEnabled: false, account: test });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual([expect.objectContaining({ account: { livemode: false } }),
        { livemode: false }]);
    });

    it('refuses when no account exists in the configured mode', async () => {
      const { prisma } = lookups([{ account: live }], [live]);
      configureKey();
      try {
        await expect(resolveCreditCollectionContextForRead(
          { organisationId: ids.org, teamId: ids.team },
          { prisma, resolveCollection: providerUnavailable() },
        )).rejects.toMatchObject({ statusCode: 503,
          message: 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE' });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('refuses when the configured key names no mode to match', async () => {
      const { prisma } = lookups([{ account: test }], [test]);
      configureKey('not-a-stripe-key');
      try {
        await expect(resolveCreditCollectionContextForRead(
          { organisationId: ids.org, teamId: ids.team },
          { prisma, resolveCollection: providerUnavailable() },
        )).rejects.toMatchObject({ statusCode: 503,
          message: 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE' });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('propagates a genuinely ambiguous account instead of reporting an outage', async () => {
      // Two distinct identities in the configured mode is a permanent conflict
      // an operator must resolve; it must not look like a temporary outage.
      const { prisma } = lookups(
        [{ account: test }, { account: { ...test, id: 'bsa_test_2' } }], [test]);
      configureKey();
      try {
        await expect(resolveCreditCollectionContextForRead(
          { organisationId: ids.org, teamId: ids.team },
          { prisma, resolveCollection: providerUnavailable() },
        )).rejects.toMatchObject({ statusCode: 409,
          message: 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS' });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('keeps refusing when the provider was never reached even once', async () => {
    const unreachable = new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE');
    // A deployment with no persisted account has no identity to fall back to.
    const noAccount = { ...db(), billingCreditAccount: { findMany: async () => [] },
      billingStripeAccount: { findMany: async () => [] } } as never;
    configureKey();
    try {
      await expect(resolveCreditCollectionContextForRead(
        { organisationId: ids.org, teamId: ids.team },
        { prisma: noAccount, resolveCollection: vi.fn().mockRejectedValue(unreachable) },
      )).rejects.toBe(unreachable);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets the founder choose the billing region with nothing else configured', async () => {
    expect(await readOrganisationBillingRegion(ids.org, db())).toBeNull();
    expect(await billingRegionView(ids.org, true, db())).toMatchObject({ region: null, currency: null,
      suggested_region: 'US', suggested_from: null, can_set: true });

    const chosen = await setOrganisationBillingRegion({
      request: { ...request, product: 'no-billing' } as never, region: 'EUROPE', actorToken: 'actor',
      credential, endpoint: '/billing/v1/organisation-billing/region' as never,
    }, {
      prisma: db(), now: () => now,
      resolveTariff: vi.fn().mockResolvedValue({ actor: { jti: 'jti-region' }, payload: {} }),
      isOrganisationManager: vi.fn().mockResolvedValue(true),
      authorizeAction: vi.fn().mockResolvedValue(undefined),
      // No provider credential, so no rate is captured now; the first valuation captures it.
      captureRate: vi.fn().mockResolvedValue(undefined),
    } as never);

    expect(chosen).toMatchObject({ region: 'EUROPE', currency: 'EUR', can_set: false });
    expect(await readOrganisationBillingRegion(ids.org, db())).toEqual({ region: 'EUROPE',
      currency: 'EUR' });
  });
});
