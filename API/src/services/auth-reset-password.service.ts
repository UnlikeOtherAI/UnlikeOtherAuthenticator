import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { generateEmailToken, hashEmailToken } from '../utils/verification-token.js';
import { sendPasswordResetEmail } from './email.service.js';
import { hashPassword } from './password.service.js';
import { buildUserIdentity } from './user-scope.service.js';

type ResetPasswordPrisma = Pick<PrismaClient, '$transaction'> & {
  user: Pick<PrismaClient['user'], 'findUnique' | 'update'>;
  verificationToken: Pick<PrismaClient['verificationToken'], 'create' | 'findUnique' | 'updateMany'>;
};

type ResetPasswordDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  generateEmailToken?: typeof generateEmailToken;
  hashEmailToken?: typeof hashEmailToken;
  hashPassword?: typeof hashPassword;
  buildUserIdentity?: typeof buildUserIdentity;
  sendPasswordResetEmail?: typeof sendPasswordResetEmail;
  prisma?: ResetPasswordPrisma;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildPasswordResetLink(params: {
  baseUrl: string;
  token: string;
  configUrl: string;
}): string {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/auth/email/reset-password`);
  url.searchParams.set('token', params.token);
  url.searchParams.set('config_url', params.configUrl);
  return url.toString();
}

function assertResetTokenValid(params: {
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
  if (params.token.type !== 'PASSWORD_RESET') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_TYPE');
  }

  if (params.token.configUrl !== params.configUrl) {
    // Token is bound to the original config URL to avoid cross-client replay.
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_CONFIG_URL');
  }

  if (params.token.usedAt) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED');
  }

  if (params.token.expiresAt.getTime() <= params.now.getTime()) {
    throw new AppError('BAD_REQUEST', 400, 'TOKEN_EXPIRED');
  }
}

export async function requestPasswordReset(
  params: { email: string; config: ClientConfig; configUrl: string },
  deps?: ResetPasswordDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return;

  const identityBuilder = deps?.buildUserIdentity ?? buildUserIdentity;
  const { userKey, domain, email } = identityBuilder({
    userScope: params.config.user_scope,
    email: params.email,
    domain: params.config.domain,
  });

  const prisma = deps?.prisma ?? (getPrisma() as unknown as ResetPasswordPrisma);
  const existing = await prisma.user.findUnique({
    where: { userKey },
    select: { id: true },
  });

  // Brief 11: no email enumeration. If the user doesn't exist, do nothing.
  if (!existing) return;

  const token = deps?.generateEmailToken ? deps.generateEmailToken() : generateEmailToken();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = deps?.hashEmailToken
    ? deps.hashEmailToken(token, sharedSecret)
    : hashEmailToken(token, sharedSecret);

  const now = deps?.now ? deps.now() : new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_MS);

  await prisma.verificationToken.create({
    data: {
      type: 'PASSWORD_RESET',
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

  const link = buildPasswordResetLink({ baseUrl, token, configUrl: params.configUrl });
  await (deps?.sendPasswordResetEmail ?? sendPasswordResetEmail)({ to: email, link });
}

export async function validatePasswordResetToken(params: {
  token: string;
  configUrl: string;
  config: ClientConfig;
}): Promise<void> {
  void params.config; // Included for future-proofing; configVerifier already validates domain integrity.
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const tokenHash = hashEmailToken(params.token, SHARED_SECRET);

  const prisma = getPrisma();
  const row = await prisma.verificationToken.findUnique({
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

  if (!row) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
  }

  assertResetTokenValid({ token: row, configUrl: params.configUrl, now: new Date() });
}

export async function resetPasswordWithToken(
  params: { token: string; password: string; config: ClientConfig; configUrl: string },
  deps?: ResetPasswordDeps,
): Promise<{ userId: string }> {
  void params.config; // configVerifier already validates the config + domain integrity.
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as ResetPasswordPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = (deps?.hashEmailToken ?? hashEmailToken)(params.token, sharedSecret);
  const passwordHash = await (deps?.hashPassword ?? hashPassword)(params.password);

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

    assertResetTokenValid({ token: tokenRow, configUrl: params.configUrl, now });

    const user = await tx.user.findUnique({
      where: { userKey: tokenRow.userKey },
      select: { id: true },
    });

    if (!user) {
      // Never create a new user from a password reset token.
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_USER');
    }

    await tx.user.update({
      where: { userKey: tokenRow.userKey },
      data: { passwordHash },
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

