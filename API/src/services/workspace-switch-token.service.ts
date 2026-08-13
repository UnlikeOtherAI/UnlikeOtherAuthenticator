import type { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import {
  createRefreshTokenFamilyDecisionLock,
  createRefreshTokenRotationPolicyGuard,
} from './refresh-token-rotation-policy.service.js';
import { exchangeRefreshToken } from './refresh-token.service.js';
import { runRefreshTokenExchangeTransaction } from './refresh-token-transaction.service.js';
import { lockTokenIssuanceProductPolicy } from './product-workspace-policy-lock.service.js';
import { resolveAccessTokenTtl } from './token-session-ttl.service.js';
import {
  issueTokenPairForUser,
  type IssuedTokenPair,
  type TokenIssuerDeps,
} from './token.service.js';

export const WORKSPACE_SWITCH_GRANT_TYPE =
  'urn:unlikeotherai:params:oauth:grant-type:workspace-switch';

type WorkspaceSwitchDeps = TokenIssuerDeps & {
  issueTokenPairForUser?: typeof issueTokenPairForUser;
};

/** Rotate one live refresh family onto an exact, currently authorized workspace. */
export async function exchangeWorkspaceSwitchForTokens(
  params: {
    authenticatedClientDomainId: string;
    clientId: string;
    config: ClientConfig;
    configUrl: string;
    organizationId: string;
    refreshToken: string;
    teamId: string;
  },
  deps?: WorkspaceSwitchDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const prisma = deps?.prisma ?? getPrisma();
  const adminPrisma = deps?.adminPrisma ?? prisma;
  const targetWorkspace = { orgId: params.organizationId, teamId: params.teamId };

  return runRefreshTokenExchangeTransaction(adminPrisma, async (tx: PrismaClient) => {
    await lockTokenIssuanceProductPolicy(
      { clientDomainId: params.authenticatedClientDomainId, domain: params.config.domain },
      { prisma: tx, afterLock: deps?.afterProductWorkspacePolicyLock },
    );

    const policyParams = {
      prisma: tx,
      now: deps?.now,
      targetWorkspace,
      targetWorkspaceError: 'WORKSPACE_NOT_AVAILABLE' as const,
      twoFa: { config: params.config, error: 'INTERACTION_REQUIRED' as const },
    };
    const rotated = await exchangeRefreshToken(
      {
        refreshToken: params.refreshToken,
        domain: params.config.domain,
        clientId: params.clientId,
        configUrl: params.configUrl,
        workspace: targetWorkspace,
      },
      {
        now: deps?.now,
        prisma: tx,
        sharedSecret,
        beforeFamilyDecision: createRefreshTokenFamilyDecisionLock({
          prisma: tx,
          afterLock: deps?.afterRefreshSessionLock,
        }),
        beforeRotate: createRefreshTokenRotationPolicyGuard({
          ...policyParams,
          afterWorkspaceLock: deps?.afterActiveWorkspaceLock,
        }),
        beforeReplay: createRefreshTokenRotationPolicyGuard({
          ...policyParams,
          validateSource: false,
        }),
      },
    );

    if (rotated.orgId !== targetWorkspace.orgId || rotated.teamId !== targetWorkspace.teamId) {
      throw new AppError('BAD_REQUEST', 409, 'WORKSPACE_SWITCH_CONFLICT');
    }

    return (deps?.issueTokenPairForUser ?? issueTokenPairForUser)(
      {
        userId: rotated.userId,
        config: params.config,
        configUrl: params.configUrl,
        clientId: params.clientId,
        refreshToken: rotated.refreshToken,
        refreshTokenExpiresInSeconds: rotated.expiresInSeconds,
        active: targetWorkspace,
      },
      {
        ...deps,
        prisma: tx,
        adminPrisma: tx,
        accessTokenTtl: resolveAccessTokenTtl(params.config, env.ACCESS_TOKEN_TTL),
      },
    );
  });
}
