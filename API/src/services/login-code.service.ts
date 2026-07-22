import { randomInt, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { LOGIN_CODE_MAX_ATTEMPTS, LOGIN_CODE_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { buildUserIdentity } from './user-scope.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import { sendLoginCodeEmail } from './email.service.js';
import type { ClientConfig } from './config.service.js';
import { lockAndReadVerificationTokenEpoch } from './verification-token-epoch.service.js';

type LoginCodePrisma = PrismaClient;

type LoginCodeDeps = {
  afterUserLock?: () => Promise<void>;
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  prisma?: LoginCodePrisma;
  generateCode?: () => string;
  hashEmailToken?: typeof hashEmailToken;
  sendLoginCodeEmail?: typeof sendLoginCodeEmail;
};

/**
 * Phase 3b (design §4.3, §8): a 6-digit numeric sign-in code, zero-padded, generated with
 * crypto-strength randomness. Never derived from anything predictable (time, user id, etc).
 */
function generateSixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hash input includes userKey so the same 6-digit code issued to two different users at the same
 * time never collides on the DB's `tokenHash` unique constraint (the code space is only 1e6, unlike
 * the 256-bit random tokens used for links/invites).
 */
function hashLoginCode(params: {
  code: string;
  userKey: string;
  sharedSecret: string;
  hashFn: typeof hashEmailToken;
}): string {
  return params.hashFn(`${params.code}:${params.userKey}`, params.sharedSecret);
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Issue a LOGIN_CODE verification token and email it. Brief 11 / design §8: no email enumeration —
 * when no user exists for (email, domain) this returns silently (no code generated, no email sent).
 * The CALLER (POST /auth/start) must not let that silence change its own generic response.
 *
 * Design §4.3 / §8: at most one active code per (userKey, domain) — issuing a new one supersedes
 * any prior unused code, exactly like the existing link-token flow.
 */
export async function issueLoginCode(
  params: {
    email: string;
    config: ClientConfig;
    configUrl: string;
  },
  deps?: LoginCodeDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const { userKey, domain, email } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? getPrisma();
  const user = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true, tokenVersion: true },
  });
  if (!user) return;

  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const hashFn = deps?.hashEmailToken ?? hashEmailToken;
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

  // Supersede any prior unused LOGIN_CODE for this user before minting a new one.
  await prisma.verificationToken.updateMany({
    where: { userKey, type: 'LOGIN_CODE', usedAt: null },
    data: { usedAt: now },
  });

  let code = '';
  let created = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    code = (deps?.generateCode ?? generateSixDigitCode)();
    const tokenHash = hashLoginCode({ code, userKey, sharedSecret, hashFn });

    try {
      await prisma.verificationToken.create({
        data: {
          type: 'LOGIN_CODE',
          email,
          userKey,
          domain,
          configUrl: params.configUrl,
          tokenHash,
          expiresAt,
          attemptCount: 0,
          userId: user.id,
          tokenVersion: user.tokenVersion,
        },
      });
      created = true;
      break;
    } catch (err) {
      const errCode = (err as { code?: unknown } | null)?.code;
      if (errCode === 'P2002') continue;
      throw err;
    }
  }

  if (!created) {
    throw new AppError('INTERNAL', 500, 'LOGIN_CODE_COLLISION');
  }

  const theme = extractEmailTheme(params.config);
  await (deps?.sendLoginCodeEmail ?? sendLoginCodeEmail)({ to: email, code, theme });
}

/**
 * Verify a LOGIN_CODE. Brief 12/13 + design §8: every failure mode (no user, no code, expired,
 * wrong code, already used, too many attempts) throws the SAME generic auth failure — never an
 * oracle. Each wrong-code attempt increments `attemptCount`; at LOGIN_CODE_MAX_ATTEMPTS the code is
 * treated as dead (excluded from the lookup) and the user must restart via /auth/start.
 */
export async function verifyLoginCode(
  params: {
    email: string;
    config: ClientConfig;
    code: string;
  },
  deps?: LoginCodeDeps,
): Promise<{ userId: string; credentialEpoch: number }> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }

  const { userKey } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? getPrisma();
  const readNow = deps?.now ?? (() => new Date());
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const hashFn = deps?.hashEmailToken ?? hashEmailToken;

  const candidateHash = hashLoginCode({ code: params.code, userKey, sharedSecret, hashFn });
  return runInTransaction(prisma, async (tx) => {
    const token = await tx.verificationToken.findFirst({
      where: {
        userKey,
        type: 'LOGIN_CODE',
        usedAt: null,
        attemptCount: { lt: LOGIN_CODE_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tokenHash: true,
        userId: true,
        userKey: true,
        tokenVersion: true,
        expiresAt: true,
      },
    });

    if (!token) {
      throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    }

    const epoch = await lockAndReadVerificationTokenEpoch(tx, token, deps?.afterUserLock);
    const decisionNow = readNow();
    if (epoch?.kind !== 'user' || token.expiresAt.getTime() <= decisionNow.getTime()) {
      throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    }

    const matches = constantTimeStringEqual(candidateHash, token.tokenHash);
    if (!matches) {
      await tx.verificationToken.updateMany({
        where: {
          id: token.id,
          tokenVersion: epoch.credentialEpoch,
          userId: epoch.userId,
          usedAt: null,
          expiresAt: { gt: decisionNow },
        },
        data: { attemptCount: { increment: 1 } },
      });
      throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    }

    const updated = await tx.verificationToken.updateMany({
      where: {
        id: token.id,
        tokenVersion: epoch.credentialEpoch,
        userId: epoch.userId,
        usedAt: null,
        expiresAt: { gt: decisionNow },
      },
      data: { usedAt: decisionNow },
    });
    if (updated.count !== 1) {
      throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    }

    return { userId: epoch.userId, credentialEpoch: epoch.credentialEpoch };
  });
}
