import type { ClientConfig } from './config.service.js';
import type { InviteLinkDeps, InviteLinkPrisma } from './team-invite-link.service.js';
import type { OrgActorProvenance } from './organisation.service.base.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  normalizeDomain,
  ensureOrgRole,
  parseOrgFeatureRoles,
  parseOrgLimit,
} from './organisation.service.base.js';
import {
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
} from './team.service.base.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { withDirectoryMutation } from './directory-mutation.service.js';
import { assertActiveTeamMembership, lockTeamMembershipRows } from './team-scope.service.js';
import { findValidInviteLink } from './team-invite-link.lookup.js';

export type RedeemTeamInviteLinkResult = { teamId: string; orgId: string };

/**
 * The core join (Task 2). Only ever called on the verified-session path
 * (`POST /auth/select-team`, after the `login_token` bridge proves the email was already
 * verified) — a link never grants membership on its own. Atomically increments `useCount` with a
 * conditional `updateMany` (`useCount: { lt: maxUses }`) so concurrent redemptions can never push
 * `useCount` past `maxUses`.
 */
export async function redeemTeamInviteLink(
  params: {
    token: string;
    userId: string;
    actor?: OrgActorProvenance;
    domain: string;
    config: ClientConfig;
  },
  deps?: InviteLinkDeps,
): Promise<RedeemTeamInviteLinkResult> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const hashToken = deps?.hashToken ?? hashEmailToken;
  if (normalizeDomain(params.domain) !== params.config.domain)
    throw new AppError('BAD_REQUEST', 400);
  const tokenHash = hashToken(params.token, sharedSecret);

  const result = await runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyShared(tx);
    await lockRefreshSessionUser(params.userId, { prisma: tx });
    let decisionNow = deps?.now?.() ?? new Date();
    const { link, team } = await findValidInviteLink(tx, { tokenHash, now: decisionNow });
    const role = normalizeTeamRole(link.roleToAssign, params.config);
    if (role === 'owner') throw new AppError('BAD_REQUEST', 400);
    ensureOrgRole('member', parseOrgFeatureRoles(params.config));
    return withDirectoryMutation(
      tx,
      [
        {
          orgId: team.orgId,
          kind: 'membership.changed',
          subjectId: params.userId,
          teamId: team.id,
        },
      ],
      async (tx) => {
        await lockTeamMembershipRows(
          { userId: params.userId, orgId: team.orgId, teamId: team.id },
          { prisma: tx },
        );

        // Lock waits can cross expiry. Revalidate current link state before consumption.
        decisionNow = deps?.now?.() ?? new Date();
        await findValidInviteLink(tx, { tokenHash, now: decisionNow });

        // Atomic cap guard: only ONE concurrent redemption can win when useCount is one below
        // maxUses. `link.maxUses` is immutable (never updated after creation), so comparing against
        // the snapshot value read above is safe.
        const claimed = await tx.teamInviteLink.updateMany({
          where: {
            id: link.id,
            revokedAt: null,
            expiresAt: { gt: decisionNow },
            useCount: { lt: link.maxUses },
          },
          data: { useCount: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          throw new AppError('BAD_REQUEST', 400);
        }

        // Ensure membership in the target organisation. A user may independently belong to other
        // organisations on the same origin domain, so only this exact org membership is relevant.
        const existingMembershipInOrganisation = await tx.orgMember.findFirst({
          where: { userId: params.userId, orgId: team.orgId },
          select: { id: true, orgId: true, status: true },
        });
        if (
          existingMembershipInOrganisation &&
          existingMembershipInOrganisation.status !== 'ACTIVE'
        ) {
          throw new AppError('BAD_REQUEST', 400);
        }
        if (!existingMembershipInOrganisation) {
          if (
            (await tx.orgMember.count({ where: { orgId: team.orgId, status: 'ACTIVE' } })) >=
            parseOrgLimit(params.config)
          )
            throw new AppError('BAD_REQUEST', 400);
          await tx.orgMember.create({
            data: { orgId: team.orgId, userId: params.userId, role: 'member' },
            select: { id: true },
          });
        }

        // Add/reactivate the ACTIVE TeamMember row (Phase 2 lifecycle semantics). Idempotent when
        // already an ACTIVE member — the join still succeeds and returns the team.
        const existingTeamMembership = await tx.teamMember.findFirst({
          where: { teamId: team.id, userId: params.userId },
          select: { id: true, status: true },
        });

        if (existingTeamMembership?.status === 'DEACTIVATED')
          throw new AppError('BAD_REQUEST', 400, 'MEMBERSHIP_DEACTIVATED');
        if (existingTeamMembership?.status !== 'ACTIVE') {
          const memberCount = await tx.teamMember.count({
            where: { teamId: team.id, status: 'ACTIVE' },
          });
          const userCount = await tx.teamMember.count({
            where: { userId: params.userId, status: 'ACTIVE', team: { orgId: team.orgId } },
          });
          if (
            memberCount >= parseMaxMembersPerTeam(params.config) ||
            userCount >= parseMaxTeamMembershipsPerUser(params.config)
          )
            throw new AppError('BAD_REQUEST', 400);
        }
        let teamMemberId: string;
        if (!existingTeamMembership) {
          const created = await tx.teamMember.create({
            data: { teamId: team.id, userId: params.userId, teamRole: role },
            select: { id: true },
          });
          teamMemberId = created.id;
        } else {
          teamMemberId = existingTeamMembership.id;
          if (existingTeamMembership.status !== 'ACTIVE') {
            await tx.teamMember.update({
              where: { id: existingTeamMembership.id },
              data: { status: 'ACTIVE', statusChangedAt: decisionNow, teamRole: role },
            });
          }
        }

        await assertActiveTeamMembership(
          {
            userId: params.userId,
            orgId: team.orgId,
            teamId: team.id,
          },
          { prisma: tx },
        );

        return { teamId: team.id, orgId: team.orgId, teamMemberId };
      },
    );
  });

  await auditOrg(
    {
      orgId: result.orgId,
      actorUserId: params.userId,
      actor: params.actor,
      action: 'team_member.added',
      targetType: 'team_member',
      targetId: result.teamMemberId,
      metadata: { teamId: result.teamId, via: 'invite_link' },
    },
    { prisma },
  );

  return { teamId: result.teamId, orgId: result.orgId };
}
