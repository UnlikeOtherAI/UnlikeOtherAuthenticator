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

/** Recheck old mailbox/social proofs when a later claim/link changes account authority.
 * A completed personal UOA factor is independent; upstream AMR never qualifies. */
export async function assertIndependentSourceStillAdmitted(input: {
  userId: string; methods: readonly string[]; personalFactorCompleted: boolean;
}, db: MailboxAdmissionDb): Promise<void> {
  if (input.personalFactorCompleted) return;
  const mailboxSources = ['email_code', 'email_registration', 'email_link', 'login_link', 'verify_email',
    'verify_email_set_password', 'google', 'apple', 'facebook', 'github', 'linkedin', 'x'];
  if (input.methods.some(method => mailboxSources.includes(method))) await assertMailboxCredentialAdmission(input.userId, db);
}
