import type { Prisma, PrismaClient } from '@prisma/client';

import { getPrisma } from './prisma.js';

/**
 * Cast a transaction client to `PrismaClient` for service `deps.prisma` call sites.
 *
 * Services in this codebase type `deps.prisma` as a narrow `Pick<PrismaClient, ...>`
 * subset. `Prisma.TransactionClient` satisfies that subset at runtime (the model
 * accessors are identical), but TypeScript needs an explicit bridge because
 * `TransactionClient` excludes `$transaction`, `$connect`, etc. This helper names
 * the cast so it reads intentionally instead of scattering `as unknown as PrismaClient`
 * across every route.
 */
export function asPrismaClient(tx: Prisma.TransactionClient): PrismaClient {
  return tx as unknown as PrismaClient;
}

/**
 * Transaction-aware runner. Services take `deps.prisma` that may be either a full `PrismaClient`
 * (standalone / unit-test calls) OR a `Prisma.TransactionClient` handed down by
 * `runWithTenantContext` (every `/org/*` route runs inside that outer transaction for RLS).
 *
 * A `TransactionClient` does NOT expose `$transaction` (Prisma has no nested interactive
 * transactions), so a service that calls `prisma.$transaction(...)` on it throws
 * `prisma.$transaction is not a function` at runtime. This helper bridges both cases:
 *   - full client  → open a real interactive transaction and run the body inside it;
 *   - tx client    → we are already inside the tenant transaction, so run the body directly
 *                    (its statements already share that transaction and its RLS GUCs).
 *
 * Services should call `runInTransaction(prisma, (tx) => ...)` instead of `prisma.$transaction(...)`.
 */
export function runInTransaction<T>(
  client: PrismaClient,
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  const maybeTx = client as { $transaction?: unknown };
  if (typeof maybeTx.$transaction === 'function') {
    return client.$transaction((tx) => body(tx as unknown as PrismaClient));
  }
  // Already inside an interactive transaction (tenant-context tx client): run directly.
  return body(client);
}

// Tenant context threaded from `config-verifier`, access-token verification,
// and org resolution into the per-request transaction. Values become Postgres
// session settings that RLS policies key off; see `Docs/Requirements/row-level-security.md`.
export type TenantContext = {
  domain: string;
  orgId?: string | null;
  userId?: string | null;
};

export type RunWithTenantContextDeps = {
  prisma?: PrismaClient;
};

/**
 * Run `handler` inside a single interactive transaction on the tenant-scoped
 * Prisma client (`uoa_app` under RLS) with `app.domain`, `app.org_id`, and
 * `app.user_id` set for the lifetime of the transaction.
 *
 * The settings are applied with `set_config(..., true)`, so they are scoped to
 * the transaction and safe under any pooling mode. Nested `prisma.$transaction`
 * inside services becomes a savepoint on this outer transaction and inherits
 * the session settings.
 */
export async function runWithTenantContext<T>(
  params: { context: TenantContext } & RunWithTenantContextDeps,
  handler: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const prisma = params.prisma ?? getPrisma();
  const domain = params.context.domain;
  const orgId = params.context.orgId ?? '';
  const userId = params.context.userId ?? '';

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.domain', ${domain}, true),
      set_config('app.org_id', ${orgId}, true),
      set_config('app.user_id', ${userId}, true)`;
    return handler(tx);
  });
}
