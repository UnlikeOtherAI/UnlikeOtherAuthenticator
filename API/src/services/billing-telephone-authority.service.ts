import type { Prisma } from '@prisma/client';
import type { BillingSubjectRequest } from '@unlikeotherai/billing-statement-protocol';
import { AppError } from '../utils/errors.js';
import { isBillingManager } from './billing-stripe-manager.service.js';
export { prepaidAppSubject as telephoneSubject, verifyPrepaidAppActor as verifyTelephoneActor,
  lockPrepaidAppCredential as lockTelephoneCredential, lockPrepaidAppSubject as lockTelephoneSubject,
} from './billing-prepaid-app-authority.service.js';

export async function assertTelephoneTeamManager(tx: Prisma.TransactionClient, subject: BillingSubjectRequest): Promise<void> {
  const [org, team] = await Promise.all([
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId: subject.organisation_id, userId: subject.user_id } },
      select: { role: true } }),
    tx.teamMember.findUnique({ where: { teamId_userId: { teamId: subject.team_id, userId: subject.user_id } },
      select: { teamRole: true } }),
  ]);
  if (!org || !isBillingManager({ scope: 'TEAM', orgRole: org.role, teamRole: team?.teamRole })) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_MANAGEMENT_NOT_AUTHORIZED');
  }
}
