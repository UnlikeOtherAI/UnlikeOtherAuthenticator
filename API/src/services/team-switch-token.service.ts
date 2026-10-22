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
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { resolveAccessTokenTtl } from './token-session-ttl.service.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import { resolveTokenFamilyAssurance } from './token-assurance.service.js';
import { withSessionAssurance } from './session-assurance.service.js';
import {
  issueTokenPairForUser,
  type IssuedTokenPair,
  type TokenIssuerDeps,
} from './token.service.js';

export const TEAM_SWITCH_GRANT_TYPE =
  'urn:unlikeotherai:params:oauth:grant-type:team-switch';

type TeamSwitchDeps = TokenIssuerDeps & {
  issueTokenPairForUser?: typeof issueTokenPairForUser;
};

/** Rotate one live refresh family onto an exact, currently authorized team. */
export async function exchangeTeamSwitchForTokens(
  params: {
    authenticatedClientDomainId: string;
    clientId: string;
    config: ClientConfig;
    configUrl: string;
    organizationId: string;
    refreshToken: string;
    teamId: string;
  },
  deps?: TeamSwitchDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const prisma = deps?.prisma ?? getPrisma();
  const adminPrisma = deps?.adminPrisma ?? prisma;
  const targetTeam = { orgId: params.organizationId, teamId: params.teamId };

  return runRefreshTokenExchangeTransaction(adminPrisma, async (tx: PrismaClient) => {
    await lockTokenIssuanceProductPolicy(
      { clientDomainId: params.authenticatedClientDomainId, domain: params.config.domain },
      { prisma: tx, afterLock: deps?.afterProductTeamPolicyLock },
    );

    const policyParams = {
      prisma: tx,
      now: deps?.now,
      targetTeam,
      targetTeamError: 'TEAM_NOT_AVAILABLE' as const,
      twoFa: { config: params.config, error: 'INTERACTION_REQUIRED' as const },
    };
    const rotationPolicy = createRefreshTokenRotationPolicyGuard({
      ...policyParams, afterTeamLock: deps?.afterActiveTeamLock,
    });
    const rotated = await exchangeRefreshToken(
      {
        refreshToken: params.refreshToken,
        domain: params.config.domain,
        clientId: params.clientId,
        configUrl: params.configUrl,
        team: targetTeam,
      },
      {
        now: deps?.now,
        prisma: tx,
        sharedSecret,
        beforeFamilyDecision: createRefreshTokenFamilyDecisionLock({
          prisma: tx,
          afterLock: deps?.afterRefreshSessionLock,
        }),
        beforeRotate: async row => {
          // This hook runs after exact opaque-source validation under the family lock.
          // A bound original cannot be moved onto another scope by refresh rotation.
          const source = await tx.refreshToken.findUniqueOrThrow({ where: {
            tokenHash: hashRefreshToken(params.refreshToken, sharedSecret),
          } });
          if (!source.assuranceId) return rotationPolicy(row);
          const user = await tx.user.findUnique({ where: { id: row.userId, lifecycleStatus: 'ACTIVE' },
            select: { tokenVersion: true } });
          if (!user) throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
          try {
            await resolveTokenFamilyAssurance({ prisma: tx, userId: row.userId, domain: row.domain,
              refreshToken: params.refreshToken, sharedSecret, credentialEpoch: user.tokenVersion });
          } catch (error) {
            if (error instanceof AppError && [401, 403].includes(error.statusCode)) {
              throw new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');
            }
            throw error;
          }
          const proof = await tx.sessionAssurance.findUniqueOrThrow({ where: { id: source.assuranceId } });
          try { await withSessionAssurance(proof, () => rotationPolicy(row)); }
          catch (error) {
            if (error instanceof AppError && error.message === 'SSO_TEAM_REAUTH_REQUIRED') {
              throw new AppError('FORBIDDEN', 403, 'INTERACTION_REQUIRED');
            }
            throw error;
          }
          // The existing product recovery path starts normal target-bound authorization.
          // Refuse before any edge commits, preserving every original holder and deadline.
          throw new AppError('FORBIDDEN', 403, 'INTERACTION_REQUIRED');
        },
        beforeReplay: createRefreshTokenRotationPolicyGuard({
          ...policyParams,
          validateSource: false,
        }),
      },
    );

    if (rotated.orgId !== targetTeam.orgId || rotated.teamId !== targetTeam.teamId) {
      throw new AppError('BAD_REQUEST', 409, 'TEAM_SWITCH_CONFLICT');
    }

    return (deps?.issueTokenPairForUser ?? issueTokenPairForUser)(
      {
        userId: rotated.userId,
        config: params.config,
        configUrl: params.configUrl,
        clientId: params.clientId,
        refreshToken: rotated.refreshToken,
        refreshTokenExpiresInSeconds: rotated.expiresInSeconds,
        active: targetTeam,
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
