import { describe, expect, it } from 'vitest';

import { BulkheadRefused, createBulkhead, isProductApiPath } from '../product-api-bulkhead.js';

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'granted';
  } catch (error) {
    if (error instanceof BulkheadRefused) return error.reason;
    throw error;
  }
}

/** Which of several pending acquires have settled, in a stable order, after a tick. */
async function settledOrder(promises: Promise<unknown>[]): Promise<number[]> {
  const settled: number[] = [];
  promises.forEach((promise, index) => {
    void promise.then(() => settled.push(index));
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe('createBulkhead', () => {
  it('grants slots up to the cap and queues the rest in FIFO order', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 5, queueWaitMs: 1000 });

    const first = await bulkhead.acquire();
    const second = bulkhead.acquire();
    const third = bulkhead.acquire();
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 2 });

    expect(await settledOrder([second, third])).toEqual([]);
    first();
    expect(await settledOrder([second, third])).toEqual([0]);
    (await second)();
    expect(await settledOrder([second, third])).toEqual([0, 1]);
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 0 });
  });

  it('refuses a queued request once the wait budget is spent and drops it from the queue', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 5, queueWaitMs: 20 });
    const release = await bulkhead.acquire();

    expect(await refusal(bulkhead.acquire())).toBe('timeout');
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 0 });

    release();
    expect(await refusal(bulkhead.acquire())).toBe('granted');
  });

  it('refuses immediately when the queue is full', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 1, queueWaitMs: 1000 });
    const release = await bulkhead.acquire();
    const queued = bulkhead.acquire();

    expect(await refusal(bulkhead.acquire())).toBe('queue_full');
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 1 });

    release();
    (await queued)();
  });

  it('refuses a queued request whose client went away and gives its place to the next', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 5, queueWaitMs: 1000 });
    const release = await bulkhead.acquire();
    const gone = new AbortController();
    const abandoned = bulkhead.acquire(gone.signal);
    const patient = bulkhead.acquire();

    gone.abort();
    expect(await refusal(abandoned)).toBe('aborted');
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 1 });

    release();
    (await patient)();
    expect(bulkhead.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('refuses an already-aborted acquire without touching the queue', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 5, queueWaitMs: 1000 });
    const gone = new AbortController();
    gone.abort();

    expect(await refusal(bulkhead.acquire(gone.signal))).toBe('aborted');
    expect(bulkhead.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('ignores a second release of the same slot', async () => {
    const bulkhead = createBulkhead({ maxConcurrency: 1, maxQueue: 5, queueWaitMs: 1000 });
    const release = await bulkhead.acquire();

    release();
    release();
    expect(bulkhead.stats()).toEqual({ active: 0, queued: 0 });

    // Exactly one slot exists again — a phantom slot would let both proceed.
    await bulkhead.acquire();
    const second = bulkhead.acquire();
    expect(await settledOrder([second])).toEqual([]);
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 1 });
  });
});

describe('isProductApiPath', () => {
  it.each([
    '/org/me',
    '/org/organisations/o1/teams/t1/members',
    '/domain/users',
    '/domain/teams/t1/avatar',
    '/settings/me/ns/key',
    '/internal/org/organisations/o1/groups',
    '/avatar/me',
    '/email/send',
  ])('limits %s', (path) => {
    expect(isProductApiPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/api',
    '/llm',
    '/health',
    '/.well-known/jwks.json',
    '/auth',
    '/auth/login',
    '/auth/token',
    '/oauth/token',
    '/oauth/me',
    '/2fa/verify',
    '/integrations/claim/abc',
    '/internal/admin/users',
    '/billing/v1/stripe/webhook',
    '/billing/v1/effective-tariff',
    '/i18n/get',
    '/teams/t1/avatar',
    '/admin/assets/app.js',
    '/assets/index.css',
    '/signatures/session',
    '/apps/startup',
    '/config/verify',
    '/schemas/billing-credits-v1.json',
  ])('never limits %s', (path) => {
    expect(isProductApiPath(path)).toBe(false);
  });
});
