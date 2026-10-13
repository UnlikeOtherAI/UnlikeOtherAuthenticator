import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { recoverCommercialStripeEvents } from '../../src/services/billing-commercial-event-recovery.service.js';
import { STRIPE_BILLING_API_VERSION } from '../../src/services/billing-stripe-client.service.js';

function fixture() {
  const now = new Date('2026-10-13T18:00:00Z');
  const scan = { accountId: 'account', fromSecond: 0, throughSecond: Math.floor(now.getTime() / 1000),
    cursor: null as string | null, generation: 0, nextAttemptAt: new Date(0) };
  type Job = { accountId: string; eventId: string; eventType: string; objectId: string; completedAt: Date | null;
    nextAttemptAt: Date; attemptCount: number };
  const jobs: Job[] = [];
  const recovery = {
    upsert: async (args: { create: Pick<Job, 'accountId' | 'eventId' | 'eventType' | 'objectId'> }) => {
      if (!jobs.some((row) => row.eventId === args.create.eventId)) jobs.push({ ...args.create,
        completedAt: null, nextAttemptAt: new Date(0), attemptCount: 0 });
    },
    findMany: async () => jobs.filter((row) => !row.completedAt && row.nextAttemptAt <= now).slice(0, 25),
    updateMany: async (args: { where: { eventId: string }; data: Partial<Job> & { attemptCount?: { increment: number } } }) => {
      const row = jobs.find((job) => job.eventId === args.where.eventId)!;
      if (args.data.nextAttemptAt) row.nextAttemptAt = args.data.nextAttemptAt;
      if (args.data.completedAt) row.completedAt = args.data.completedAt;
      if (args.data.attemptCount) row.attemptCount += args.data.attemptCount.increment;
      return { count: 1 };
    },
  };
  const database = { billingStripeAccount: { upsert: async () => ({ id: 'account', stripeAccountId: 'acct_fixture', livemode: false }) },
    billingCommercialEventScan: { upsert: async () => scan,
      updateMany: async (args: { data: Partial<typeof scan> & { generation?: { increment: number } } }) => {
        if (args.data.cursor !== undefined) scan.cursor = args.data.cursor;
        if (args.data.nextAttemptAt) scan.nextAttemptAt = args.data.nextAttemptAt;
        if (args.data.fromSecond !== undefined) scan.fromSecond = args.data.fromSecond;
        if (args.data.throughSecond !== undefined) scan.throughSecond = args.data.throughSecond;
        if (args.data.generation) scan.generation += args.data.generation.increment;
        return { count: 1 };
      } }, billingCommercialEventRecovery: recovery,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(database) };
  const event = (id: string, type = 'invoice.payment_failed') => ({ id, type,
    api_version: STRIPE_BILLING_API_VERSION, livemode: false, created: scan.throughSecond - 1,
    data: { object: { id: `in_${id}` } } }) as Stripe.Event;
  const remote = new Map<string, Stripe.Event>();
  const list = vi.fn(async () => ({ data: [] as Stripe.Event[], has_more: false }));
  const stripe = { accounts: { retrieveCurrent: async () => ({ id: 'acct_fixture' }) },
    events: { list, retrieve: async (id: string) => remote.get(id)! } } as unknown as Stripe;
  return { now, scan, jobs, remote, list, event, stripe, prisma: database as unknown as PrismaClient };
}

describe('durable commercial original-event recovery', () => {
  it('advances beyond unrelated burst pages and retains original failure work across polls', async () => {
    const data = fixture();
    const burst = Array.from({ length: 100 }, (_, index) => data.event(`unrelated-${index}`));
    const original = data.event('original', 'invoice.payment_action_required');
    for (const event of [...burst, original]) data.remote.set(event.id, event);
    data.list.mockResolvedValueOnce({ data: burst, has_more: true }).mockResolvedValueOnce({ data: [original], has_more: false });
    const apply = vi.fn(async () => ({ duplicate: false }));
    await recoverCommercialStripeEvents({ ...data, apply });
    expect(data.scan.cursor).toBe('unrelated-99'); expect(data.jobs).toHaveLength(100);
    data.scan.nextAttemptAt = new Date(0);
    await recoverCommercialStripeEvents({ ...data, apply });
    expect(data.list.mock.calls[1]?.[0]).toMatchObject({ starting_after: 'unrelated-99' });
    expect(data.jobs.find((job) => job.eventId === original.id)?.eventType).toBe('invoice.payment_action_required');
    expect(data.scan.cursor).toBeNull();
  });
  it('retries one unresolved failure without starving a later paid event', async () => {
    const data = fixture();
    const failures = [data.event('failed'), data.event('paid', 'invoice.paid')];
    for (const event of failures) data.remote.set(event.id, event);
    data.list.mockResolvedValue({ data: failures, has_more: false });
    const apply = vi.fn(async ({ event }: { event: Stripe.Event }) => {
      if (event.id === 'failed') throw new Error('history scan continuing'); return { duplicate: false };
    });
    await recoverCommercialStripeEvents({ ...data, apply });
    expect(data.jobs[0]?.completedAt).toBeNull(); expect(data.jobs[0]?.nextAttemptAt).toEqual(new Date(data.now.getTime() + 300_000));
    expect(data.jobs[1]?.completedAt).toEqual(data.now);
  });
  it('never applies a changed event, different account or unsupported API version', async () => {
    for (const mutate of [
      (event: Stripe.Event) => { event.id = 'changed'; },
      (event: Stripe.Event) => { event.account = 'acct_other'; },
      (event: Stripe.Event) => { event.api_version = '2020-01-01'; },
    ]) {
      const data = fixture(); const event = data.event('bound');
      data.list.mockResolvedValue({ data: [event], has_more: false });
      const changed = structuredClone(event); mutate(changed); data.remote.set(event.id, changed);
      const apply = vi.fn(async () => ({ duplicate: false }));
      await recoverCommercialStripeEvents({ ...data, apply });
      expect(apply).not.toHaveBeenCalled(); expect(data.jobs[0]?.completedAt).toBeNull();
    }
  });
});
