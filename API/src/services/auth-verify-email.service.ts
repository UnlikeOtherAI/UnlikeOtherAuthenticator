import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { hashPassword } from './password.service.js';
import { ensureDomainRoleForUser } from './domain-role.service.js';

type VerifyEmailPrisma = Pick<PrismaClient, '$transaction'> & {
  verificationToken: Pick<PrismaClient['verificationToken'], 'findUnique' | 'updateMany'>;
  user: Pick<PrismaClient['user'], 'findUnique' | 'create' | 'update'>;
};

type VerifyEmailDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  hashEmailToken?: typeof hashEmailToken;
  hashPassword?: typeof hashPassword;
  prisma?: VerifyEmailPrisma;
};

type VerifyEmailTokenRow = Prisma.VerificationTokenGetPayload<{
  select: {
    id: true;
    type: true;
    userKey: true;
    email: true;
    domain: true;
    configUrl: true;
    expiresAt: true;
    usedAt: true;
  };
}>;

export type VerifyEmailTokenType = 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL';

function assertVerifyEmailTokenType(type: VerifyEmailTokenRow['type']): asserts type is VerifyEmailTokenType {
  if (type !== 'VERIFY_EMAIL_SET_PASSWORD' && type !== 'VERIFY_EMAIL') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_TYPE');
  }
}

function assertTokenValid(params: {
  token: VerifyEmailTokenRow;
  configUrl: string;
  now: Date;
}): VerifyEmailTokenType {
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

  assertVerifyEmailTokenType(params.token.type);
  return params.token.type;
}

export async function validateVerifyEmailToken(params: {
  token: string;
  configUrl: string;
  config: ClientConfig;
}): Promise<VerifyEmailTokenType> {
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
      email: true,
      domain: true,
      configUrl: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  if (!row) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
  }

  return assertTokenValid({ token: row, configUrl: params.configUrl, now: new Date() });
}

export async function verifyEmailToken(
  params: {
    token: string;
    password?: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: VerifyEmailDeps,
): Promise<{ userId: string; type: VerifyEmailTokenType }> {
  const env = deps?.env ?? getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as VerifyEmailPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const tokenHash = (deps?.hashEmailToken ?? hashEmailToken)(params.token, sharedSecret);
  const hashPasswordFn = deps?.hashPassword ?? hashPassword;

  // Token consumption + user creation/update must be atomic to enforce one-time use.
  return await prisma.$transaction(async (tx) => {
    const tokenRow = await tx.verificationToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        type: true,
        userKey: true,
        email: true,
        domain: true,
        configUrl: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    if (!tokenRow) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
    }

    const type = assertTokenValid({ token: tokenRow, configUrl: params.configUrl, now });

    let userId: string;
    if (type === 'VERIFY_EMAIL_SET_PASSWORD') {
      if (!params.password) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_PASSWORD');
      }

      const passwordHash = await hashPasswordFn(params.password);
      const existingUser = await tx.user.findUnique({
        where: { userKey: tokenRow.userKey },
        select: { id: true, passwordHash: true },
      });

      if (existingUser?.passwordHash) {
        // A verify-email token must never be usable to reset an established account password.
        throw new AppError('BAD_REQUEST', 400, 'USER_ALREADY_HAS_PASSWORD');
      }

      if (existingUser) {
        const updated = await tx.user.update({
          where: { userKey: tokenRow.userKey },
          data: {
            // Keep identity stable; updating these is safe and makes the record consistent.
            email: tokenRow.email,
            domain: tokenRow.domain,
            passwordHash,
          },
          select: { id: true },
        });
        userId = updated.id;
      } else {
        const created = await tx.user.create({
          data: {
            email: tokenRow.email,
            userKey: tokenRow.userKey,
            domain: tokenRow.domain,
            passwordHash,
          },
          select: { id: true },
        });
        userId = created.id;
      }
    } else {
      const existingUser = await tx.user.findUnique({
        where: { userKey: tokenRow.userKey },
        select: { id: true },
      });

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const created = await tx.user.create({
          data: {
            email: tokenRow.email,
            userKey: tokenRow.userKey,
            domain: tokenRow.domain,
            passwordHash: null,
          },
          select: { id: true },
        });
        userId = created.id;
      }
    }

    // Brief 18: ensure a per-domain role exists for this domain.
    await ensureDomainRoleForUser({
      domain: params.config.domain,
      userId,
      prisma: tx,
    });

    const updated = await tx.verificationToken.updateMany({
      where: {
        id: tokenRow.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        usedAt: now,
        userId,
      },
    });

    if (updated.count !== 1) {
      throw new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED');
    }

    return { userId, type };
  });
}

export async function verifyEmailAndSetPassword(
  params: {
    token: string;
    password: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: VerifyEmailDeps,
): Promise<{ userId: string }> {
  const result = await verifyEmailToken(
    {
      token: params.token,
      password: params.password,
      configUrl: params.configUrl,
      config: params.config,
    },
    deps,
  );

  if (result.type !== 'VERIFY_EMAIL_SET_PASSWORD') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_TYPE');
  }

  return { userId: result.userId };
}
