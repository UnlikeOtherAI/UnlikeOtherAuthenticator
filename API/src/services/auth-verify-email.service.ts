import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { getAppLogger } from '../utils/app-logger.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { hashPassword } from './password.service.js';
import { ensureDomainRoleForUser } from './domain-role.service.js';
import { placeUserInConfiguredOrganisation } from './org-placement.service.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.service.js';
import { acceptTeamInviteWithinTransaction } from './team-invite.service.js';

type VerifyEmailPrisma = PrismaClient;

type VerifyEmailDeps = {
  env?: ReturnType<typeof getEnv>;
  now?: () => Date;
  sharedSecret?: string;
  hashEmailToken?: typeof hashEmailToken;
  hashPassword?: typeof hashPassword;
  prisma?: VerifyEmailPrisma;
  placeUserInConfiguredOrganisation?: typeof placeUserInConfiguredOrganisation;
  acceptTeamInviteWithinTransaction?: typeof acceptTeamInviteWithinTransaction;
  revokeAllRefreshTokensForUser?: typeof revokeAllRefreshTokensForUser;
};

type VerifyEmailTokenRow = Prisma.VerificationTokenGetPayload<{
  select: {
    id: true;
    type: true;
    userKey: true;
    email: true;
    domain: true;
    configUrl: true;
    userId: true;
    teamInviteId: true;
    expiresAt: true;
    usedAt: true;
  };
}>;

export type VerifyEmailTokenType = 'LOGIN_LINK' | 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL';

export type AcceptedEmailInviteWorkspace = {
  inviteId: string;
  orgId: string;
  teamId: string;
};

export type VerifyEmailResult = {
  userId: string;
  type: VerifyEmailTokenType;
  twoFaEnabled: boolean;
  acceptedInvite: AcceptedEmailInviteWorkspace | null;
};

function assertVerifyEmailTokenType(
  type: VerifyEmailTokenRow['type'],
): asserts type is VerifyEmailTokenType {
  if (type !== 'LOGIN_LINK' && type !== 'VERIFY_EMAIL_SET_PASSWORD' && type !== 'VERIFY_EMAIL') {
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

export async function validateVerifyEmailToken(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: { prisma?: VerifyEmailPrisma },
): Promise<VerifyEmailTokenType> {
  void params.config; // Included for future-proofing; configVerifier already validates domain integrity.
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }

  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const tokenHash = hashEmailToken(params.token, SHARED_SECRET);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as VerifyEmailPrisma);
  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      type: true,
      userKey: true,
      email: true,
      domain: true,
      configUrl: true,
      userId: true,
      teamInviteId: true,
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
): Promise<VerifyEmailResult> {
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
  const consumed = await runInTransaction(prisma, async (tx) => {
    const tokenRow = await tx.verificationToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        type: true,
        userKey: true,
        email: true,
        domain: true,
        configUrl: true,
        userId: true,
        teamInviteId: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    if (!tokenRow) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
    }

    const type = assertTokenValid({ token: tokenRow, configUrl: params.configUrl, now });

    let userId: string;
    let createdUser = false;
    // True only when this call wrote a new passwordHash onto a pre-existing user
    // (i.e. social-login / passwordless account adding a password). New users have
    // no pre-existing sessions to revoke.
    let setPasswordOnExistingUser = false;
    if (type === 'LOGIN_LINK') {
      // LOGIN_LINK proves possession of an existing account's mailbox; it must never
      // degrade into registration. Resolve only the user bound when the token was
      // minted, and fail closed if that account was deleted or its identity changed.
      if (!tokenRow.userId) {
        throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
      }
      const existingUser = await tx.user.findUnique({
        where: { id: tokenRow.userId },
        select: { id: true, userKey: true, email: true, domain: true },
      });
      if (
        !existingUser ||
        existingUser.userKey !== tokenRow.userKey ||
        existingUser.email.toLowerCase() !== tokenRow.email.toLowerCase() ||
        existingUser.domain !== tokenRow.domain
      ) {
        throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
      }
      userId = existingUser.id;
    } else if (type === 'VERIFY_EMAIL_SET_PASSWORD') {
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
        setPasswordOnExistingUser = true;
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
        createdUser = true;
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
        createdUser = true;
      }
    }

    // Brief 18: ensure a per-domain role exists for this domain.
    await ensureDomainRoleForUser({
      domain: params.config.domain,
      userId,
      prisma: tx,
    });

    let acceptedInvite: AcceptedEmailInviteWorkspace | null = null;
    if (tokenRow.teamInviteId) {
      const workspace = await (
        deps?.acceptTeamInviteWithinTransaction ?? acceptTeamInviteWithinTransaction
      )({
        prisma: tx,
        teamInviteId: tokenRow.teamInviteId,
        userId,
        config: params.config,
        now,
      });
      acceptedInvite = {
        inviteId: tokenRow.teamInviteId,
        orgId: workspace.orgId,
        teamId: workspace.teamId,
      };
    }

    const authenticatedUser = await tx.user.findUnique({
      where: { id: userId },
      select: { twoFaEnabled: true },
    });
    if (!authenticatedUser) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
    }

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

    return {
      userId,
      type,
      createdUser,
      setPasswordOnExistingUser,
      email: tokenRow.email,
      twoFaEnabled: authenticatedUser.twoFaEnabled,
      acceptedInvite,
    };
  });

  if (consumed.setPasswordOnExistingUser) {
    // N-L-1: a social-login / passwordless account that just got a password is a
    // credential change. Any refresh token issued before the password binding must
    // die. Done after the transaction commits so a revoke failure cannot roll back
    // the password write.
    await (deps?.revokeAllRefreshTokensForUser ?? revokeAllRefreshTokensForUser)(consumed.userId, {
      now: () => now,
    });
  }

  if (consumed.createdUser && !consumed.acceptedInvite) {
    try {
      await (deps?.placeUserInConfiguredOrganisation ?? placeUserInConfiguredOrganisation)({
        userId: consumed.userId,
        email: consumed.email,
        config: params.config,
      });
    } catch (err) {
      getAppLogger().error(
        {
          domain: params.config.domain,
          userId: consumed.userId,
          errorName: err instanceof Error ? err.name : 'unknown',
        },
        'failed while attempting automatic registration placement',
      );
    }
  }

  // An invite-bound token is both identity verification and an explicit workspace selection. Return
  // the exact accepted scope so callers can enforce its 2FA policy and carry it into the code.
  return {
    userId: consumed.userId,
    type: consumed.type,
    twoFaEnabled: consumed.twoFaEnabled,
    acceptedInvite: consumed.acceptedInvite,
  };
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
