import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** An IdP-controlled mailbox cannot add/reset a global credential on a linked UOA identity. */
export async function assertMailboxCredentialAdmission(userId: string,
  db: Pick<PrismaClient, 'externalIdentity'>): Promise<void> {
  if (await db.externalIdentity.findFirst({ where: { userId }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
  }
}
