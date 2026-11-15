import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { collectInvitationPayment, invitationFundingRequest } from '../../services/billing-invitation-seat.service.js';
import type { InviteDeliveryQueue, InvitePrisma } from '../../services/team-invite.service.base.js';

/** Retain the invitation and collection intent even when collection refuses or times out. */
export async function withInvitationDelivery<T>(request: FastifyRequest,
  prepare: (tx: Prisma.TransactionClient, afterCommit: InviteDeliveryQueue) => Promise<T>,
  authorize: (tx: Prisma.TransactionClient, inviteId: string) => Promise<void>): Promise<T> {
  const deliveries: Array<{ inviteId: string; deliver: (prisma: InvitePrisma) => Promise<void> }> = [];
  const result = await request.withTenantTx(tx => prepare(tx, (inviteId, deliver) => {
    deliveries.push({ inviteId, deliver });
  }));
  for (const { inviteId, deliver } of deliveries) {
    const funding = await request.withTenantTx(async tx => {
      await authorize(tx, inviteId);
      return invitationFundingRequest(asPrismaClient(tx), inviteId);
    });
    await collectInvitationPayment(funding);
    await request.withTenantTx(async tx => {
      await authorize(tx, inviteId);
      await deliver(asPrismaClient(tx));
    });
  }
  return result;
}
