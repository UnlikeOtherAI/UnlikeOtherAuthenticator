import { BillingAssignmentScope, MembershipStatus, type PrismaClient } from '@prisma/client';

import {
  BILLING_ORG_BILLING_MANAGE_ACTION_ID,
  type BillingControlledByV1,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

/**
 * Who pays for a team's usage, and who may say so.
 *
 * `Docs/plans/2026-08-15-org-billing-override.md`. An organisation may take
 * billing over from all of its teams, across every service. The record is
 * org-wide rather than per-product on purpose: the ask is one bill for the
 * whole organisation.
 *
 * Absent or inactive is today's behaviour exactly, which is what makes
 * shipping this inert.
 */
export type BillingOrgResponsibilityState = {
  organisationId: string;
  active: boolean;
  organisationName: string;
  assumedAt: Date | null;
};

export async function resolveOrgBillingResponsibility(
  params: { organisationId: string },
  deps?: { prisma?: PrismaClient },
): Promise<BillingOrgResponsibilityState> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const organisation = await prisma.organisation.findUnique({
    where: { id: params.organisationId },
    select: {
      name: true,
      billingOrgResponsibility: { select: { active: true, assumedAt: true } },
    },
  });
  const responsibility = organisation?.billingOrgResponsibility ?? null;
  return {
    organisationId: params.organisationId,
    active: responsibility?.active === true,
    organisationName: organisation?.name ?? '',
    assumedAt: responsibility?.active === true ? responsibility.assumedAt : null,
  };
}

/**
 * Is this caller an ORGANISATION billing manager?
 *
 * Deliberately the existing primitive with the organisation scope, not a new
 * rule: `isBillingManager` returns true for a team owner/admin only at TEAM
 * scope, so an organisation question is answered by organisation roles alone.
 * A team billing manager keeps the role and simply has nothing to manage while
 * the override is on — which is what `can_manage: false` says on their surface.
 */
export async function isOrganisationBillingManager(
  params: { organisationId: string; userId: string },
  deps?: { prisma?: PrismaClient },
): Promise<boolean> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const membership = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: params.organisationId, userId: params.userId } },
    select: { role: true, status: true },
  });
  if (membership?.status !== MembershipStatus.ACTIVE) return false;
  return isBillingManager({
    scope: BillingAssignmentScope.ORGANISATION,
    orgRole: membership.role,
  });
}

/**
 * UOA composes this sentence, never the product. A product renders `message`
 * verbatim and offers the one action UOA names — the same rule that already
 * governs every action label and disabled reason in the contract.
 */
export function buildBillingControlledBy(params: {
  organisationId: string;
  organisationName: string;
  canManage: boolean;
}): BillingControlledByV1 {
  const organisation = params.organisationName.trim() || 'this organisation';
  return {
    scope: 'organisation',
    organisation_id: params.organisationId,
    organisation_name: organisation,
    message: params.canManage
      ? `Billing for this workspace is managed for the whole of ${organisation}. Open organisation billing to see spend, credits, payment method and invoices for every team.`
      : `Billing for this workspace is managed for the whole of ${organisation}. An organisation billing manager looks after spend, credits and payment.`,
    can_manage: params.canManage,
    manage_action_id: params.canManage ? BILLING_ORG_BILLING_MANAGE_ACTION_ID : null,
  };
}

/**
 * The one place a caller-facing surface asks "is this team's billing taken
 * over, and may this caller manage it?". Returns null when it is not, so a
 * statement or credits view simply omits the block.
 */
export async function resolveBillingControlledBy(
  params: { organisationId: string; userId: string },
  deps?: { prisma?: PrismaClient },
): Promise<BillingControlledByV1 | null> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const responsibility = await resolveOrgBillingResponsibility(params, { prisma });
  if (!responsibility.active) return null;
  const canManage = await isOrganisationBillingManager(params, { prisma });
  return buildBillingControlledBy({
    organisationId: responsibility.organisationId,
    organisationName: responsibility.organisationName,
    canManage,
  });
}
