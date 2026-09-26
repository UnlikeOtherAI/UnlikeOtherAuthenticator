import { request as httpRequest, type ClientRequest } from 'node:http';

import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import {
  registerProductApiBulkhead,
  type Bulkhead,
  type BulkheadOptions,
} from '../../src/middleware/product-api-bulkhead.js';

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

/**
 * A request over a real socket. `app.inject` cannot model a client that goes
 * away — light-my-request treats an early `close` as a harness failure — so the
 * disconnect paths are driven by destroying a genuine connection, which fires the
 * server-side `ServerResponse 'close'` the bulkhead releases on.
 */
function openRequest(
  baseUrl: string,
  path: string,
): { req: ClientRequest; done: Promise<number | 'aborted'> } {
  const req = httpRequest(new URL(path, baseUrl), { method: 'GET' });
  const done = new Promise<number | 'aborted'>((resolve) => {
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve('aborted'));
    req.on('close', () => resolve('aborted'));
  });
  req.end();
  return { req, done };
}

const NEVER_LIMITED = [
  '/auth/ping',
  '/auth/token',
  '/oauth/ping',
  '/2fa/ping',
  '/integrations/ping',
  '/internal/admin/ping',
  '/billing/v1/stripe/webhook',
  '/.well-known/ping',
  '/health',
  '/api',
  '/llm',
  '/i18n/get',
  '/teams/t1/avatar',
];

/**
 * A bare Fastify app with the real error handler and bulkhead, plus routes under
 * the limited and never-limited prefixes. `/org/slow` parks each request on a
 * gate the test opens, so saturation is deterministic.
 */
async function buildApp(options: BulkheadOptions): Promise<{
  app: FastifyInstance;
  bulkhead: Bulkhead;
  gates: Gate[];
}> {
  const app = fastify();
  registerErrorHandler(app);
  const bulkhead = registerProductApiBulkhead(app, options);

  const gates: Gate[] = [];
  app.get('/org/slow', async () => {
    const parked = gate();
    gates.push(parked);
    await parked.promise;
    return { ok: true };
  });
  app.get('/org/fast', async () => ({ ok: true }));
  app.get('/org/error', async () => {
    throw new Error('boom');
  });
  for (const path of NEVER_LIMITED) app.get(path, async () => ({ ok: true }));
  await app.ready();
  return { app, bulkhead, gates };
}

function expectBusy(response: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }) {
  expect(response.statusCode).toBe(503);
  expect(response.headers['retry-after']).toBe('1');
  expect(response.json()).toMatchObject({ code: 'PRODUCT_API_BUSY' });
}

