import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DeviceLoginGrant, PrismaClient, RefreshToken } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import { debugLoginSourceAssurance, inheritDebugLoginAssurance } from './debug-login-assurance.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { createRefreshTokenRotationPolicyGuard } from './refresh-token-rotation-policy.service.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import { issueRefreshToken } from './refresh-token.service.js';
import { issueTokenPairForUser } from './token.service.js';
import { requiresExactAuthorizationTeam } from './required-team-placement.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';
import { resolveAccessTokenTtl, resolveRefreshTokenLifetime } from './token-session-ttl.service.js';

export type DeviceLoginContext = { config: ClientConfig; configUrl: string; clientId: string; clientDomainId: string };
type Deps = { prisma: PrismaClient; now?: () => Date };
const fail = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
const ttlMs = 300_000;
const hmac = (scope: string, value: string) =>
  createHmac('sha256', getEnv().SHARED_SECRET).update('uoa:device-login:v1:' + scope + ':' + value).digest('hex');
const codeHash = (value: string) => hmac('code', value);
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const matches = (row: Pick<DeviceLoginGrant, 'domain' | 'clientId' | 'configUrl'>, context: DeviceLoginContext) =>
  row.domain === context.config.domain && row.clientId === context.clientId && row.configUrl === context.configUrl;
const randomCode = () => randomInt(0, 100_000_000).toString().padStart(8, '0');

async function assertPolicy(context: DeviceLoginContext, tx: PrismaClient) {
  await lockTokenIssuanceProductPolicy(context, { prisma: tx });
  const row = await tx.clientDomain.findUnique({ where: { id: context.clientDomainId },
    select: { deviceLoginConfigUrls: true } });
  if (!row?.deviceLoginConfigUrls.includes(context.configUrl)) throw fail();
}

async function validateSource(context: DeviceLoginContext, source: RefreshToken, tx: PrismaClient, now: Date) {
  if (!matches(source, context) || source.revokedAt || source.securityRevokedAt || source.replacedByTokenId
    || source.expiresAt <= now || source.resource || source.oauthScope || source.credentialEpoch !== null) throw fail();
  const teamPolicy = await resolveProductTeamPolicy({ domain: context.config.domain }, { prisma: tx });
  if (!source.orgId && requiresExactAuthorizationTeam(context.config, teamPolicy)) throw fail();
  await createRefreshTokenRotationPolicyGuard({
    prisma: tx, now: () => now, twoFa: { config: context.config, error: 'INTERACTION_REQUIRED' },
  })(source);
  const assurance = await debugLoginSourceAssurance(source, tx);
  if (!assurance || assurance.expiresAt <= now) throw fail();
  const user = await tx.user.findUnique({ where: { id: source.userId, lifecycleStatus: 'ACTIVE' },
    select: { tokenVersion: true } });
  if (!user) throw fail();
  return { assurance, tokenVersion: user.tokenVersion };
}

async function sourceForToken(context: DeviceLoginContext, token: string, tx: PrismaClient, now: Date) {
  const tokenHash = hashRefreshToken(token, getEnv().SHARED_SECRET);
  const candidate = await tx.refreshToken.findUnique({ where: { tokenHash } });
  if (!candidate) throw fail();
  await lockRefreshSessionUserDomain(candidate, { prisma: tx });
  const source = await tx.refreshToken.findUnique({ where: { tokenHash } });
  if (!source) throw fail();
  return { source, ...await validateSource(context, source, tx, now) };
}

function verifyGrantSource(grant: DeviceLoginGrant, source: RefreshToken, tokenVersion: number,
  context: DeviceLoginContext, now: Date) {
  if (!matches(grant, context) || grant.sourceFamilyId !== source.familyId || grant.userId !== source.userId
    || grant.tokenVersion !== tokenVersion || grant.orgId !== source.orgId || grant.teamId !== source.teamId
    || grant.expiresAt <= now || grant.usedAt || grant.deniedAt) throw fail();
}

export async function consumeDeviceClaimBudget(context: DeviceLoginContext, ip: string, deps: Deps) {
  const now = deps.now?.() ?? new Date();
  for (const [scope, value, limit] of [
    ['site', context.clientDomainId + ':' + context.configUrl, 60],
    ['ip', context.clientDomainId + ':' + context.configUrl + ':' + ip, 8],
  ] as const) {
    const keyHash = hmac('attempt:' + scope, value);
    await deps.prisma.deviceLoginAttemptBucket.updateMany({
      where: { keyHash, resetAt: { lte: now } }, data: { count: 0, resetAt: new Date(now.getTime() + ttlMs) },
    });
    const row = await deps.prisma.deviceLoginAttemptBucket.upsert({
      where: { keyHash }, create: { keyHash, count: 1, resetAt: new Date(now.getTime() + ttlMs) },
      update: { count: { increment: 1 } },
    });
    if (row.count > limit) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
  }
}

