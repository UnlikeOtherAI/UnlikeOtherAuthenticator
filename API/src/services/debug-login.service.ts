import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, RefreshToken } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { createRefreshTokenRotationPolicyGuard } from './refresh-token-rotation-policy.service.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import { issueRefreshToken } from './refresh-token.service.js';
import { issueTokenPairForUser } from './token.service.js';
import { requiresExactAuthorizationTeam } from './required-team-placement.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';
import { resolveAccessTokenTtl } from './token-session-ttl.service.js';

const TTL_SECONDS = 1800;
/** Only signed presentation variants can share a product capability. */
export function debugLoginConfigIdentity(configUrl: string): string {
  const url = new URL(configUrl);
  const themes = url.searchParams.getAll('theme');
  if (themes.length > 1 || (themes.length === 1 && !['nessie', 'nebula', 'midnight'].includes(themes[0]))) {
    throw fail();
  }
  url.searchParams.delete('theme');
  return url.toString();
}
function matchesContext(row: { domain: string; clientId: string; configUrl: string }, context: Context) {
  return row.domain === context.config.domain && row.clientId === context.clientId
    && debugLoginConfigIdentity(row.configUrl) === debugLoginConfigIdentity(context.configUrl);
}
const fail = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
const digest = (token: string) => createHash('sha256').update(`uoa:debug-login:v1:${token}`).digest('hex');
type Context = { config: ClientConfig; configUrl: string; clientId: string; clientDomainId: string };
type Deps = { prisma: PrismaClient; now?: () => Date; beforeRedemptionLock?: () => Promise<void> };

async function validateSource(context: Context, source: RefreshToken, prisma: PrismaClient, now: Date) {
  if (!matchesContext(source, context)
    || source.revokedAt || source.securityRevokedAt || source.replacedByTokenId || source.expiresAt <= now
    || source.resource || source.oauthScope || source.credentialEpoch !== null) throw fail();
  const teamPolicy = await resolveProductTeamPolicy({ domain: context.config.domain }, { prisma });
  if (!source.orgId && requiresExactAuthorizationTeam(context.config, teamPolicy)) throw fail();
  await createRefreshTokenRotationPolicyGuard({
    prisma, now: () => now, twoFa: { config: context.config, error: 'INTERACTION_REQUIRED' },
  })(source);
}

export async function issueDebugLogin(
  input: Context & { refreshToken: string; previousToken?: string }, deps: Deps,
): Promise<{ token: string; expires_in: number }> {
  return runInTransaction(deps.prisma, async (tx) => {
    await lockTokenIssuanceProductPolicy(
      { domain: input.config.domain, clientDomainId: input.clientDomainId }, { prisma: tx },
    );
    const tokenHash = hashRefreshToken(input.refreshToken, getEnv().SHARED_SECRET);
    const candidate = await tx.refreshToken.findUnique({ where: { tokenHash } });
    if (!candidate) throw fail();
    await lockRefreshSessionUserDomain(candidate, { prisma: tx });
    const source = await tx.refreshToken.findUnique({ where: { tokenHash } });
    const now = deps.now?.() ?? new Date();
    if (!source) throw fail();
    await validateSource(input, source, tx, now);
    const user = await tx.user.findUnique({ where: { lifecycleStatus: 'ACTIVE', id: source.userId }, select: { tokenVersion: true } });
    if (!user) throw fail();
    const recent = await tx.debugLoginGrant.count({ where: {
      userId: source.userId, createdAt: { gt: new Date(now.getTime() - 30 * 60_000) },
    } });
    if (recent >= 20) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    if (input.previousToken) {
      const previous = await tx.debugLoginGrant.findUnique({ where: { tokenHash: digest(input.previousToken) } });
      if (previous) {
        if (previous.userId !== source.userId || previous.sourceFamilyId !== source.familyId
          || !matchesContext(previous, input)) throw fail();
        await tx.debugLoginGrant.updateMany({ where: { id: previous.id, usedAt: null }, data: { usedAt: now } });
      }
      // Pruned expiry metadata means no live grant remains to invalidate.
    }
    const token = randomBytes(32).toString('base64url');
    await tx.debugLoginGrant.create({ data: {
      tokenHash: digest(token), sourceFamilyId: source.familyId, userId: source.userId,
      tokenVersion: user.tokenVersion, domain: source.domain, clientId: source.clientId,
      configUrl: source.configUrl, orgId: source.orgId, teamId: source.teamId,
      expiresAt: new Date(now.getTime() + TTL_SECONDS * 1000), createdAt: now,
    } });
    return { token, expires_in: TTL_SECONDS };
  });
}

export async function redeemDebugLogin(input: Context & { token: string }, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await lockTokenIssuanceProductPolicy(
      { domain: input.config.domain, clientDomainId: input.clientDomainId }, { prisma: tx },
    );
    const grant = await tx.debugLoginGrant.findUnique({ where: { tokenHash: digest(input.token) } });
    if (!grant || !matchesContext(grant, input)) throw fail();
    await deps.beforeRedemptionLock?.();
    await lockAndAssertAuthenticationEpoch({
      userId: grant.userId, domain: grant.domain, credentialEpoch: grant.tokenVersion,
    }, { prisma: tx });
    const now = deps.now?.() ?? new Date();
    if (grant.usedAt || grant.expiresAt <= now) throw fail();
    const source = await tx.refreshToken.findFirst({ where: {
      familyId: grant.sourceFamilyId, userId: grant.userId, revokedAt: null,
      securityRevokedAt: null, replacedByTokenId: null, expiresAt: { gt: now },
    } });
    if (!source || source.orgId !== grant.orgId || source.teamId !== grant.teamId) throw fail();
    await validateSource(input, source, tx, now);
    const consumed = await tx.debugLoginGrant.updateMany({
      where: { id: grant.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now },
    });
    if (consumed.count !== 1) throw fail();
    // Bound the independent family's lifetime to the source's remaining lifetime.
    const remainingSeconds = Math.floor((source.expiresAt.getTime() - now.getTime()) / 1000);
    if (remainingSeconds <= 0) throw fail();
    const refresh = await issueRefreshToken({
      userId: source.userId, domain: source.domain, clientId: source.clientId,
      configUrl: input.configUrl, orgId: source.orgId, teamId: source.teamId,
      twoFaCompleted: source.twoFaCompleted,
    }, { prisma: tx, now: () => now,
      refreshTokenTtlSeconds: remainingSeconds });
    return issueTokenPairForUser({
      config: input.config, configUrl: input.configUrl, clientId: input.clientId, userId: source.userId,
      refreshToken: refresh.refreshToken, refreshTokenExpiresInSeconds: refresh.expiresInSeconds,
      active: source.orgId && source.teamId ? { orgId: source.orgId, teamId: source.teamId } : null,
    }, { prisma: tx, adminPrisma: tx,
      accessTokenTtl: resolveAccessTokenTtl(input.config, getEnv().ACCESS_TOKEN_TTL) });
  });
}
