import { BillingAssignmentScope, MembershipStatus, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

export type BillingFundingViewer = {
  userId: string;
  displayName: string;
  organisationId: string;
  teamId: string;
  organisationRole: string;
  teamRole: string;
  billingManager: boolean;
};

export async function resolveBillingFundingViewer(
  params: { userId: string; organisationId: string; teamId: string },
  deps?: { prisma?: PrismaClient },
): Promise<BillingFundingViewer> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [user, team, organisationMembership, teamMembership] = await Promise.all([
    prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, name: true },
    }),
    prisma.team.findFirst({
      where: { id: params.teamId, orgId: params.organisationId },
      select: { id: true },
    }),
    prisma.orgMember.findUnique({
      where: {
        orgId_userId: { orgId: params.organisationId, userId: params.userId },
      },
      select: { role: true, status: true },
    }),
    prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: params.teamId, userId: params.userId } },
      select: { teamRole: true, status: true },
    }),
  ]);
  if (
    !user ||
    !team ||
    organisationMembership?.status !== MembershipStatus.ACTIVE ||
    teamMembership?.status !== MembershipStatus.ACTIVE
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }
  return {
    userId: user.id,
    displayName: user.name ?? 'Team member',
    organisationId: params.organisationId,
    teamId: params.teamId,
    organisationRole: organisationMembership.role,
    teamRole: teamMembership.teamRole,
    billingManager: isBillingManager({
      scope: BillingAssignmentScope.TEAM,
      orgRole: organisationMembership.role,
      teamRole: teamMembership.teamRole,
    }),
  };
}
