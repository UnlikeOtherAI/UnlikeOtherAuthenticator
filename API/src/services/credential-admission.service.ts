import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { extractEmailDomain } from '../utils/email-domain.js';

/** Mailbox control cannot establish a global credential for a managed corporate identity.
 * Keep historical verified claims in this fence: a lapsed claim cannot reopen account takeover. */
type MailboxAdmissionDb = {
  externalIdentity: Pick<PrismaClient['externalIdentity'], 'findFirst'>;
  user: Pick<PrismaClient['user'], 'findUnique'>;
  organisationEmailDomain: Pick<PrismaClient['organisationEmailDomain'], 'findFirst'>;
};
export async function assertMailboxCredentialAdmission(userId: string, db: MailboxAdmissionDb): Promise<void> {
  if (await db.externalIdentity.findFirst({ where: { userId }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const emailDomain = user?.email ? extractEmailDomain(user.email) : null;
  if (emailDomain && await db.organisationEmailDomain.findFirst({
    where: { emailDomain, verifiedAt: { not: null } }, select: { id: true },
  })) throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
}
