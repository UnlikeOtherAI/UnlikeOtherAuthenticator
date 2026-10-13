import type { BillingStoragePaymentAttempt, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { locateStorageAttempt } from '../../src/services/billing-storage-expansion.service.js';

describe('storage response-loss evidence discovery', () => {
  it('revisits a completed pre-egress negative scan after the idempotency window', async () => {
    const attempt = { id: 'attempt', stripeSubscriptionId: null, scanComplete: true, scanCursor: 'old-last-page',
      firstAttemptedAt: new Date('2026-10-09T18:00:00Z') } as BillingStoragePaymentAttempt;
    const remote = { id: 'sub_existing_charge', livemode: false, metadata: { uoa_storage_attempt_id: attempt.id } } as Stripe.Subscription;
    const list = vi.fn(async () => ({ data: [remote], has_more: false }));
    const update = vi.fn(async () => ({ count: 1 }));
    const stripe = { subscriptions: { list } } as unknown as Stripe;
    const prisma = { billingStoragePaymentAttempt: { updateMany: update } } as unknown as PrismaClient;
    await expect(locateStorageAttempt(stripe, attempt, 'cus_exact', false, prisma)).resolves.toBe(remote);
    expect(list).toHaveBeenCalledWith({ customer: 'cus_exact', status: 'all', limit: 100 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { stripeSubscriptionId: remote.id } }));
  });
  it('continues durable page progress and refuses more than one matching remote outcome', async () => {
    const attempt = { id: 'attempt', stripeSubscriptionId: null, scanComplete: false, scanCursor: 'page-one' } as BillingStoragePaymentAttempt;
    const list = vi.fn(async () => ({ data: [{ id: 'unrelated', metadata: {} }], has_more: true }));
    const update = vi.fn(async () => ({ count: 1 }));
    const stripe = { subscriptions: { list } } as unknown as Stripe;
    const prisma = { billingStoragePaymentAttempt: { updateMany: update } } as unknown as PrismaClient;
    await expect(locateStorageAttempt(stripe, attempt, 'cus_exact', false, prisma)).rejects.toThrow('BILLING_STORAGE_ATTEMPT_SCAN_CONTINUING');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ starting_after: 'page-one' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { scanCursor: 'unrelated', scanComplete: false } }));
    list.mockResolvedValueOnce({ data: [{ id: 'sub_a', metadata: { uoa_storage_attempt_id: attempt.id } },
      { id: 'sub_b', metadata: { uoa_storage_attempt_id: attempt.id } }], has_more: false });
    await expect(locateStorageAttempt(stripe, attempt, 'cus_exact', false, prisma)).rejects.toThrow('BILLING_STORAGE_ATTEMPT_AMBIGUOUS');
  });
});
