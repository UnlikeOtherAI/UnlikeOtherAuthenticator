import { rejoinPreview, resumeProduct } from './product-rejoin.service.js';
import { verifyPassword } from './password.service.js';
import { assertMailboxCredentialAdmission } from './credential-admission.service.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { commitProductErasure, enabledProduct, productImpact } from './product-erasure.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
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

function factorDigest(id: string, user: { userKey: string | null; twoFaEnabled: boolean; twoFaSecret: string | null; passwordHash: string | null }, passwordVerified = false) {
  return hashEmailToken(JSON.stringify([id, user.userKey, user.twoFaEnabled, user.twoFaSecret, passwordVerified, passwordVerified ? user.passwordHash : null]), getEnv().SHARED_SECRET);
}

function requestUrl(product?: string, rejoin = false) {
  const url = new URL(ACCOUNT_DELETION_PATH, getPublicBaseUrl());
  if (product) url.searchParams.set('product', product);
  if (rejoin) {
    if (!product) throw new AppError('BAD_REQUEST', 400);
    url.searchParams.set('action', 'rejoin');
  }
  return url.href;
}

export async function startAccountDeletionRequest(email: string, browser: string, product?: string, rejoin = false) {
  const startedAt = Date.now();
  const challengeId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const identity = buildUserIdentity({ email, userScope: 'global' });
  const configUrl = requestUrl(product, rejoin);
  const policy = product ? await enabledProduct(getAdminPrisma(), product) : null;
  const recipient = await getAdminPrisma().$transaction(async tx => {
    // This form proves a global SSO identity. If the product has a distinct
    // per-domain identity for this mailbox, never substitute the global subject.
    if (policy?.domains.length && await tx.user.count({ where: { email: identity.email, domain: { in: policy.domains } } })) return null;
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
    domain: new URL(configUrl).hostname, description: rejoin ? `Confirm fresh registration for ${policy?.name}` : policy ? `Review deletion of your ${policy.name} product account` : 'Confirm an UnlikeOtherAI account deletion request' })
    .catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 250 - (Date.now() - startedAt))));
  return { challengeId };
}

export async function confirmAccountDeletionRequest(input: {
  challengeId: string; browser: string | undefined; code: string; twoFactorCode?: string; password?: string; product?: string; rejoin?: boolean;
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
    const url = requestUrl(input.product, input.rejoin);
    if (!token || token.configUrl !== url || token.type !== proofType || token.usedAt || token.expiresAt <= now || token.attemptCount >= 5
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
    if (input.product) {
      const policy = await enabledProduct(tx, input.product);
      const passwordVerified = Boolean(input.password && user.passwordHash) && await verifyPassword(input.password ?? '', user.passwordHash);
      if (input.password && !passwordVerified) return false;
      if (!user.twoFaEnabled && !passwordVerified) await assertMailboxCredentialAdmission(user.id, tx);
      const preview = input.rejoin ? await rejoinPreview(tx, user.id, policy) : await productImpact(tx, user.id, policy);
      await tx.verificationToken.update({ where: { id: token.id }, data: { usedAt: now, productPreviewDigest: preview.digest, productFactorDigest: factorDigest(token.id, user, passwordVerified) } });
      return preview;
    }
    await tx.verificationToken.update({ where: { id: token.id }, data: { usedAt: now } });
    await tx.user.updateMany({ where: { id: user.id, accountDeletionRequestedAt: null },
      data: { accountDeletionRequestedAt: now } });
    return true;
  });
  if (!confirmed) throw failed();
  return confirmed === true ? { submitted: true } : confirmed;
}

export async function submitProductErasure(input: { product: string; challengeId: string; digest: string; rejoin?: boolean; container?: import('./product-erasure-containers.service.js').Container; browser?: string }) {
  if (!input.browser) throw new AppError('UNAUTHORIZED', 401);
  const browser = input.browser;
  return getAdminPrisma().$transaction(async tx => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyExclusive(tx);
    const token = await tx.verificationToken.findUnique({ where: { id: input.challengeId } });
    const url = requestUrl(input.product, input.rejoin);
    if (!token?.userId || token.type !== proofType || token.configUrl !== url || !token.usedAt ||
        !matchesHash(token.actionDigest, browserHash(token.id, browser)) || token.productPreviewDigest !== input.digest) {
      throw new AppError('UNAUTHORIZED', 401);
    }
    await lockRefreshSessionUser(token.userId, { prisma: tx });
    const user = await tx.user.findUnique({ where: { id: token.userId } });
    if (!user || !eligibleStatuses.some(s => s === user.lifecycleStatus) || user.tokenVersion !== token.tokenVersion ||
        token.expiresAt <= new Date()) throw new AppError('UNAUTHORIZED', 401);
    const passwordVerified = Boolean(user.passwordHash) && matchesHash(token.productFactorDigest, factorDigest(token.id, user, true));
    if (!passwordVerified && !matchesHash(token.productFactorDigest, factorDigest(token.id, user))) throw new AppError('UNAUTHORIZED', 401);
    if (!user.twoFaEnabled && !passwordVerified) await assertMailboxCredentialAdmission(user.id, tx);
    if (input.rejoin && input.container) throw new AppError('BAD_REQUEST', 400);
    const selection = JSON.stringify(input.container ? [input.container.scope, input.container.id] : []);
    if (token.productReceiptId) {
      if (token.productSelection !== selection) throw new AppError('BAD_REQUEST', 409, 'DELETION_RETRY_MISMATCH');
      const job = await tx.productErasureJob.findUniqueOrThrow({ where: { id: token.productReceiptId } });
      return { receipt: job.id, complete: Boolean(job.completedAt) };
    }
    const policy = await enabledProduct(tx, input.product);
    const result = input.rejoin ? await resumeProduct(tx, user.id, policy, input.digest)
      : await commitProductErasure(tx, user.id, policy, input.digest, input.container);
    await tx.verificationToken.update({ where: { id: token.id }, data: { productReceiptId: result.receipt, productSelection: selection } });
    return result;
  }, { isolationLevel: 'Serializable' });
}
