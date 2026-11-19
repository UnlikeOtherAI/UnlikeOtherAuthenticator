import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { decryptTwoFaSecret } from '../utils/twofa-secret.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { sendActionVerificationEmail } from './email.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { findMatchingTotpCounter } from './totp.service.js';
import { buildUserIdentity } from './user-scope.service.js';

export const ACCOUNT_DELETION_PATH = '/auth/delete-account';
export const ACCOUNT_DELETION_PROOF_SECONDS = 600;

const proofType = 'ACCOUNT_DELETION';
const eligibleStatuses = ['ACTIVE', 'DISABLED'] as const;

function proofHash(challengeId: string, browser: string, code: string) {
  return hashEmailToken(`account-deletion:${challengeId}:${browser}:${code}`, getEnv().SHARED_SECRET);
}

function browserHash(challengeId: string, browser: string) {
  return hashEmailToken(`account-deletion-browser:${challengeId}:${browser}`, getEnv().SHARED_SECRET);
}

function matchesHash(expected: string | null, actual: string) {
  return expected !== null && expected.length === actual.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function startAccountDeletionRequest(email: string, browser: string) {
  const startedAt = Date.now();
  const challengeId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const identity = buildUserIdentity({ email, userScope: 'global' });
  const configUrl = new URL(ACCOUNT_DELETION_PATH, getPublicBaseUrl()).href;
  const recipient = await getAdminPrisma().$transaction(async tx => {
    const found = await tx.user.findUnique({ where: { userKey: identity.userKey }, select: { id: true } });
    if (!found) return null;
    await lockRefreshSessionUser(found.id, { prisma: tx });
    const user = await tx.user.findUnique({ where: { id: found.id } });
    if (!user?.email || user.userKey !== identity.userKey || user.domain !== null
      || !eligibleStatuses.some(status => status === user.lifecycleStatus)) return null;

    // Independent browsers cannot invalidate one another's already-issued proof.
    const recent = await tx.verificationToken.count({ where: {
      userId: user.id, type: proofType, createdAt: { gt: new Date(Date.now() - 15 * 60_000) },
    } });
    if (recent >= 3) return null;
    await tx.verificationToken.create({ data: {
      id: challengeId, type: proofType, email: user.email, userKey: identity.userKey,
      userId: user.id, tokenVersion: user.tokenVersion, configUrl,
      tokenHash: proofHash(challengeId, browser, code), actionDigest: browserHash(challengeId, browser),
      expiresAt: new Date(Date.now() + ACCOUNT_DELETION_PROOF_SECONDS * 1000),
    } });
    return user.email;
  });

  // Use the same visible mail and response for addresses with no matching account. A code
  // for such an address is never backed by a challenge and cannot verify.
  await sendActionVerificationEmail({ to: recipient ?? identity.email, code,
    domain: new URL(configUrl).hostname, description: 'Confirm an UnlikeOtherAI account deletion request' })
    .catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 250 - (Date.now() - startedAt))));
  return { challengeId };
}

export async function confirmAccountDeletionRequest(input: {
  challengeId: string; browser: string | undefined; code: string; twoFactorCode?: string;
}) {
  const { browser, challengeId, code, twoFactorCode } = input;
  const failed = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw failed();
  const confirmed = await getAdminPrisma().$transaction(async tx => {
    const candidate = await tx.verificationToken.findUnique({ where: { id: challengeId }, select: { userId: true, type: true } });
    if (candidate?.type !== proofType || !candidate.userId) return false;
    await lockRefreshSessionUser(candidate.userId, { prisma: tx });
    const token = await tx.verificationToken.findUnique({ where: { id: challengeId } });
    const user = await tx.user.findUnique({ where: { id: candidate.userId } });
    const now = new Date();
    if (!token || token.type !== proofType || token.usedAt || token.expiresAt <= now || token.attemptCount >= 5
      || !user?.email || user.domain !== null || user.userKey !== token.userKey
      || !eligibleStatuses.some(status => status === user.lifecycleStatus) || user.tokenVersion !== token.tokenVersion
      || !matchesHash(token.actionDigest, browserHash(token.id, browser))) return false;

    await tx.verificationToken.update({ where: { id: token.id }, data: { attemptCount: { increment: 1 } } });
    if (!matchesHash(token.tokenHash, proofHash(token.id, browser, code))) return false;
    if (user.twoFaEnabled) {
      if (!user.twoFaSecret || !twoFactorCode) return false;
      const counter = findMatchingTotpCounter({ secret: decryptTwoFaSecret({
        encryptedSecret: user.twoFaSecret, sharedSecret: getEnv().SHARED_SECRET,
      }), code: twoFactorCode, now });
      if (counter === null) return false;
      const consumed = await tx.user.updateMany({ where: { id: user.id, tokenVersion: user.tokenVersion,
        twoFaEnabled: true, twoFaSecret: user.twoFaSecret,
        OR: [{ twoFaLastAcceptedCounter: null }, { twoFaLastAcceptedCounter: { lt: counter } }],
      }, data: { twoFaLastAcceptedCounter: counter } });
      if (consumed.count !== 1) return false;
    }
    await tx.verificationToken.update({ where: { id: token.id }, data: { usedAt: now } });
    await tx.user.updateMany({ where: { id: user.id, accountDeletionRequestedAt: null },
      data: { accountDeletionRequestedAt: now } });
    return true;
  });
  if (!confirmed) throw failed();
  return { submitted: true };
}
