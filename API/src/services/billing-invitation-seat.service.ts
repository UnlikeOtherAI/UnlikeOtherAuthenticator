import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { runAnniversarySeatCycle } from './billing-anniversary-seat-scheduler.service.js';
import { assertNessieCardOnFile } from './billing-nessie-card-admission.service.js';

/** The tenant read runs after the invitation transaction commits, before provider IO. */
export async function invitationFundingRequest(prisma: PrismaClient, inviteId: string) {
  const invitation = await prisma.teamInvite.findUnique({ where: { id: inviteId,
    acceptedAt: null, declinedAt: null, revokedAt: null, approvalStatus: { in: ['APPROVED', 'NOT_REQUIRED'] },
  }, select: {
    orgId: true, teamId: true, billingSeatRequired: true, billingSeatSourceInviteId: true,
  } });
  if (!invitation) throw new AppError('NOT_FOUND', 404);
  // The current replacement can be live while its original seat owner is revoked as REPLACED.
  // Read payment for the delivery invitation; keep the original id for any collection work.
  const funded = invitation.billingSeatRequired && await isInvitationFunded(prisma, inviteId);
  return { ...invitation, funded, inviteId: invitation.billingSeatSourceInviteId ?? inviteId };
}

export async function collectInvitationPayment(invitation: Awaited<ReturnType<typeof invitationFundingRequest>>, deps?: {
  admin?: PrismaClient; collect?: typeof runAnniversarySeatCycle; cardOnFile?: typeof assertNessieCardOnFile;
}): Promise<void> {
  if (!invitation.billingSeatRequired || invitation.funded) return;
  const admin = deps?.admin ?? getAdminPrisma();
  await (deps?.cardOnFile ?? assertNessieCardOnFile)({ product: 'nessie',
    organisationId: invitation.orgId, teamId: invitation.teamId }, admin);
  await (deps?.collect ?? runAnniversarySeatCycle)({ prisma: admin, inviteId: invitation.inviteId });
}

async function isInvitationFunded(prisma: PrismaClient, inviteId: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT billing_invitation_seat_ready(${inviteId}) AS ready`;
  return row?.ready === true;
}

/** Recheck inside the token transaction. A prior funding read never grants delivery. */
export async function requireFundedInvitation(prisma: PrismaClient, inviteId: string): Promise<void> {
  if (!await isInvitationFunded(prisma, inviteId)) {
    throw new AppError('FORBIDDEN', 402, 'BILLING_SEAT_PAYMENT_REQUIRED');
  }
}
