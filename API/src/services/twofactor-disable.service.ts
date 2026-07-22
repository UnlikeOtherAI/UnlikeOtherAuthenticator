import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import type { ClientConfig } from './config.service.js';
import { lockProductWorkspacePolicyShared } from './product-workspace-policy-lock.service.js';
import { revokeAllRefreshTokensForUser } from './refresh-token-revocation.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';
import { resolveTwoFaPolicy } from './twofactor-policy.service.js';

type DisablePrisma = PrismaClient;

type DisableDeps = {
  afterRefreshSessionLock?: () => Promise<void>;
  beforeRefreshSessionLock?: () => Promise<void>;
  prisma?: DisablePrisma;
  revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
  verifyTwoFactorForLogin?: typeof verifyTwoFactorForLogin;
};

function adminPrisma(deps?: { prisma?: DisablePrisma }): DisablePrisma {
  return deps?.prisma ?? getAdminPrisma();
}

async function clearTwoFactor(userId: string, prisma: DisablePrisma): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: { id: userId, twoFaEnabled: true },
    data: {
      twoFaEnabled: false,
      twoFaSecret: null,
      twoFaLastAcceptedCounter: null,
    },
  });

  if (updated.count !== 1) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_DISABLE_FAILED');
  }
}

async function resetTwoFactor(userId: string, prisma: DisablePrisma): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: { id: userId },
    data: {
      twoFaEnabled: false,
      twoFaSecret: null,
      twoFaLastAcceptedCounter: null,
    },
  });

  if (updated.count !== 1) {
    throw new AppError('BAD_REQUEST', 400, 'TWOFA_RESET_FAILED');
  }
}

export async function disableTwoFactorForUser(
  params: {
    userId: string;
    code: string;
    credentialEpoch: number;
    config: Pick<ClientConfig, '2fa_enabled' | 'domain'>;
    /** Exact organisation selected by the access token, including cross-domain workspaces. */
    orgId?: string;
  },
  deps?: DisableDeps,
): Promise<void> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = adminPrisma(deps);
  await runInTransaction(prisma, async (tx) => {
    // Serialize the effective policy re-read with every domain/organisation
    // policy writer. This lock must precede the user/session hierarchy.
    await lockProductWorkspacePolicyShared(tx);
    await deps?.beforeRefreshSessionLock?.();
    await lockAndAssertAuthenticationEpoch(
      {
        userId: params.userId,
        domain: params.config.domain,
        credentialEpoch: params.credentialEpoch,
      },
      { prisma: tx, afterLock: deps?.afterRefreshSessionLock },
    );
    const policy = await resolveTwoFaPolicy(
      { config: params.config, userId: params.userId, orgId: params.orgId },
      { prisma: tx },
    );
    if (policy === 'OFF') throw new AppError('NOT_FOUND', 404, 'TWOFA_NOT_AVAILABLE');
    if (policy === 'REQUIRED') throw new AppError('BAD_REQUEST', 400, 'TWOFA_REQUIRED');
    await (deps?.verifyTwoFactorForLogin ?? verifyTwoFactorForLogin)(
      { userId: params.userId, code: params.code },
      { prisma: tx },
    );
    await clearTwoFactor(params.userId, tx);
    await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId, {
      prisma: tx,
    });
  });
}

export async function resetTwoFactorForUser(
  params: { userId: string },
  deps?: {
    afterRefreshSessionLock?: () => Promise<void>;
    beforeRefreshSessionLock?: () => Promise<void>;
    prisma?: DisablePrisma;
    revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
  },
): Promise<void> {
  if (!getEnv().DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = adminPrisma(deps);
  await runInTransaction(prisma, async (tx) => {
    await deps?.beforeRefreshSessionLock?.();
    await lockRefreshSessionUser(params.userId, { prisma: tx });
    await deps?.afterRefreshSessionLock?.();
    await resetTwoFactor(params.userId, tx);
    await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(params.userId, {
      prisma: tx,
    });
  });
}
