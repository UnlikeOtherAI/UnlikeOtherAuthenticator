import type { PrismaClient, TeamArchiveOperation } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { stopArchivedTeamBilling, type ArchiveStripe } from '../../src/services/team-archive-billing.service.js';

const now = new Date('2026-11-07T12:00:00Z');
const operation: TeamArchiveOperation = { id: '7ed35e23-a6a0-46fa-a32f-ee6447a3b173', orgId: 'org', teamId: 'team',
  sourceClientDomainId: 'product', actorUserId: 'actor', deletionHeld: true, billingStoppedAt: null,
  settleAfter: now, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now, createdAt: now };
function pages<T>(values: T[]) { return { async *[Symbol.asyncIterator]() { yield* values; } }; }
function fixture() {
  const customer = { accountId: 'account', account: { livemode: false }, scopeKey: 'org:team', stripeCustomerId: 'cus_team' };
  const prisma = { billingStripeCustomer: { findMany: vi.fn().mockResolvedValue([customer]) },
    billingStripeAccount: { upsert: vi.fn().mockResolvedValue({ id: 'account', stripeAccountId: 'acct_test', livemode: false }) } };
  const stripe = {
    accounts: { retrieveCurrent: vi.fn().mockResolvedValue({ id: 'acct_test' }) },
    checkout: { sessions: { list: vi.fn().mockReturnValue(pages([{ id: 'cs_open', customer: 'cus_team', livemode: false }])),
      expire: vi.fn().mockResolvedValue({ status: 'expired' }), retrieve: vi.fn() } },
    subscriptions: { list: vi.fn().mockReturnValue(pages([{ id: 'sub_active', customer: 'cus_team', livemode: false, status: 'active' }])),
      cancel: vi.fn().mockResolvedValue({ status: 'canceled' }), retrieve: vi.fn() },
    invoices: { list: vi.fn().mockReturnValue(pages([{ id: 'in_open', customer: 'cus_team', livemode: false, auto_advance: true }])),
      update: vi.fn().mockResolvedValue({ auto_advance: false }) },
    paymentIntents: { list: vi.fn().mockReturnValue(pages([{ id: 'pi_pending', customer: 'cus_team', livemode: false, status: 'requires_payment_method' }])),
      cancel: vi.fn().mockResolvedValue({ status: 'canceled' }), retrieve: vi.fn() },
  };
  const run = (row = operation) => stopArchivedTeamBilling(row, { prisma: prisma as unknown as PrismaClient,
    stripe: stripe as unknown as ArchiveStripe, livemode: false, now: () => now });
  return { prisma, stripe, customer, run };
}

describe('archive billing stop evidence', () => {
  it('cancels immediately without a final invoice or proration and scopes every call to the team customer', async () => {
    const { run, prisma, stripe } = fixture();
    expect(await run()).toBe(true);
    expect(prisma.billingStripeCustomer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: 'org', teamId: 'team', scope: 'TEAM' } }));
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_active', { invoice_now: false, prorate: false });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_open');
    expect(stripe.invoices.update).toHaveBeenCalledWith('in_open', { auto_advance: false });
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_pending');
  });
  it('waits for previously admitted provider work before certifying a stop', async () => {
    const { run, stripe } = fixture();
    expect(await run({ ...operation, settleAfter: new Date(now.getTime() + 60_000) })).toBe(false);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_active', { invoice_now: false, prorate: false });
  });
  it('refuses a foreign account or customer binding before provider mutation', async () => {
    const { run, customer, stripe } = fixture(); customer.scopeKey = 'org:sibling';
    await expect(run()).rejects.toThrow('ARCHIVE_BILLING_ACCOUNT_UNAVAILABLE');
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });
  it('does not certify billing when a payment remains processing', async () => {
    const { run, stripe } = fixture();
    stripe.paymentIntents.cancel.mockRejectedValue(new Error('processing'));
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: 'processing' });
    await expect(run()).rejects.toThrow('processing');
  });
  it('accepts a terminal state after a lost cancel response and safely repeats the scan', async () => {
    const { run, stripe } = fixture();
    stripe.subscriptions.cancel.mockRejectedValue(new Error('lost response'));
    stripe.subscriptions.retrieve.mockResolvedValue({ status: 'canceled' });
    expect(await run()).toBe(true); expect(await run()).toBe(true);
  });
});
