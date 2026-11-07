import { type PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertBillingActionContext, mintBillingActionContext } from '../../src/services/billing-action-context.service.js';
import { readTeamBillingMode, resolveTeamBillingMode, setTeamBillingMode } from '../../src/services/billing-team-mode.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { resolveCreditAccount } from '../../src/services/billing-credit-account.service.js';
import { actor, createGrantNumber, createSettlement, deferred, financialSnapshot, ids, liveCapture, physicalAccount, seedAdoption, subject }
  from './billing-team-mode-adoption.fixture.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('first explicit historical TEST adoption', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  const adopt = () => setTeamBillingMode({ ...subject, actor, mode: 'sandbox', expectedRevision: 0 }, db);
  beforeEach(async () => {
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID', physicalAccount);
    vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY', 'rk_test_synthetic');
    vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET', 'whsec_synthetic');
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    db = handle.prisma; cleanup = handle.cleanup;
    await seedAdoption(db);
  });
  afterEach(async () => { await cleanup?.(); vi.unstubAllEnvs(); });

  it('preserves TEST balance, active consent, pending recovery and customers byte-for-byte', async () => {
    const before = await financialSnapshot(db);
    expect(before.wallets.find((row) => row.id === ids.creditAccount)?.balanceMicrocredits).toBe(3_000_000_000n);
    expect(before.setups[0]?.status).toBe('OPEN');
    const account = await db.billingStripeAccount.findUniqueOrThrow({ where: { id: 'adoption-live' } });
    const endpoint = '/billing/v1/credits/top-up-checkout';
    const binding = { account, revision: 0, appKeyId: ids.appKey };
    const token = mintBillingActionContext(binding, endpoint, { offer_id: ids.offer });
    expect(await readTeamBillingMode(subject, db)).toMatchObject({ mode: 'live', revision: 0,
      blockers: [], adopting_sandbox_history: true });
    expect(await adopt()).toMatchObject({ mode: 'sandbox', revision: 1 });
    expect(await financialSnapshot(db)).toEqual(before);
    expect(await db.billingTeamMode.findUniqueOrThrow({ where: { teamId: ids.team } }))
      .toMatchObject({ sandbox: true, revision: 1, adoptedStripeAccountId: physicalAccount });
    expect(await db.billingTeamModeEvent.findFirstOrThrow()).toMatchObject({ adoptedStripeAccountId: physicalAccount });
    expect(await db.adminAuditLog.findFirstOrThrow()).toMatchObject({ metadata: {
      organisation_id: ids.org, team_id: ids.team, previous_mode: 'live', mode: 'sandbox', revision: 1,
      actor_user_id: ids.user, adopted_stripe_account_id: physicalAccount, preserved_test_history: true } });
    const testAccount = await db.billingStripeAccount.findUniqueOrThrow({ where: { id: ids.account } });
    expect(await resolveCreditAccount({ account: testAccount, ...subject }, { prisma: db }))
      .toMatchObject({ id: ids.creditAccount, balanceMicrocredits: 3_000_000_000n,
        autoTopUpConsentRevisionId: ids.originalConsent, autoTopUpState: 'ACTIVE' });
    expect(() => assertBillingActionContext(token, { ...binding, account: testAccount, revision: 1 },
      endpoint, { offer_id: ids.offer })).toThrow('BILLING_CONTEXT_STALE');
    await expect(setTeamBillingMode({ ...subject, actor, mode: 'live', expectedRevision: 1 }, db))
      .rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
  });

  it('counts actual terminal LIVE team history, despite a remaining TEST balance', async () => {
    await db.billingCreditSetupCheckout.update({ where: { id: ids.setup }, data: { status: 'EXPIRED' } });
    await db.$transaction(async (tx) => { await liveCapture(tx); });
    await db.billingCreditTopUpCheckout.update({ where: { id: 'adoption-live-capture' }, data: { status: 'EXPIRED' } });
    await expect(adopt()).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
    await expect(db.billingTeamMode.create({ data: { teamId: ids.team, sandbox: true,
      adoptedStripeAccountId: physicalAccount } })).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
  });

  it('refuses financial history in another TEST account', async () => {
    await db.billingStripeAccount.update({ where: { id: ids.account }, data: { stripeAccountId: 'acct_otherTest' } });
    await expect(adopt()).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
  });

  it('refuses active organisation responsibility', async () => {
    await db.billingOrgResponsibility.create({ data: { orgId: ids.org, assumedAt: new Date(), assumedByUserId: ids.user } });
    await expect(adopt()).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
  });

  it('refuses ambiguous current-month cumulative usage', async () => {
    await createSettlement(db, new Date().toISOString().slice(0, 7), ids.account, ids.creditAccount);
    await expect(adopt()).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
  });

  it('refuses an unbound active grant without moving or revoking it', async () => {
    const number = await createGrantNumber(db);
    const grant = await db.billingVoiceGrant.create({ data: { id: 'unbound-grant', serviceId: ids.service, appKeyId: ids.appKey,
      orgId: ids.org, teamId: ids.team, userId: ids.user, actorTokenVersion: 0, numberId: number.id, allocationId: 'allocation',
      delegateId: 'delegate', direction: 'outbound', purpose: 'agent_call', maxDurationSeconds: 60, maxConcurrentCalls: 1, destinations: ['+447700900123'] } });
    await expect(adopt()).rejects.toThrow('BILLING_TEAM_MODE_BLOCKED');
    expect(await db.billingVoiceGrant.findUniqueOrThrow({ where: { id: grant.id } })).toEqual(grant);
  });

  it('rechecks eligibility after a competing LIVE capture commits first', async () => {
    await db.billingCreditSetupCheckout.update({ where: { id: ids.setup }, data: { status: 'EXPIRED' } });
    const captured = deferred(); const release = deferred();
    const live = db.$transaction(async (tx) => { await liveCapture(tx); captured.resolve(); await release.promise; }, { timeout: 10_000 });
    await captured.promise;
    const result = db.billingTeamMode.create({ data: { teamId: ids.team, sandbox: true,
      adoptedStripeAccountId: physicalAccount } }).then(() => 'unexpected success', (error: Error) => error.message);
    // Wait for the actual policy writer to be queued on the held organisation lock.
    try { for (let n = 0; n < 100; n++) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%billing_team_modes%') AS waiting`;
      if (rows[0]?.waiting) break;
      if (n === 99) throw new Error('Policy writer did not wait on capture lock');
      await new Promise((done) => setTimeout(done, 10));
    } } finally { release.resolve(); }
    await live;
    expect(await result).toContain('BILLING_TEAM_MODE_BLOCKED');
    expect(await resolveTeamBillingMode(subject, db)).toEqual({ mode: 'live', revision: 0 });
  });

  it('refuses a competing LIVE capture after the locked adoption commits first', async () => {
    await db.billingCreditSetupCheckout.update({ where: { id: ids.setup }, data: { status: 'EXPIRED' } });
    const selected = deferred(); const release = deferred();
    const policy = db.$transaction(async (tx) => {
      await tx.billingTeamMode.create({ data: { teamId: ids.team, sandbox: true, adoptedStripeAccountId: physicalAccount } });
      selected.resolve(); await release.promise;
    }, { timeout: 10_000 });
    await selected.promise;
    const capture = db.$transaction(async (tx) => { await liveCapture(tx); })
      .then(() => 'unexpected success', (error: Error) => error.message);
    try { for (let n = 0; n < 100; n++) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%billing_credit_top_up_checkouts%') AS waiting`;
      if (rows[0]?.waiting) break;
      if (n === 99) throw new Error('LIVE writer did not wait on policy lock');
      await new Promise((done) => setTimeout(done, 10));
    } } finally { release.resolve(); }
    await policy;
    expect(await capture).toContain('BILLING_CONTEXT_STALE');
    expect(await db.billingCreditTopUpCheckout.count()).toBe(0);
    expect(await resolveTeamBillingMode(subject, db)).toEqual({ mode: 'sandbox', revision: 1 });
  });
});
