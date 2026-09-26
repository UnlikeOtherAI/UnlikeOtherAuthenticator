import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';

/**
 * Product-API bulkhead: a per-instance cap on how many product data-API requests
 * execute at once, so one product's burst can never hold every database connection
 * sign-in needs.
 *
 * On 2026-09-26 one product's server sent ~100 `GET /org/me` in a second. Each
 * request holds a pooled connection for its tenant transaction, the pools are capped
 * at 3 (app) + 2 (admin) per instance, and Cloud Run admits 80 requests per instance
 * — so the burst took every connection and every product's `/auth/*` login failed
 * with "Request failed". Sign-in is the one thing UOA must keep answering, so the
 * data APIs products call on their own request paths yield to it: excess requests
 * wait briefly in FIFO order, then get `503` + `Retry-After: 1` + `PRODUCT_API_BUSY`,
 * which products already treat as temporary.
 *
 * The slot is taken in `onRequest` — before the preHandlers whose own DB reads
 * (domain-hash auth, config verification) are part of the cost — and released exactly
 * once when the response finishes, the request errors, or the client goes away.
 */

// Prefixes product backends call on their users' request paths. Everything else is
// never limited: sign-in (`/auth`, `/oauth`, `/2fa`), onboarding (`/integrations`),
// operator paths (`/internal/admin`), billing and its Stripe webhook, discovery
// (`/`, `/api`, `/llm`, `/.well-known`, `/health`), the Auth/Admin windows and what
// they fetch while signing in (`/i18n/get`, `/teams/:teamId/avatar`).
const PRODUCT_API_PREFIXES = [
  '/org/',
  '/domain/',
  '/settings/',
  '/internal/org/',
  '/avatar/',
  '/email/',
];

export function isProductApiPath(pathname: string): boolean {
  return PRODUCT_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export type BulkheadOptions = {
  /** Requests allowed to execute at once. */
  maxConcurrency: number;
  /** Requests allowed to wait for a slot; arrivals beyond this are refused at once. */
  maxQueue: number;
  /** How long a queued request may wait before it is refused. */
  queueWaitMs: number;
};

export type BulkheadRefusal = 'queue_full' | 'timeout' | 'aborted';

export class BulkheadRefused extends Error {
  public readonly reason: BulkheadRefusal;

  public constructor(reason: BulkheadRefusal) {
    super(`product API slot not acquired: ${reason}`);
    this.reason = reason;
  }
}

export type Bulkhead = {
  /** Resolves with the slot's release function; rejects with `BulkheadRefused`. */
  acquire: (signal?: AbortSignal) => Promise<() => void>;
  stats: () => { active: number; queued: number };
};

type Waiter = {
  grant: (release: () => void) => void;
  refuse: (reason: BulkheadRefusal) => void;
};

export function createBulkhead(options: BulkheadOptions): Bulkhead {
  let active = 0;
  const queue: Waiter[] = [];

  // Each grant owns its own release, and a release is idempotent: releasing twice
  // must never open a phantom slot.
  const grant = (): (() => void) => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      queue.shift()?.grant(grant());
    };
  };

  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new BulkheadRefused('aborted'));
    if (active < options.maxConcurrency) return Promise.resolve(grant());
    if (queue.length >= options.maxQueue) return Promise.reject(new BulkheadRefused('queue_full'));

    return new Promise((resolve, reject) => {
      const onAbort = (): void => waiter.refuse('aborted');
      const timer = setTimeout(() => waiter.refuse('timeout'), options.queueWaitMs);
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        grant: (release) => {
          settle();
          resolve(release);
        },
        refuse: (reason) => {
          settle();
          const position = queue.indexOf(waiter);
          if (position !== -1) queue.splice(position, 1);
          reject(new BulkheadRefused(reason));
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  };

  return { acquire, stats: () => ({ active, queued: queue.length }) };
}

const RETRY_AFTER_SECONDS = '1';

const heldSlots = new WeakMap<FastifyRequest, () => void>();

function releaseSlot(request: FastifyRequest): void {
  const release = heldSlots.get(request);
  if (!release) return;
  heldSlots.delete(request);
  release();
}

function pathnameOf(request: FastifyRequest): string {
  const query = request.url.indexOf('?');
  return query === -1 ? request.url : request.url.slice(0, query);
}

export function registerProductApiBulkhead(
  app: FastifyInstance,
  options: BulkheadOptions,
): Bulkhead {
  const bulkhead = createBulkhead(options);

  app.addHook('onRequest', async (request, reply) => {
    if (!isProductApiPath(pathnameOf(request))) return;

    // A client that drops the connection while queued must not be handed a slot later.
    const clientGone = new AbortController();
    const onCloseWhileQueued = (): void => clientGone.abort();
    reply.raw.once('close', onCloseWhileQueued);

    let release: () => void;
    try {
      release = await bulkhead.acquire(clientGone.signal);
    } catch (error) {
      reply.raw.off('close', onCloseWhileQueued);
      if (!(error instanceof BulkheadRefused)) throw error;
      reply.header('Retry-After', RETRY_AFTER_SECONDS);
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'PRODUCT_API_BUSY');
    }
    reply.raw.off('close', onCloseWhileQueued);

    heldSlots.set(request, release);
    // `onResponse` releases on the normal and error paths; the raw 'close' covers a
    // client that disconnects mid-handler, which Fastify never reports as a response.
    reply.raw.once('close', () => releaseSlot(request));
  });

  app.addHook('onResponse', async (request) => releaseSlot(request));
  app.addHook('onRequestAbort', async (request) => releaseSlot(request));

  return bulkhead;
}
