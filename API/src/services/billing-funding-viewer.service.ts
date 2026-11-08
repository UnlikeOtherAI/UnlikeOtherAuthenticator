import { MembershipStatus, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { isOrganisationBillingManager } from './billing-org-responsibility.service.js';
import { isCurrentOrganisationManager } from './organisation-team-authority.service.js';
import { activeAuthorityUserWhere } from './organisation-team-authority.service.js';

export type BillingFundingViewer = {
  userId: string;
  displayName: string;
  organisationId: string;
  teamId: string;
  organisationRole: string;
  teamRole: string;
  billingManager: boolean;
};
export type OrganisationBillingFundingViewer = Omit<BillingFundingViewer,'teamId'> & { teamId: string | null };

export function resolveBillingFundingViewer(params: { userId: string; organisationId: string; teamId: string },
  deps?: { prisma?: PrismaClient }): Promise<BillingFundingViewer>;
export function resolveBillingFundingViewer(params: { userId: string; organisationId: string; teamId: string | null },
  deps?: { prisma?: PrismaClient }): Promise<OrganisationBillingFundingViewer>;

export async function resolveBillingFundingViewer(
  params: { userId: string; organisationId: string; teamId: string | null },
  deps?: { prisma?: PrismaClient },
): Promise<OrganisationBillingFundingViewer> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [user, team, organisationMembership, teamMembership] = await Promise.all([
    prisma.user.findUnique({
      where: { ...activeAuthorityUserWhere(), id: params.userId },
      select: { id: true, name: true },
    }),
    params.teamId === null ? prisma.organisation.findFirst({ where: {
      id: params.organisationId,lifecycleStatus:'ACTIVE' },select:{id:true,ownerId:true} }) : prisma.team.findFirst({
      where: {
        id: params.teamId,
        orgId: params.organisationId,
        lifecycleStatus: 'ACTIVE',
        org: { lifecycleStatus: 'ACTIVE' },
      },
      select: { id: true },
    }),
    prisma.orgMember.findUnique({
      where: {
        orgId_userId: { orgId: params.organisationId, userId: params.userId },
      },
      select: { role: true, status: true,org:{select:{ownerId:true}} },
    }),
    params.teamId === null ? Promise.resolve(null) : prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: params.teamId, userId: params.userId } },
      select: { teamRole: true, status: true },
    }),
  ]);
  if (
    !user ||
    !team ||
    organisationMembership?.status !== MembershipStatus.ACTIVE ||
    (params.teamId !== null && teamMembership?.status !== MembershipStatus.ACTIVE &&
      !(organisationMembership&&isCurrentOrganisationManager(organisationMembership,params.userId)))
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }
  // A null actor team is an explicit org-manager branch, never a missing-team fallback.
  if (params.teamId === null && !['owner','admin'].includes(organisationMembership.role) &&
    !('ownerId' in team && team.ownerId===params.userId)) {
    throw new AppError('FORBIDDEN',403,'BILLING_MANAGER_REQUIRED');
  }
  return {
    userId: user.id,
    displayName: user.name ?? 'Team member',
    organisationId: params.organisationId,
    teamId: params.teamId,
    organisationRole: organisationMembership.role,
    teamRole: teamMembership?.teamRole ?? '',
    billingManager: await isOrganisationBillingManager(params, { prisma }),
  };
}
