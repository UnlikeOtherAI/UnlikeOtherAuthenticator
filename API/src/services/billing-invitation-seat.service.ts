import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { runAnniversarySeatCycle } from './billing-anniversary-seat-scheduler.service.js';
import { assertNessieCardOnFile } from './billing-nessie-card-admission.service.js';

/** The tenant read runs after the invitation transaction commits, before provider IO. */
export async function invitationFundingRequest(prisma: PrismaClient, inviteId: string) {
  const invitation = await prisma.teamInvite.findUnique({ where: { id: inviteId }, select: {
    orgId: true, teamId: true, billingSeatRequired: true, billingSeatSourceInviteId: true,
  } });
  if (!invitation) throw new AppError('NOT_FOUND', 404);
  return { ...invitation, inviteId: invitation.billingSeatSourceInviteId ?? inviteId };
}

export async function collectInvitationPayment(invitation: Awaited<ReturnType<typeof invitationFundingRequest>>, deps?: {
  admin?: PrismaClient; collect?: typeof runAnniversarySeatCycle; cardOnFile?: typeof assertNessieCardOnFile;
}): Promise<void> {
  if (!invitation.billingSeatRequired) return;
  const admin = deps?.admin ?? getAdminPrisma();
  await (deps?.cardOnFile ?? assertNessieCardOnFile)({ product: 'nessie',
    organisationId: invitation.orgId, teamId: invitation.teamId }, admin);
  await (deps?.collect ?? runAnniversarySeatCycle)({ prisma: admin, inviteId: invitation.inviteId });
}

/** Recheck inside the token transaction. A UI notice or pending collection never grants a capability. */
export async function requireFundedInvitation(prisma: PrismaClient, inviteId: string): Promise<void> {
  const [row] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT billing_invitation_seat_ready(${inviteId}) AS ready`;
  if (row?.ready !== true) throw new AppError('FORBIDDEN', 402, 'BILLING_SEAT_PAYMENT_REQUIRED');
}
