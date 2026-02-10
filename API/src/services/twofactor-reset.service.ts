import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';
import { sendTwoFaResetEmail } from './email.service.js';
import { buildUserIdentity } from './user-scope.service.js';

type TwoFaResetRequestPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
  verificationToken: Pick<PrismaClient['verificationToken'], 'create'>;
};

type TwoFaResetConsumePrisma = Pick<PrismaClient, '$transaction'> & {
  user: Pick<PrismaClient['user'], 'findUnique' | 'update'>;
  verificationToken: Pick<PrismaClient['verificationToken'], 'findUnique' | 'updateMany'>;
};

type TwoFaResetDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  generateEmailToken?: typeof generateEmailToken;
  hashEmailToken?: typeof hashEmailToken;
  sendTwoFaResetEmail?: typeof sendTwoFaResetEmail;
  prisma?: TwoFaResetRequestPrisma & TwoFaResetConsumePrisma;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildTwoFaResetLink(params: { baseUrl: string; token: string; configUrl: string }): string {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/auth/email/twofa-reset`);
  url.searchParams.set('token', params.token);
  url.searchParams.set('config_url', params.configUrl);
  return url.toString();
}

function assertTwoFaResetTokenValid(params: {
  token: Prisma.VerificationTokenGetPayload<{
    select: {
      id: true;
      type: true;
      userKey: true;
      configUrl: true;
      expiresAt: true;
      usedAt: true;
    };
  }>;
  configUrl: string;
  now: Date;
}): void {
  if (params.token.type !== 'TWOFA_RESET') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_TYPE');
  }

  if (params.token.configUrl !== params.configUrl) {
    // Bind token to the original config URL to avoid cross-client replay.
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_CONFIG_URL');
  }

  if (params.token.usedAt) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED');
  }

  if (params.token.expiresAt.getTime() <= params.now.getTime()) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_EXPIRED');
  }
}

/**
 * Brief 22.9 / Phase 8.8: email-based 2FA reset (no backup codes, no admin override).
 *
 * This issues a one-time, time-limited email token that can be used to disable 2FA on the account.
 * Must not enumerate whether the email exists (caller should always return a generic response).
 */
export async function requestTwoFaReset(
  params: { email: string; config: ClientConfig; configUrl: string },
  deps?: TwoFaResetDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const { userKey, domain, email } = buildUserIdentity({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? (getPrisma() as unknown as TwoFaResetRequestPrisma);
  const existing = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true, twoFaEnabled: true },
  });

  // No enumeration: if missing or 2FA isn't enabled, do nothing.
  if (!existing || !existing.twoFaEnabled) return;

  const token = deps?.generateEmailToken ? deps.generateEmailToken() : generateEmailToken();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = deps?.hashEmailToken
    ? deps.hashEmailToken(token, sharedSecret)
    : hashEmailToken(token, sharedSecret);

  const now = deps?.now ? deps.now() : new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_MS);

  await prisma.verificationToken.create({
    data: {
      type: 'TWOFA_RESET',
      email,
      userKey,
      domain,
      configUrl: params.configUrl,
      tokenHash,
      expiresAt,
      userId: existing.id,
    },
  });

  const baseUrl = env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;

  const link = buildTwoFaResetLink({ baseUrl, token, configUrl: params.configUrl });
  await (deps?.sendTwoFaResetEmail ?? sendTwoFaResetEmail)({ to: email, link });
}

/**
 * Consumes a TWOFA_RESET token and disables 2FA on the user.
 *
 * This is the only recovery path per brief 22.9.
 */
export async function resetTwoFaWithToken(
  params: { token: string; configUrl: string; config: ClientConfig },
  deps?: TwoFaResetDeps,
): Promise<{ userId: string }> {
  void params.config; // configVerifier already validates config + domain integrity.
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as TwoFaResetConsumePrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = (deps?.hashEmailToken ?? hashEmailToken)(params.token, sharedSecret);

  return await prisma.$transaction(async (tx) => {
    const tokenRow = await tx.verificationToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        type: true,
        userKey: true,
        configUrl: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    if (!tokenRow) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
    }

    assertTwoFaResetTokenValid({ token: tokenRow, configUrl: params.configUrl, now });

    const user = await tx.user.findUnique({
      where: { userKey: tokenRow.userKey },
      select: { id: true },
    });

    if (!user) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_USER');
    }

    await tx.user.update({
      where: { userKey: tokenRow.userKey },
      data: {
        twoFaEnabled: false,
        twoFaSecret: null,
      },
      select: { id: true },
    });

    const updated = await tx.verificationToken.updateMany({
      where: {
        id: tokenRow.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        usedAt: now,
        userId: user.id,
      },
    });

    if (updated.count !== 1) {
      throw new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED');
    }

    return { userId: user.id };
  });
}

