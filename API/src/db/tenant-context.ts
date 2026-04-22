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
