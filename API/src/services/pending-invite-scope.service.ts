import type { Prisma } from '@prisma/client';

import type { ProductTeamPolicy } from './product-team-policy.service.js';

/**
 * Which `TeamInvite` rows are a pending invitation FOR THE INVITEE, and from which organisations.
 *
 * One module because the two surfaces that answer that question — the hosted chooser
 * (`first-login.service.ts` `buildSessionChoices`) and the product's sidebar
 * (`team-directory.service.ts` `buildSidebarPendingInvites`) — must answer it identically. They
 * did not: the sidebar dropped every invitation outside the caller's signed-in organisation,
 * which is the defect this exists to prevent recurring. A person who is offered an invitation at
 * sign-in must find that same invitation in the product, and vice versa.
 */

/**
 * The "is this TeamInvite row still a real pending invite" predicate (design §4.7): unaccepted,
 * undeclined, unrevoked, and not expired. This is the single source of truth for that eligibility
 * check — `buildFirstLoginBlock`, `buildSessionChoices` (the chooser), the `/org/me` sidebar, and
 * the "Invited" tab (`team-invite.service.invited.ts`) all compose it with their own scoping
 * rather than duplicating it.
 *
 * `includePendingApproval` defaults to false, matching the historical chooser/firstLogin behaviour:
 * an invite still awaiting member-invite approval (design §4.7 Phase 4) is not yet a real pending
 * invite FOR THE INVITEE. The "Invited" tab (an admin's view) passes `true` — an admin managing
 * invites must see ones still awaiting their own approval.
 */
export function pendingInviteStatusWhere(params: {
  now: Date;
  includePendingApproval?: boolean;
}): Prisma.TeamInviteWhereInput {
  return {
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    approvalStatus: params.includePendingApproval
      ? { in: ['NOT_REQUIRED', 'APPROVED', 'PENDING'] }
      : { in: ['NOT_REQUIRED', 'APPROVED'] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: params.now } }],
  };
}

/**
 * The organisations an invitation may be reported from, as a `TeamInvite` filter.
 *
 * Deliberately the same reach `buildSidebarTeams` gives the team directory: every organisation on
 * this product's domain, plus — only for a product the server mapped to
 * `all_active_memberships` — every organisation the caller already holds an ACTIVE membership in,
 * which is where an invitation to a *second* team of an organisation founded through another
 * product domain lives.
 */
export function inviteOrgReach(params: {
  userId: string;
  domain: string;
  policy: ProductTeamPolicy;
}): Prisma.TeamInviteWhereInput {
  const reach: Prisma.TeamInviteWhereInput[] = [{ org: { domain: params.domain } }];
  if (params.policy.scope === 'all_active_memberships') {
    reach.push({
      org: { members: { some: { userId: params.userId, status: 'ACTIVE' } } },
    });
  }
  return { OR: reach };
}

/**
 * The complete filter both surfaces use: this caller's own address, the eligibility predicate,
 * and the product's organisation reach.
 *
 * `AND`, never a spread: `pendingInviteStatusWhere` carries its own top-level `OR` (the "no
 * expiry, or not yet expired" pair), and spreading the reach's `OR` beside it would overwrite
 * that key and quietly re-admit expired invitations.
 */
export function pendingInviteWhereForCaller(params: {
  email: string;
  userId: string;
  domain: string;
  policy: ProductTeamPolicy;
  now: Date;
}): Prisma.TeamInviteWhereInput {
  return {
    AND: [
      { email: params.email },
      pendingInviteStatusWhere({ now: params.now }),
      inviteOrgReach({ userId: params.userId, domain: params.domain, policy: params.policy }),
    ],
  };
}
