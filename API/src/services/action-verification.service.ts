import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import type { AccessTokenClaims } from './access-token.service.js';
import type { ClientConfig } from './config.service.js';
import { sendActionVerificationEmail } from './email.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { resolveTwoFaPolicy } from './twofactor-policy.service.js';
import { verifyTwoFactorForLogin } from './twofactor-login.service.js';

const TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
type Context = {
  claims: AccessTokenClaims;
  config: ClientConfig;
  configUrl: string;
  actionDigest: string;
};
type Deps = {
  prisma: PrismaClient;
  now?: () => Date;
  generateCode?: () => string;
  sendEmail?: typeof sendActionVerificationEmail;
};
const failed = () => new AppError('UNAUTHORIZED', 401, 'ACTION_VERIFICATION_FAILED');
const codeHash = (id: string, code: string) => hashEmailToken(`${id}:${code}`, getEnv().SHARED_SECRET);

async function requireFactor(context: Context, prisma: Pick<PrismaClient, 'user' | 'organisation' | 'clientDomain'>): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: context.claims.userId }, select: { twoFaEnabled: true },
  });
  if (!user) throw failed();
  const policy = await resolveTwoFaPolicy({
    config: context.config, userId: context.claims.userId, orgId: context.claims.active?.orgId,
  }, { prisma });
  if (policy === 'REQUIRED' && !user.twoFaEnabled) {
    throw new AppError('FORBIDDEN', 403, 'TWOFA_ENROLLMENT_REQUIRED');
  }
  return user.twoFaEnabled;
}

/** A product session identifies the recipient; only a new code proves this action. */
export async function startActionVerification(
  input: Context & { description: string }, deps: Deps,
): Promise<{ challengeId: string; expiresAt: string; twoFactorRequired: boolean }> {
  const code = deps.generateCode?.() ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
  const id = randomUUID();
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockAndAssertAuthenticationEpoch({
      userId: input.claims.userId, domain: input.config.domain, credentialEpoch: input.claims.tokenVersion,
    }, { prisma: tx });
    const now = deps.now?.() ?? new Date();
    const user = await tx.user.findUnique({ where: { id: input.claims.userId } });
    if (!user) throw failed();
    // Persisted under the user lock: multiple service instances cannot evade this ceiling.
    const recent = await tx.verificationToken.count({ where: {
      userId: user.id, type: 'ACTION_VERIFICATION', createdAt: { gt: new Date(now.getTime() - 15 * 60_000) },
    } });
    if (recent >= 20) throw new AppError('RATE_LIMITED', 429, 'RATE_LIMITED');
    const twoFactorRequired = await requireFactor(input, tx);
    const expiresAt = new Date(now.getTime() + TTL_MS);
    await tx.verificationToken.updateMany({ where: {
      userId: user.id, domain: input.config.domain, type: 'ACTION_VERIFICATION',
      actionDigest: input.actionDigest, usedAt: null,
    }, data: { usedAt: now } });
    await tx.verificationToken.create({ data: {
      id, type: 'ACTION_VERIFICATION', email: user.email, userKey: user.userKey,
      userId: user.id, tokenVersion: user.tokenVersion, domain: input.config.domain,
      configUrl: input.configUrl, actionDigest: input.actionDigest,
      tokenHash: codeHash(id, code), expiresAt,
    } });
    return { email: user.email, expiresAt, twoFactorRequired };
  });
  await (deps.sendEmail ?? sendActionVerificationEmail)({
    to: result.email, code, domain: input.config.domain, description: input.description,
    theme: extractEmailTheme(input.config),
  });
  return { challengeId: id, expiresAt: result.expiresAt.toISOString(), twoFactorRequired: result.twoFactorRequired };
}

export async function verifyActionVerification(
  input: Context & { challengeId: string; code: string; twoFactorCode?: string }, deps: Deps,
): Promise<{ verified: true; actionDigest: string }> {
  const verified = await deps.prisma.$transaction(async (tx) => {
    await lockAndAssertAuthenticationEpoch({
      userId: input.claims.userId, domain: input.config.domain, credentialEpoch: input.claims.tokenVersion,
    }, { prisma: tx });
    const twoFactorRequired = await requireFactor(input, tx);
    const now = deps.now?.() ?? new Date();
    const token = await tx.verificationToken.findUnique({ where: { id: input.challengeId } });
    if (!token || token.type !== 'ACTION_VERIFICATION' || token.usedAt || token.expiresAt <= now
      || token.attemptCount >= MAX_ATTEMPTS || token.userId !== input.claims.userId
      || token.tokenVersion !== input.claims.tokenVersion || token.domain !== input.config.domain
      || token.actionDigest !== input.actionDigest) return false;
    // Return false instead of throwing so a failed attempt is committed, not rolled back.
    await tx.verificationToken.update({ where: { id: token.id }, data: { attemptCount: { increment: 1 } } });
    if (!timingSafeEqual(Buffer.from(token.tokenHash), Buffer.from(codeHash(token.id, input.code)))) return false;
    if (twoFactorRequired) {
      if (!input.twoFactorCode) return false;
      try {
        await verifyTwoFactorForLogin({ userId: input.claims.userId, code: input.twoFactorCode }, { prisma: tx });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 401) return false;
        throw error;
      }
    }
    const consumed = await tx.verificationToken.updateMany({
      where: { id: token.id, usedAt: null }, data: { usedAt: now },
    });
    return consumed.count === 1;
  });
  if (!verified) throw failed();
  return { verified: true, actionDigest: input.actionDigest };
}
