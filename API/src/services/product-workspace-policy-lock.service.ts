import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

type ProductPolicyLockPrisma = Pick<PrismaClient, '$queryRaw'>;
type ProductPolicyReadPrisma = Pick<PrismaClient, '$queryRaw' | 'clientDomain'>;

const PRODUCT_WORKSPACE_POLICY_LOCK = 'uoa:product-workspace-policy:v1';

/** Concurrent auth readers hold this through their token transaction commit. */
export async function lockProductWorkspacePolicyShared(
  prisma: ProductPolicyLockPrisma,
): Promise<void> {
  await prisma.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock_shared(
        hashtextextended(${PRODUCT_WORKSPACE_POLICY_LOCK}, 0)
      )::text AS "lockResult"
    `,
  );
}

/** Every supported policy mutator holds this before reading or writing policy rows. */
export async function lockProductWorkspacePolicyExclusive(
  prisma: ProductPolicyLockPrisma,
): Promise<void> {
  await prisma.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${PRODUCT_WORKSPACE_POLICY_LOCK}, 0)
      )::text AS "lockResult"
    `,
  );
}

/**
 * Bind token issuance to the exact ClientDomain credential authenticated by
 * the route pre-handler. The route check and this re-read deliberately happen
 * on opposite sides of the shared policy lock: a domain disable that wins the
 * race is observed here, while one that loses waits for issuance to commit.
 */
export async function lockTokenIssuanceProductPolicy(
  params: { clientDomainId?: string; domain: string },
  deps: {
    prisma: ProductPolicyReadPrisma;
    afterLock?: () => Promise<void>;
  },
): Promise<void> {
  await lockProductWorkspacePolicyShared(deps.prisma);
  if (!params.clientDomainId) {
    await deps.afterLock?.();
    return;
  }
  const row = await deps.prisma.clientDomain.findUnique({
    where: { id: params.clientDomainId },
    select: { domain: true, status: true },
  });
  if (
    !row ||
    row.status !== 'active' ||
    normalizeDomain(row.domain) !== normalizeDomain(params.domain)
  ) {
    throw new AppError('UNAUTHORIZED', 401);
  }
  await deps.afterLock?.();
}
