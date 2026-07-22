import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { resolveTwoFaPolicy } from './twofactor-policy.service.js';

/** Recheck interactive 2FA proof against current user and exact-workspace policy. */
export async function assertAuthorizationTwoFaProof(
  params: {
    config: ClientConfig;
    userId: string;
    orgId?: string;
    twoFaCompleted: boolean;
  },
  deps: { prisma: PrismaClient },
): Promise<void> {
  const [policy, user] = await Promise.all([
    resolveTwoFaPolicy(
      { config: params.config, userId: params.userId, orgId: params.orgId },
      { prisma: deps.prisma },
    ),
    deps.prisma.user.findUnique({
      where: { id: params.userId },
      select: { twoFaEnabled: true },
    }),
  ]);
  const proofRequired = policy === 'REQUIRED' || (policy !== 'OFF' && user?.twoFaEnabled === true);
  if (!user || (proofRequired && !params.twoFaCompleted)) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_AUTH_CODE');
  }
}
