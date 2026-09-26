import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Same-pool nested checkout guard for the two global Prisma clients.
 *
 * Production caps each Cloud Run instance's pools at a handful of connections
 * (`DATABASE_ADMIN_URL` connection_limit=2, `DATABASE_URL` connection_limit=3). An
 * interactive `$transaction(fn)` holds one of them for its whole lifetime. If code
 * running inside `fn` reaches for the GLOBAL client of the same pool instead of the
 * `tx` client it was handed, Prisma checks out a SECOND connection from that pool.
 * Under concurrent load that second checkout waits on a connection its own
 * transaction owns until the 5 s interactive-transaction timeout (P2028) — which is
 * how Google sign-in to every product failed on 2026-09-26.
 *
 * `guardPoolCheckouts` wraps a global client in a Proxy that records every interactive
 * transaction it opens in AsyncLocalStorage, and flags any connection-checking-out use
 * of the global client (model delegates, `$queryRaw*`, `$executeRaw*`, `$transaction`)
 * while an ACTIVE transaction on the same pool is in the current async context.
 * Cross-pool use — the admin client inside an app-pool tenant transaction — is
 * legitimate and never flagged. Everything else on the client (`$connect`, `$on`,
 * `$extends`, internals, symbols) passes through untouched.
 *
 * Under `NODE_ENV=test` a violation throws so the suite catches the regression;
 * anywhere else it is logged once per call site and the call proceeds — the guard
 * itself must never break a production login.
 */
export type PoolName = 'app' | 'admin';

type TransactionMarker = {
  readonly pool: PoolName;
  /** Cleared when the transaction settles, so detached work that outlives it is not flagged. */
  active: boolean;
};

// A stack, not a single marker: a cross-pool transaction opened inside another (an app-pool
// tenant transaction inside an admin one) must not hide the outer pool's marker.
const activeTransactions = new AsyncLocalStorage<readonly TransactionMarker[]>();

const RAW_AND_TRANSACTION_METHODS = new Set([
  '$transaction',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

// `Prisma.ModelName` is the generated client's own list; delegates are its lowerCamelCase form.
const MODEL_DELEGATES = new Set(
  Object.keys(Prisma.ModelName).map((name) => name.charAt(0).toLowerCase() + name.slice(1)),
);

function checksOutConnection(prop: string): boolean {
  return RAW_AND_TRANSACTION_METHODS.has(prop) || MODEL_DELEGATES.has(prop);
}

export function guardPoolCheckouts(client: PrismaClient, pool: PoolName): PrismaClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop !== 'string' || !checksOutConnection(prop)) return value;

      reportNestedCheckout(pool, prop);

      if (prop === '$transaction') return trackedTransaction(target, pool);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

type AnyTransaction = (...args: unknown[]) => Promise<unknown>;

function trackedTransaction(client: PrismaClient, pool: PoolName): PrismaClient['$transaction'] {
  const raw = client.$transaction as AnyTransaction;

  const transaction: AnyTransaction = (first, ...rest) => {
    // Batch form `$transaction([...])` runs no caller code while it holds the connection.
    if (typeof first !== 'function') return raw.call(client, first, ...rest);

    const fn = first as (tx: Prisma.TransactionClient) => Promise<unknown>;
    return raw.call(
      client,
      async (tx: Prisma.TransactionClient) => {
        const marker: TransactionMarker = { pool, active: true };
        const enclosing = activeTransactions.getStore() ?? [];
        try {
          return await activeTransactions.run([...enclosing, marker], () => fn(tx));
        } finally {
          marker.active = false;
        }
      },
      ...rest,
    );
  };

  return transaction as unknown as PrismaClient['$transaction'];
}

function reportNestedCheckout(pool: PoolName, prop: string): void {
  const nested = activeTransactions
    .getStore()
    ?.some((marker) => marker.active && marker.pool === pool);
  if (!nested) return;

  const message =
    `Nested ${pool}-pool checkout: "${prop}" was used on the global ${pool} Prisma client ` +
    `inside an interactive transaction on the same pool. That transaction already holds this ` +
    `pool's connection, so a second checkout starves the pool — use the transaction client instead.`;

  if (process.env.NODE_ENV === 'test') throw new Error(message);
  logOncePerCallSite(message);
}

const reportedCallSites = new Set<string>();

function logOncePerCallSite(message: string): void {
  const callSite = firstCallerFrame();
  if (reportedCallSites.has(callSite)) return;
  reportedCallSites.add(callSite);

  console.error('[db:pool-checkout]', message, { callSite });
}

function firstCallerFrame(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const caller = frames.find(
    (frame) => !frame.includes('pool-checkout-guard') && !frame.includes('node:internal'),
  );
  return (caller ?? frames[0] ?? 'unknown call site').trim();
}
