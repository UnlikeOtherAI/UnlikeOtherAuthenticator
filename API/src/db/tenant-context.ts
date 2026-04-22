import type { Prisma, PrismaClient } from '@prisma/client';

import { getPrisma } from './prisma.js';

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