export async function issueDeviceLogin(context: DeviceLoginContext, token: string,
  previousGrantId: string | undefined, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const now = deps.now?.() ?? new Date();
    const { source, assurance, tokenVersion } = await sourceForToken(context, token, tx, now);
    const recent = await tx.deviceLoginGrant.count({ where: {
      userId: source.userId, createdAt: { gt: new Date(now.getTime() - 30 * 60_000) },
    } });
    if (recent >= 10) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    if (previousGrantId) await tx.deviceLoginGrant.updateMany({ where: {
      id: previousGrantId, userId: source.userId, sourceFamilyId: source.familyId, usedAt: null,
    }, data: { usedAt: now } });
    const expiresAt = new Date(Math.min(now.getTime() + ttlMs, source.expiresAt.getTime(), assurance.expiresAt.getTime()));
    if (expiresAt <= now) throw fail();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'uoa:device-login:code:' + context.clientDomainId}, 0))::text`;
    let code: string | undefined;
    for (let i = 0; i < 20; i++) {
      const candidate = randomCode();
      const existing = await tx.deviceLoginGrant.findUnique({ where: { codeHash: codeHash(candidate) } });
      if (!existing) { code = candidate; break; }
      if (existing.expiresAt <= now) {
        await tx.deviceLoginGrant.delete({ where: { id: existing.id } });
        code = candidate; break;
      }
    }
    if (!code) throw new AppError('INTERNAL', 503);
    const grant = await tx.deviceLoginGrant.create({ data: {
      codeHash: codeHash(code), sourceFamilyId: source.familyId, userId: source.userId,
      tokenVersion, domain: source.domain, clientId: source.clientId, configUrl: source.configUrl,
      orgId: source.orgId, teamId: source.teamId, expiresAt, createdAt: now,
    } });
    return { code, grant_id: grant.id, expires_in: Math.floor((expiresAt.getTime() - now.getTime()) / 1000) };
  });
}

export async function claimDeviceLogin(context: DeviceLoginContext, code: string, challenge: string, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const now = deps.now?.() ?? new Date();
    const grant = await tx.deviceLoginGrant.findUnique({ where: { codeHash: codeHash(code) } });
    if (!grant || !matches(grant, context) || grant.expiresAt <= now || grant.usedAt || grant.deniedAt
      || grant.claimId) throw fail();
    const claimId = randomBytes(32).toString('base64url');
    const confirmationCode = randomInt(0, 10_000).toString().padStart(4, '0');
    const won = await tx.deviceLoginGrant.updateMany({ where: { id: grant.id, claimId: null,
      expiresAt: { gt: now }, usedAt: null, deniedAt: null }, data: { claimId, challenge, confirmationCode } });
    if (won.count !== 1) throw fail();
    return { claim_id: claimId, confirmation_code: confirmationCode,
      expires_in: Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000) };
  });
}

export async function sourceDeviceStatus(context: DeviceLoginContext, token: string, grantId: string, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const now = deps.now?.() ?? new Date();
    const grant = await tx.deviceLoginGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw fail();
    const { source, tokenVersion } = await sourceForToken(context, token, tx, now);
    verifyGrantSource(grant, source, tokenVersion, context, now);
    return { status: grant.approvedAt ? 'approved' : grant.claimId ? 'claimed' : 'waiting',
      claim_id: grant.claimId, confirmation_code: grant.confirmationCode,
      expires_in: Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000) };
  });
}

export async function decideDeviceLogin(context: DeviceLoginContext, token: string,
  grantId: string, claimId: string | undefined, approve: boolean, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const now = deps.now?.() ?? new Date();
    const grant = await tx.deviceLoginGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw fail();
    const { source, tokenVersion } = await sourceForToken(context, token, tx, now);
    verifyGrantSource(grant, source, tokenVersion, context, now);
    if (approve && (!claimId || grant.claimId !== claimId || !grant.confirmationCode)) throw fail();
    const won = await tx.deviceLoginGrant.updateMany({ where: { id: grant.id, usedAt: null,
      expiresAt: { gt: now }, ...(approve ? { claimId, approvedAt: null, deniedAt: null }
        : { deniedAt: null }) }, data: approve ? { approvedAt: now } : { deniedAt: now } });
    if (won.count !== 1) throw fail();
    return { status: approve ? 'approved' : 'denied' };
  });
}

export async function cancelDeviceLogin(context: DeviceLoginContext, token: string, grantId: string, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const now = deps.now?.() ?? new Date();
    const grant = await tx.deviceLoginGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw fail();
    const { source, tokenVersion } = await sourceForToken(context, token, tx, now);
    verifyGrantSource(grant, source, tokenVersion, context, now);
    await tx.deviceLoginGrant.updateMany({ where: { id: grant.id, usedAt: null }, data: { usedAt: now } });
    return { status: 'cancelled' };
  });
}

function assertClaim(grant: DeviceLoginGrant | null, context: DeviceLoginContext, verifier: string) {
  if (!grant || !matches(grant, context) || !grant.challenge) throw fail();
  const expected = Buffer.from(grant.challenge);
  const actual = Buffer.from(sha256(verifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw fail();
}

export async function claimDeviceStatus(context: DeviceLoginContext, claimId: string,
  verifier: string, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const grant = await tx.deviceLoginGrant.findUnique({ where: { claimId } });
    assertClaim(grant, context, verifier);
    const now = deps.now?.() ?? new Date();
    return { status: grant!.usedAt || grant!.deniedAt ? 'denied' : grant!.expiresAt <= now ? 'expired'
      : grant!.approvedAt ? 'approved' : 'waiting' };
  });
}

export async function completeDeviceLogin(context: DeviceLoginContext, claimId: string,
  verifier: string, deps: Deps) {
  return runInTransaction(deps.prisma, async (tx) => {
    await assertPolicy(context, tx);
    const grant = await tx.deviceLoginGrant.findUnique({ where: { claimId } });
    assertClaim(grant, context, verifier);
    const g = grant!;
    await lockAndAssertAuthenticationEpoch({
      userId: g.userId, domain: g.domain, credentialEpoch: g.tokenVersion,
    }, { prisma: tx });
    const now = deps.now?.() ?? new Date();
    if (!g.approvedAt || g.deniedAt || g.usedAt || g.expiresAt <= now) throw fail();
    const source = await tx.refreshToken.findFirst({ where: {
      familyId: g.sourceFamilyId, userId: g.userId, revokedAt: null,
      securityRevokedAt: null, replacedByTokenId: null, expiresAt: { gt: now },
    } });
    if (!source || source.orgId !== g.orgId || source.teamId !== g.teamId) throw fail();
    const { assurance, tokenVersion } = await validateSource(context, source, tx, now);
    if (tokenVersion !== g.tokenVersion) throw fail();
    const won = await tx.deviceLoginGrant.updateMany({ where: { id: g.id, usedAt: null,
      expiresAt: { gt: now }, approvedAt: { not: null }, deniedAt: null }, data: { usedAt: now } });
    if (won.count !== 1) throw fail();
    const remainingSeconds = Math.floor((Math.min(source.expiresAt.getTime(), assurance.expiresAt.getTime())
      - now.getTime()) / 1000);
    if (remainingSeconds <= 0) throw fail();
    const accessTokenTtl = resolveAccessTokenTtl(context.config, getEnv().ACCESS_TOKEN_TTL);
    const lifetime = resolveRefreshTokenLifetime(context.config, accessTokenTtl, remainingSeconds, now);
    const familyId = randomUUID();
    const refresh = await issueRefreshToken({
      familyId, userId: source.userId, domain: source.domain, clientId: source.clientId,
      configUrl: context.configUrl, orgId: source.orgId, teamId: source.teamId,
      twoFaCompleted: source.twoFaCompleted,
    }, { prisma: tx, now: () => lifetime.now, refreshTokenTtlSeconds: lifetime.ttlSeconds });
    await inheritDebugLoginAssurance(assurance, { familyId, expiresAt: lifetime.expiresAt }, tx);
    return issueTokenPairForUser({
      config: context.config, configUrl: context.configUrl, clientId: context.clientId, userId: source.userId,
      refreshToken: refresh.refreshToken, refreshTokenExpiresInSeconds: refresh.expiresInSeconds,
      active: source.orgId && source.teamId ? { orgId: source.orgId, teamId: source.teamId } : null,
    }, { prisma: tx, adminPrisma: tx, accessTokenTtl });
  });
}
