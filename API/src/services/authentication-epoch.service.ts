import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  lockRefreshSessionUser,
  lockRefreshSessionUserDomain,
} from './refresh-session-lock.service.js';

type AuthenticationEpochPrisma = Pick<PrismaClient, '$queryRaw' | 'user'>;

class AuthenticationEpochMismatchError extends AppError {
  public constructor() {
    super('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
}

export function isAuthenticationEpochMismatchError(
  error: unknown,
): error is AuthenticationEpochMismatchError {
  return error instanceof AuthenticationEpochMismatchError;
}

/**
 * Linearize a credential with global user revocation without inventing a domain scope.
 * Product-signed billing actors use this because their issuer is not an authentication domain.
 */
export async function lockAndAssertGlobalAuthenticationEpoch(
  params: {
    userId: string;
    credentialEpoch: number;
  },
  deps: {
    afterLock?: () => Promise<void>;
    fallbackTwoFaEnabled?: boolean;
    prisma: AuthenticationEpochPrisma;
  },
): Promise<{ tokenVersion: number; twoFaEnabled: boolean }> {
  if (
    !getEnv().DATABASE_URL &&
    typeof (deps.prisma as { user?: { findUnique?: unknown } }).user?.findUnique !== 'function'
  ) {
    return {
      tokenVersion: params.credentialEpoch,
      twoFaEnabled: deps.fallbackTwoFaEnabled ?? false,
    };
  }
  await lockRefreshSessionUser(params.userId, { prisma: deps.prisma });
  await deps.afterLock?.();

  const user = await deps.prisma.user.findUnique({
    where: { id: params.userId },
    select: { tokenVersion: true, twoFaEnabled: true },
  });
  if (!user || user.tokenVersion !== params.credentialEpoch) {
    throw new AuthenticationEpochMismatchError();
  }
  return user;
}

/**
 * Linearize a post-authentication continuation with global credential/session revocation.
 * Callers take this before any organisation, team, user-state, or signature-policy lock.
 */
export async function lockAndAssertAuthenticationEpoch(
  params: {
    userId: string;
    domain: string;
    credentialEpoch: number;
  },
  deps: {
    afterLock?: () => Promise<void>;
    fallbackTwoFaEnabled?: boolean;
    prisma: AuthenticationEpochPrisma;
  },
): Promise<{ tokenVersion: number; twoFaEnabled: boolean }> {
  if (
    !getEnv().DATABASE_URL &&
    typeof (deps.prisma as { user?: { findUnique?: unknown } }).user?.findUnique !== 'function'
  ) {
    return {
      tokenVersion: params.credentialEpoch,
      twoFaEnabled: deps.fallbackTwoFaEnabled ?? false,
    };
  }
  await lockRefreshSessionUserDomain(
    { userId: params.userId, domain: params.domain },
    { prisma: deps.prisma },
  );
  await deps.afterLock?.();

  const user = await deps.prisma.user.findUnique({
    where: { id: params.userId },
    select: { tokenVersion: true, twoFaEnabled: true },
  });
  if (!user || user.tokenVersion !== params.credentialEpoch) {
    throw new AuthenticationEpochMismatchError();
  }
  return user;
}
