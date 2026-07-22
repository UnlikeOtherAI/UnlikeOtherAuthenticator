import type { PrismaClient } from '@prisma/client';

import { lockRefreshSessionUser } from './refresh-session-lock.service.js';

export type VerificationTokenEpochProof = {
  tokenVersion: number | null;
  userId: string | null;
  userKey: string;
};

export type VerificationTokenEpochResolution =
  | { kind: 'registration' }
  | { credentialEpoch: number; kind: 'user'; userId: string };

type VerificationTokenEpochReadPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique'>;
};

type VerificationTokenEpochPrisma = VerificationTokenEpochReadPrisma &
  Pick<PrismaClient, '$queryRaw'>;

const resolveVerificationTokenEpoch = async (
  prisma: VerificationTokenEpochReadPrisma,
  proof: VerificationTokenEpochProof,
): Promise<VerificationTokenEpochResolution | null> => {
  if (proof.userId === null && proof.tokenVersion === null) {
    const existing = await prisma.user.findUnique({
      where: { userKey: proof.userKey },
      select: { id: true },
    });
    return existing ? null : { kind: 'registration' };
  }

  if (proof.userId === null || proof.tokenVersion === null) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: proof.userId },
    select: { id: true, tokenVersion: true, userKey: true },
  });
  if (!user || user.userKey !== proof.userKey || user.tokenVersion !== proof.tokenVersion) {
    return null;
  }

  return {
    credentialEpoch: proof.tokenVersion,
    kind: 'user',
    userId: proof.userId,
  };
};

/** Read-only preflight for landing pages; every mutation must use the locked form below. */
export const readVerificationTokenEpoch = (
  prisma: VerificationTokenEpochReadPrisma,
  proof: VerificationTokenEpochProof,
): Promise<VerificationTokenEpochResolution | null> => resolveVerificationTokenEpoch(prisma, proof);

/**
 * Linearize an existing-user capability with credential reset/revocation, then
 * compare its immutable issue-time epoch. Pre-user registration has no user
 * identity to lock and remains valid only while that userKey does not exist.
 */
export const lockAndReadVerificationTokenEpoch = async (
  prisma: VerificationTokenEpochPrisma,
  proof: VerificationTokenEpochProof,
  afterUserLock?: () => Promise<void>,
): Promise<VerificationTokenEpochResolution | null> => {
  if (proof.userId !== null) {
    await lockRefreshSessionUser(proof.userId, { prisma });
    await afterUserLock?.();
  }
  return resolveVerificationTokenEpoch(prisma, proof);
};
