import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockSignaturePolicyForDecision } from './signature-policy-lock.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import { isTwoFaAuthenticationSufficient, resolveTwoFaPolicy } from './twofactor-policy.service.js';
import { lockAndAssertRefreshTeamScope } from './team-scope.service.js';

type RefreshRotationRow = {
  userId: string;
  domain: string;
  orgId: string | null;
  teamId: string | null;
  twoFaCompleted: boolean;
};

/** Acquire the user-global then user/domain hierarchy shared by every refresh revocation path. */
export function createRefreshTokenFamilyDecisionLock(params: {
  prisma: PrismaClient;
  afterLock?: () => Promise<void>;
}): (row: RefreshRotationRow) => Promise<void> {
  return async ({ userId, domain }) => {
    await lockRefreshSessionUserDomain({ userId, domain }, { prisma: params.prisma });
    await params.afterLock?.();
  };
}

/** Build the policy gate that runs after opaque-token validation and before any rotation write. */
export function createRefreshTokenRotationPolicyGuard(params: {
  prisma: PrismaClient;
  now?: () => Date;
  afterTeamLock?: () => Promise<void>;
  targetTeam?: { orgId: string; teamId: string };
  targetTeamError?: 'TEAM_NOT_AVAILABLE';
  validateSource?: boolean;
  twoFa?: {
    config: Parameters<typeof resolveTwoFaPolicy>[0]['config'];
    error: 'INTERACTION_REQUIRED';
  };
}): (row: RefreshRotationRow) => Promise<void> {
  return async ({ userId, domain, orgId, teamId, twoFaCompleted }) => {
    // Lifecycle writers take the same org-then-team locks before tombstone + revocation.
    if (params.validateSource !== false) {
      await lockAndAssertRefreshTeamScope(
        { userId, domain, orgId, teamId },
        { crossProductPrisma: params.prisma, policyPrisma: params.prisma, prisma: params.prisma },
      );
    }
    if (params.targetTeam) {
      try {
        await lockAndAssertRefreshTeamScope(
          { userId, domain, ...params.targetTeam },
          {
            crossProductPrisma: params.prisma,
            policyPrisma: params.prisma,
            prisma: params.prisma,
          },
        );
      } catch (error) {
        if (params.targetTeamError && error instanceof AppError && error.statusCode === 401) {
          throw new AppError('FORBIDDEN', 403, params.targetTeamError);
        }
        throw error;
      }
    }
    await params.afterTeamLock?.();

    if (params.twoFa) {
      const [policy, user] = await Promise.all([
        resolveTwoFaPolicy(
          {
            config: params.twoFa.config,
            userId,
            orgId: params.targetTeam?.orgId ?? orgId,
          },
          { prisma: params.prisma },
        ),
        params.prisma.user.findUnique({
          where: { id: userId },
          select: { twoFaEnabled: true },
        }),
      ]);
      if (!user) throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
      if (
        !isTwoFaAuthenticationSufficient({
          policy,
          twoFaEnabled: user.twoFaEnabled,
          twoFaCompleted,
        })
      ) {
        throw new AppError('FORBIDDEN', 403, params.twoFa.error);
      }
    }

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
