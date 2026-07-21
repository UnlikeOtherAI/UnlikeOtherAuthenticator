import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { lockSignaturePolicyForDecision } from './signature-continuation.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import { lockAndAssertRefreshWorkspaceScope } from './workspace-scope.service.js';

type RefreshRotationRow = {
  userId: string;
  domain: string;
  orgId: string | null;
  teamId: string | null;
};

/** Build the policy gate that runs after opaque-token validation and before any rotation write. */
export function createRefreshTokenRotationPolicyGuard(params: {
  prisma: PrismaClient;
  now?: () => Date;
  afterWorkspaceLock?: () => Promise<void>;
}): (row: RefreshRotationRow) => Promise<void> {
  return async ({ userId, domain, orgId, teamId }) => {
    // Lifecycle writers take the same org-then-team locks before tombstone + revocation.
    await lockAndAssertRefreshWorkspaceScope(
      { userId, domain, orgId, teamId },
      { crossProductPrisma: params.prisma, policyPrisma: params.prisma, prisma: params.prisma },
    );
    await params.afterWorkspaceLock?.();

    await lockSignaturePolicyForDecision(params.prisma, domain);
    const policy = await evaluateSignaturePolicy(
      { domain, userId, now: params.now?.() },
      { prisma: params.prisma },
    );
    if (!policy.complete) {
      // Keep this indistinguishable from the normal invalid-grant response.
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
    }
  };
}
