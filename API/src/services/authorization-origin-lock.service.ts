import type { PrismaClient } from '@prisma/client';

import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import type { ProductTeamPolicyPrisma } from './product-team-policy.service.js';
import { lockSignaturePolicyForDecision } from './signature-policy-lock.service.js';
import { lockAndAssertActiveClientTeamScope } from './team-scope.service.js';

type AuthorizationOriginPrisma = PrismaClient;

/**
 * Freeze every mutable input that can invalidate an authenticated signing/code continuation.
 * The order is global and shared with token issuance: product → user → team → signature.
 */
export async function lockAuthorizationOriginForDecision(
  params: {
    userId: string;
    domain: string;
    credentialEpoch: number;
    profile: 'CONFIG_JWT' | 'PUBLIC_OAUTH';
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: {
    prisma: AuthorizationOriginPrisma;
    afterAuthenticationEpochLock?: () => Promise<void>;
    crossProductPrisma?: AuthorizationOriginPrisma;
    policyPrisma?: ProductTeamPolicyPrisma;
  },
): Promise<void> {
  await lockProductTeamPolicyShared(deps.prisma);
  await lockAndAssertAuthenticationEpoch(
    {
      userId: params.userId,
      domain: params.domain,
      credentialEpoch: params.credentialEpoch,
    },
    { prisma: deps.prisma, afterLock: deps.afterAuthenticationEpochLock },
  );

  if (params.profile === 'CONFIG_JWT') {
    await lockAndAssertActiveClientTeamScope(
      {
        userId: params.userId,
        domain: params.domain,
        orgId: params.orgId,
        teamId: params.teamId,
      },
      {
        prisma: deps.prisma,
        crossProductPrisma: deps.crossProductPrisma ?? deps.prisma,
        policyPrisma: deps.policyPrisma ?? deps.prisma,
      },
    );
  }

  await lockSignaturePolicyForDecision(deps.prisma, params.domain);
}