describe('product API bulkhead (Fastify)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('queues the excess, refuses beyond the queue, and never touches sign-in or operator paths', async () => {
    const built = await buildApp({ maxConcurrency: 1, maxQueue: 1, queueWaitMs: 5000 });
    app = built.app;

    const holding = app.inject({ method: 'GET', url: '/org/slow' });
    await until(() => built.gates.length === 1);
    const queued = app.inject({ method: 'GET', url: '/org/slow' });
    await until(() => built.bulkhead.stats().queued === 1);

    expectBusy(await app.inject({ method: 'GET', url: '/org/fast' }));
    expectBusy(await app.inject({ method: 'GET', url: '/settings/me' }));

    for (const path of NEVER_LIMITED) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(200);
    }

    built.gates[0].open();
    expect((await holding).statusCode).toBe(200);
    await until(() => built.gates.length === 2);
    built.gates[1].open();
    expect((await queued).statusCode).toBe(200);

    expect(built.bulkhead.stats()).toEqual({ active: 0, queued: 0 });
    expect((await app.inject({ method: 'GET', url: '/org/fast' })).statusCode).toBe(200);
  });

  it('refuses a queued request once the wait budget is spent', async () => {
    const built = await buildApp({ maxConcurrency: 1, maxQueue: 4, queueWaitMs: 30 });
    app = built.app;

    const holding = app.inject({ method: 'GET', url: '/org/slow' });
    await until(() => built.gates.length === 1);

    expectBusy(await app.inject({ method: 'GET', url: '/org/fast' }));
    expect(built.bulkhead.stats()).toEqual({ active: 1, queued: 0 });

    built.gates[0].open();
    expect((await holding).statusCode).toBe(200);
  });

  it('releases the slot when the handler fails', async () => {
    const built = await buildApp({ maxConcurrency: 1, maxQueue: 0, queueWaitMs: 1000 });
    app = built.app;

    expect((await app.inject({ method: 'GET', url: '/org/error' })).statusCode).toBe(500);
    expect(built.bulkhead.stats()).toEqual({ active: 0, queued: 0 });
    expect((await app.inject({ method: 'GET', url: '/org/fast' })).statusCode).toBe(200);
  });

  it('drops a queued request whose client disconnected instead of handing it a slot', async () => {
    const built = await buildApp({ maxConcurrency: 1, maxQueue: 4, queueWaitMs: 5000 });
    app = built.app;
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const holding = app.inject({ method: 'GET', url: '/org/slow' });
    await until(() => built.gates.length === 1);
    const abandoned = openRequest(baseUrl, '/org/fast');
    await until(() => built.bulkhead.stats().queued === 1);

    abandoned.req.destroy();
    await until(() => built.bulkhead.stats().queued === 0);
    expect(built.bulkhead.stats()).toEqual({ active: 1, queued: 0 });
    expect(await abandoned.done).toBe('aborted');

    built.gates[0].open();
    expect((await holding).statusCode).toBe(200);
    expect(built.bulkhead.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('releases the slot exactly once when the client disconnects mid-handler', async () => {
    const built = await buildApp({ maxConcurrency: 1, maxQueue: 0, queueWaitMs: 1000 });
    app = built.app;
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const holding = openRequest(baseUrl, '/org/slow');
    await until(() => built.gates.length === 1);
    expectBusy(await app.inject({ method: 'GET', url: '/org/fast' }));

    holding.req.destroy();
    await until(() => built.bulkhead.stats().active === 0);
    expect((await app.inject({ method: 'GET', url: '/org/fast' })).statusCode).toBe(200);

    built.gates[0].open();
    expect(await holding.done).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Completing the abandoned handler must not release a second time: with one
    // slot and no queue, a phantom slot would let the second acquire through.
    expect(built.bulkhead.stats()).toEqual({ active: 0, queued: 0 });
    const occupied = await built.bulkhead.acquire();
    await expect(built.bulkhead.acquire()).rejects.toMatchObject({ reason: 'queue_full' });
    occupied();
  });
});

describe('product API bulkhead (createApp wiring)', () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    PRODUCT_API_MAX_CONCURRENCY: process.env.PRODUCT_API_MAX_CONCURRENCY,
    PRODUCT_API_MAX_QUEUE: process.env.PRODUCT_API_MAX_QUEUE,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('applies the env-configured cap to real product routes and leaves /auth/* untouched', async () => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    process.env.PRODUCT_API_MAX_CONCURRENCY = '1';
    process.env.PRODUCT_API_MAX_QUEUE = '0';

    const app = await createApp();
    const parked = gate();
    let parkedRequests = 0;
    app.get('/org/__bulkhead-slow', async () => {
      parkedRequests += 1;
      await parked.promise;
      return { ok: true };
    });
    app.get('/auth/__bulkhead-fast', async () => ({ ok: true }));
    await app.ready();
    try {
      const holding = app.inject({ method: 'GET', url: '/org/__bulkhead-slow' });
      await until(() => parkedRequests === 1);

      // A real product route is refused before any preHandler runs...
      expectBusy(await app.inject({ method: 'GET', url: '/org/me?config_url=https://x.example.com/c' }));
      // ...while the sign-in surface still answers.
      expect((await app.inject({ method: 'GET', url: '/auth/__bulkhead-fast' })).statusCode).toBe(200);

      parked.open();
      expect((await holding).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
