import type { PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import {
  createRefreshTokenFamilyDecisionLock,
  createRefreshTokenRotationPolicyGuard,
} from './refresh-token-rotation-policy.service.js';
import { issueRefreshToken } from './refresh-token.service.js';
import { runRefreshTokenExchangeTransaction } from './refresh-token-transaction.service.js';
import {
  derivesTeamSessionProof,
  issueDerivedSessionAssurance,
  validateSessionAssurance,
  withSessionAssurance,
} from './session-assurance.service.js';
import { resolveAccessTokenTtl } from './token-session-ttl.service.js';
import { issueTokenPairForUser, type IssuedTokenPair, type TokenIssuerDeps } from './token.service.js';

export const TEAM_SESSION_GRANT_TYPE =
  'urn:unlikeotherai:params:oauth:grant-type:team-session';

/** A derived session shorter than this is not worth issuing; the person signs in again instead. */
const MIN_TEAM_SESSION_SECONDS = 5 * 60;

type TeamSessionDeps = TokenIssuerDeps & {
  issueTokenPairForUser?: typeof issueTokenPairForUser;
};

const interactionRequired = (): AppError => new AppError('FORBIDDEN', 403, 'INTERACTION_REQUIRED');
const invalidRefreshToken = (): AppError => new AppError('UNAUTHORIZED', 401, 'INVALID_REFRESH_TOKEN');

/**
 * Issue a separate session for another team of the same person from the sign-in they already
 * hold, with no browser round trip. The presented refresh token is validated and left untouched:
 * its family, proof and every holder of them stay exactly as they were, so the product can return
 * to it. The new family carries a proof derived from the original sign-in (same method, evidence
 * and absolute deadline; never later), and only when the target team's current rules accept that
 * original: membership, product team policy, two-factor and the organisation's sign-in policy.
 * Anything the original cannot satisfy is `403 INTERACTION_REQUIRED` (sign in for that team);
 * a source that is no longer a live sign-in is `401 INVALID_REFRESH_TOKEN`.
 */
export async function exchangeTeamSessionForTokens(
  params: {
    authenticatedClientDomainId: string;
    clientId: string;
    config: ClientConfig;
    configUrl: string;
    organizationId: string;
    refreshToken: string;
    teamId: string;
  },
  deps?: TeamSessionDeps,
): Promise<IssuedTokenPair> {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const adminPrisma = deps?.adminPrisma ?? deps?.prisma ?? getPrisma();
  const target = { orgId: params.organizationId, teamId: params.teamId };

  return runRefreshTokenExchangeTransaction(adminPrisma, async (tx: PrismaClient) => {
    await lockTokenIssuanceProductPolicy(
      { clientDomainId: params.authenticatedClientDomainId, domain: params.config.domain },
      { prisma: tx },
    );
    const now = deps?.now?.() ?? new Date();
    const source = await tx.refreshToken.findUnique({ where: {
      tokenHash: hashRefreshToken(params.refreshToken, sharedSecret),
    } });
    if (!source || source.domain !== params.config.domain || source.clientId !== params.clientId
      || source.revokedAt || source.securityRevokedAt || source.replacedByTokenId
      || source.expiresAt <= now) {
      throw invalidRefreshToken();
    }
    // A proof-free legacy family keeps the team-switch grant; this grant only carries proof.
    if (!source.assuranceId) throw interactionRequired();
    // The source already is that team's session: there is nothing to issue.
    if (source.orgId === target.orgId && source.teamId === target.teamId) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_REQUEST');
    }
    await createRefreshTokenFamilyDecisionLock({ prisma: tx })(source);
    const user = await tx.user.findUnique({ where: { id: source.userId, lifecycleStatus: 'ACTIVE' },
      select: { tokenVersion: true } });
    if (!user) throw invalidRefreshToken();

    let proof;
    try {
      proof = await validateSessionAssurance({ id: source.assuranceId, userId: source.userId,
        clientDomain: source.domain, credentialEpoch: user.tokenVersion,
        orgId: source.orgId, teamId: source.teamId }, tx, now);
    } catch (error) {
      if (error instanceof AppError && [401, 403].includes(error.statusCode)) throw invalidRefreshToken();
      throw error;
    }
    const origin = proof.derivedFromId
      ? await tx.sessionAssurance.findUniqueOrThrow({ where: { id: proof.derivedFromId } })
      : proof;
    if (!derivesTeamSessionProof(origin, target.orgId)) throw interactionRequired();

    // The target's current rules, judged against the original sign-in the new session will carry.
    const targetPolicy = createRefreshTokenRotationPolicyGuard({
      prisma: tx,
      now: () => now,
      targetTeam: target,
      targetTeamError: 'TEAM_NOT_AVAILABLE',
      twoFa: { config: params.config, error: 'INTERACTION_REQUIRED' },
    });
    try {
      await withSessionAssurance(origin, () => targetPolicy(source));
    } catch (error) {
      if (error instanceof AppError && error.message === 'SSO_TEAM_REAUTH_REQUIRED') throw interactionRequired();
      throw error;
    }

    const deadline = Math.min(origin.expiresAt.getTime(), proof.expiresAt.getTime(), source.expiresAt.getTime());
    const lifetimeSeconds = Math.floor((deadline - now.getTime()) / 1000);
    if (lifetimeSeconds < MIN_TEAM_SESSION_SECONDS) throw interactionRequired();
    const issued = await issueRefreshToken(
      {
        clientId: params.clientId,
        configUrl: params.configUrl,
        domain: params.config.domain,
        userId: source.userId,
        orgId: target.orgId,
        teamId: target.teamId,
        twoFaCompleted: source.twoFaCompleted,
        credentialEpoch: source.credentialEpoch,
        oauthScope: source.oauthScope,
        resource: source.resource,
      },
      { prisma: tx, now: () => now, refreshTokenTtlSeconds: lifetimeSeconds, sharedSecret },
    );
    const family = await tx.refreshToken.findUniqueOrThrow({ where: { id: issued.refreshTokenId },
      select: { familyId: true, expiresAt: true } });
    const orgPolicy = await tx.orgSsoPolicy.findUnique({ where: {
      clientDomain_orgId: { clientDomain: source.domain, orgId: target.orgId },
    } });
    const derived = await issueDerivedSessionAssurance(origin, {
      ...target,
      familyId: family.familyId,
      expiresAt: new Date(Math.min(origin.expiresAt.getTime(), family.expiresAt.getTime())),
      policyGeneration: orgPolicy?.generation ?? 0,
    }, tx);
    await tx.refreshToken.updateMany({ where: { familyId: family.familyId }, data: {
      assuranceId: derived.assurance.id,
      encryptedAssuranceReference: await sealEnterpriseSecret(derived.reference, `assurance:${derived.assurance.id}`),
    } });

    return (deps?.issueTokenPairForUser ?? issueTokenPairForUser)(
      {
        userId: source.userId,
        config: params.config,
        configUrl: params.configUrl,
        clientId: params.clientId,
        refreshToken: issued.refreshToken,
        refreshTokenExpiresInSeconds: lifetimeSeconds,
        active: target,
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
