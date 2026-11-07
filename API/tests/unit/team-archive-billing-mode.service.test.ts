import type { PrismaClient, TeamArchiveOperation } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { stopArchivedTeamBilling } from '../../src/services/team-archive-billing.service.js';
import { requireStripeWebhookConfigured, resetStripeClientCache, stripeRuntimeForAccount }
  from '../../src/services/billing-stripe-client.service.js';

const main = 'acct_1Sn2VfGY1l8e0vu2';
const testAccount = { id: 'captured-test', stripeAccountId: main, livemode: false };
const liveAccount = { id: 'captured-live', stripeAccountId: main, livemode: true };
const now = new Date('2026-11-07T20:00:00.000Z');
const operation = { orgId: 'archive-org', teamId: 'archive-team', settleAfter: now } as TeamArchiveOperation;
const pages = <T>(values: T[]) => ({ async *[Symbol.asyncIterator]() { yield* values; } });

function provider(client: Stripe, livemode: boolean, customer: string) {
  const account = vi.spyOn(client.accounts, 'retrieveCurrent').mockResolvedValue({ id: main } as never);
  const sessions = vi.spyOn(client.checkout.sessions, 'list').mockReturnValue(pages([]) as never);
  const subscriptions = vi.spyOn(client.subscriptions, 'list').mockReturnValue(pages([
    { id: `sub_${customer}`, customer, livemode, status: 'active' },
  ]) as never);
  const cancel = vi.spyOn(client.subscriptions, 'cancel').mockResolvedValue({ status: 'canceled' } as never);
  const invoices = vi.spyOn(client.invoices, 'list').mockReturnValue(pages([]) as never);
  const payments = vi.spyOn(client.paymentIntents, 'list').mockReturnValue(pages([]) as never);
  return { account, sessions, subscriptions, cancel, invoices, payments };
}

function fixture(bothModes = false) {
  const sandbox = stripeRuntimeForAccount(testAccount);
  const live = stripeRuntimeForAccount(liveAccount);
  const legacy = requireStripeWebhookConfigured();
  const testProvider = provider(sandbox.client, false, 'cus_historical_test');
  const liveProvider = provider(live.client, true, 'cus_historical_live');
  const expired = vi.spyOn(legacy.client.accounts, 'retrieveCurrent').mockRejectedValue(
    new Stripe.errors.StripeAuthenticationError({ message: 'Synthetic expired legacy key' }));
  const customer = (account: typeof testAccount, id: string) => ({ accountId: account.id, account,
    scopeKey: `${operation.orgId}:${operation.teamId}`, stripeCustomerId: id });
  const rows = [customer(testAccount, 'cus_historical_test'),
    ...(bothModes ? [customer(liveAccount, 'cus_historical_live')] : [])];
  const prisma = { billingStripeCustomer: { findMany: vi.fn().mockResolvedValue(rows) },
    billingStripeAccount: { upsert: vi.fn(async ({ where }: {
      where: { stripeAccountId_livemode: { stripeAccountId: string; livemode: boolean } };
    }) => where.stripeAccountId_livemode.livemode ? liveAccount : testAccount) } } as unknown as PrismaClient;
  return { prisma, sandbox, live, legacy, expired, testProvider, liveProvider };
}

describe('archive reconciliation captured billing mode', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_BILLING_ENABLED', 'false');
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_expired_legacy_fixture');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_legacy_fixture');
    vi.stubEnv('STRIPE_SANDBOX_SECRET_KEY', 'rk_test_fresh_sandbox_fixture');
    vi.stubEnv('STRIPE_SANDBOX_WEBHOOK_SECRET', 'whsec_legacy_fixture');
    vi.stubEnv('STRIPE_SANDBOX_ACCOUNT_ID', main);
    vi.stubEnv('STRIPE_LIVE_SECRET_KEY', 'rk_live_fresh_fixture');
    vi.stubEnv('STRIPE_LIVE_WEBHOOK_SECRET', 'whsec_live_fixture');
    vi.stubEnv('STRIPE_LIVE_ACCOUNT_ID', main);
    resetStripeClientCache();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetStripeClientCache(); });

  it('uses the fresh named sandbox for captured main TEST with expired legacy and collection disabled', async () => {
    const f = fixture();
    expect(f.sandbox.client).not.toBe(f.legacy.client);
    expect(await stopArchivedTeamBilling(operation, { prisma: f.prisma, now: () => now })).toBe(true);
    expect(f.testProvider.account).toHaveBeenCalledOnce();
    expect(f.testProvider.subscriptions).toHaveBeenCalledWith({ customer: 'cus_historical_test', status: 'all', limit: 100 });
    expect(f.testProvider.cancel).toHaveBeenCalledWith('sub_cus_historical_test', { invoice_now: false, prorate: false });
    expect(f.expired).not.toHaveBeenCalled();
    expect(f.liveProvider.account).not.toHaveBeenCalled();
    expect(f.liveProvider.cancel).not.toHaveBeenCalled();
  });

  it('reconciles both captured tuples independently without crossing customers', async () => {
    const f = fixture(true);
    expect(await stopArchivedTeamBilling(operation, { prisma: f.prisma, now: () => now })).toBe(true);
    expect(f.testProvider.cancel).toHaveBeenCalledExactlyOnceWith('sub_cus_historical_test', { invoice_now: false, prorate: false });
    expect(f.liveProvider.cancel).toHaveBeenCalledExactlyOnceWith('sub_cus_historical_live', { invoice_now: false, prorate: false });
    expect(f.testProvider.payments).toHaveBeenCalledExactlyOnceWith({ customer: 'cus_historical_test', limit: 100 });
    expect(f.liveProvider.payments).toHaveBeenCalledExactlyOnceWith({ customer: 'cus_historical_live', limit: 100 });
    expect(f.expired).not.toHaveBeenCalled();
  });

  it.each([true, false])('refuses a LIVE client for a TEST capture even if its supplied mode is %s', async suppliedMode => {
    const f = fixture();
    await expect(stopArchivedTeamBilling(operation, { prisma: f.prisma,
      stripe: f.live.client, livemode: suppliedMode, now: () => now })).rejects.toThrow(
      suppliedMode ? 'ARCHIVE_BILLING_ACCOUNT_UNAVAILABLE' : 'BILLING_STRIPE_ACCOUNT_MISMATCH');
    expect(f.testProvider.cancel).not.toHaveBeenCalled();
    expect(f.liveProvider.cancel).not.toHaveBeenCalled();
    expect(f.liveProvider.sessions).not.toHaveBeenCalled();
  });
});
