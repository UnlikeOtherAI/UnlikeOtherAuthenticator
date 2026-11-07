import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { beginTeamArchive } from '../../src/services/team-archive.service.js';
import { stopArchivedTeamBilling } from '../../src/services/team-archive-billing.service.js';
import { reconcileTeamArchives } from '../../src/services/team-archive-reconciliation.service.js';
import { requireStripeWebhookConfigured, resetStripeClientCache, stripeRuntimeForAccount }
  from '../../src/services/billing-stripe-client.service.js';

const main = 'acct_1Sn2VfGY1l8e0vu2';
const pages = <T>(values: T[]) => ({ async *[Symbol.asyncIterator]() { yield* values; } });
describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('archive recovery retains the captured TEST tuple', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => {
    vi.stubEnv('STRIPE_BILLING_ENABLED', 'false');
    for (const [key, value] of Object.entries({ STRIPE_SECRET_KEY: 'rk_test_expired_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_legacy_fixture',
      STRIPE_SANDBOX_SECRET_KEY: 'rk_test_fresh_fixture', STRIPE_SANDBOX_WEBHOOK_SECRET: 'whsec_legacy_fixture',
      STRIPE_SANDBOX_ACCOUNT_ID: main, STRIPE_LIVE_SECRET_KEY: 'rk_live_fresh_fixture',
      STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_live_fixture', STRIPE_LIVE_ACCOUNT_ID: main })) vi.stubEnv(key, value);
    resetStripeClientCache(); db = (await createTestDb())!;
  });
  afterAll(async () => { await db?.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetStripeClientCache(); });

  it('archives under current authority and retries exact TEAM TEST recovery without the expired legacy or LIVE client', async () => {
    const domain = 'archive-mode.example.test', token = 'a'.repeat(64);
    const user = await db.prisma.user.create({ data: { email: 'archive-mode@example.test', userKey: randomUUID() } });
    const org = await db.prisma.organisation.create({ data: { domain, name: 'Archive mode', slug: 'archive-mode', ownerId: user.id } });
    const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Historical TEST team', slug: 'test' } });
    await db.prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'owner' } });
    const client = await db.prisma.clientDomain.create({ data: { domain, label: 'Archive mode' } });
    await db.prisma.clientDomainSecret.create({ data: { domainId: client.id,
      secretDigest: digestDomainClientHash(token), hashPrefix: token.slice(0, 16) } });
    const account = await db.prisma.billingStripeAccount.create({ data: { stripeAccountId: main, livemode: false } });
    const liveAccount = await db.prisma.billingStripeAccount.create({ data: { stripeAccountId: main, livemode: true } });
    const customer = await db.prisma.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id,
      teamId: team.id, scope: 'TEAM', scopeKey: `${org.id}:${team.id}`, stripeCustomerId: 'cus_archive_test' } });
    const shared = await db.prisma.billingStripeCustomer.create({ data: { accountId: liveAccount.id, orgId: org.id,
      scope: 'ORGANISATION', scopeKey: org.id, stripeCustomerId: 'cus_shared_live' } });
    // No team policy: historical recovery must not inherit this team's default LIVE mode.
    const receipt = await beginTeamArchive({ id: randomUUID(), orgId: org.id, teamId: team.id, domain, domainToken: token,
      config: validateConfigFields(baseClientConfigPayload({ domain })), claims: { userId: user.id, email: user.email!,
        tokenVersion: user.tokenVersion, clientId: token, role: 'user', domain,
        org: { org_id: org.id, org_role: 'owner', teams: [team.id], team_roles: {} }, active: { orgId: org.id, teamId: team.id } },
    }, { prisma: db.prisma });
    expect(receipt.status).toBe('STOPPING_BILLING');
    const operation = await db.prisma.teamArchiveOperation.findUniqueOrThrow({ where: { id: receipt.id } });
    const sandbox = stripeRuntimeForAccount(account), live = stripeRuntimeForAccount(liveAccount);
    const legacy = requireStripeWebhookConfigured();
    const expired = vi.spyOn(legacy.client.accounts, 'retrieveCurrent').mockRejectedValue(
      new Stripe.errors.StripeAuthenticationError({ message: 'Synthetic expired key' }));
    vi.spyOn(live.client.accounts, 'retrieveCurrent').mockResolvedValue({ id: main } as never);
    const liveList = vi.spyOn(live.client.subscriptions, 'list');
    await expect(stopArchivedTeamBilling(operation, { prisma: db.prisma, stripe: live.client, livemode: true }))
      .rejects.toThrow('ARCHIVE_BILLING_ACCOUNT_UNAVAILABLE');
    expect(liveList).not.toHaveBeenCalled();
    vi.spyOn(sandbox.client.accounts, 'retrieveCurrent').mockResolvedValue({ id: main } as never);
    vi.spyOn(sandbox.client.checkout.sessions, 'list').mockReturnValue(pages([]) as never);
    let status = 'active';
    const subscriptions = vi.spyOn(sandbox.client.subscriptions, 'list').mockImplementation(() => pages([
      { id: 'sub_archive_test', customer: customer.stripeCustomerId, livemode: false, status },
    ]) as never);
    const cancel = vi.spyOn(sandbox.client.subscriptions, 'cancel').mockImplementation(async () => {
      status = 'canceled'; return { status } as never;
    });
    vi.spyOn(sandbox.client.invoices, 'list').mockReturnValue(pages([]) as never);
    vi.spyOn(sandbox.client.paymentIntents, 'list').mockReturnValue(pages([]) as never);
    expect(await stopArchivedTeamBilling(operation, { prisma: db.prisma, now: () => operation.createdAt })).toBe(false);
    const afterWindow = new Date(operation.settleAfter.getTime() + 1_000);
    expect(await reconcileTeamArchives({ prisma: db.prisma, now: () => afterWindow,
      stopBilling: (row, deps) => stopArchivedTeamBilling(row, { ...deps, now: () => afterWindow }),
    })).toMatchObject({ completed: 1, failed: 0 });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('sub_archive_test', { invoice_now: false, prorate: false });
    expect(subscriptions).toHaveBeenCalledWith({ customer: 'cus_archive_test', status: 'all', limit: 100 });
    expect(expired).not.toHaveBeenCalled(); expect(liveList).not.toHaveBeenCalled();
    expect(await db.prisma.billingStripeCustomer.findUniqueOrThrow({ where: { id: customer.id } })).toEqual(customer);
    expect(await db.prisma.billingStripeCustomer.findUniqueOrThrow({ where: { id: shared.id } })).toEqual(shared);
    expect((await db.prisma.teamArchiveOperation.findUniqueOrThrow({ where: { id: operation.id } })).billingStoppedAt).toEqual(afterWindow);
    expect((await db.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).lifecycleStatus).toBe('ARCHIVED');
  });
});
