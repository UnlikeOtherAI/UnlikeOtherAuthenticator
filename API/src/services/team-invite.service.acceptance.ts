import type { Prisma } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { AppError } from '../utils/errors.js';
import {
  ensureOrgRole,
  normalizeDomain,
  parseOrgFeatureRoles,
  parseOrgLimit,
} from './organisation.service.base.js';
import {
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
} from './team.service.base.js';

export async function acceptTeamInviteWithinTransaction(params: {
  prisma: Prisma.TransactionClient;
  teamInviteId: string;
  userId: string;
  config: ClientConfig;
  now: Date;
}): Promise<void> {
  const invite = await params.prisma.teamInvite.findUnique({
    where: { id: params.teamInviteId },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      inviteName: true,
      teamRole: true,
      acceptedUserId: true,
      acceptedAt: true,
      revokedAt: true,
      org: {
        select: {
          id: true,
          domain: true,
        },
      },
    },
  });

  if (!invite || invite.revokedAt) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (normalizeDomain(invite.org.domain) !== normalizeDomain(params.config.domain)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (invite.acceptedAt) {
    if (invite.acceptedUserId === params.userId) {
      return;
    }
    throw new AppError('BAD_REQUEST', 400);
  }

  const user = await params.prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (!user.name && invite.inviteName) {
    await params.prisma.user.update({
      where: { id: params.userId },
      data: { name: invite.inviteName },
    });
  }

  ensureOrgRole('member', parseOrgFeatureRoles(params.config));

  const existingMembershipInDomain = await params.prisma.orgMember.findFirst({
    where: {
      userId: params.userId,
      org: {
        domain: invite.org.domain,
      },
    },
    select: {
      id: true,
      orgId: true,
    },
  });

  if (existingMembershipInDomain && existingMembershipInDomain.orgId !== invite.orgId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (!existingMembershipInDomain) {
    const memberCount = await params.prisma.orgMember.count({
      where: { orgId: invite.orgId },
    });
    if (memberCount >= parseOrgLimit(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }

    await params.prisma.orgMember.create({
      data: {
        orgId: invite.orgId,
        userId: params.userId,
        role: 'member',
      },
      select: { id: true },
    });
  }

  const existingTeamMembership = await params.prisma.teamMember.findFirst({
    where: {
      teamId: invite.teamId,
      userId: params.userId,
    },
    select: { id: true },
  });

  if (!existingTeamMembership) {
    const teamMemberCount = await params.prisma.teamMember.count({
      where: { teamId: invite.teamId },
    });
    if (teamMemberCount >= parseMaxMembersPerTeam(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const userMembershipCount = await params.prisma.teamMember.count({
      where: {
        userId: params.userId,
        team: {
          orgId: invite.orgId,
        },
      },
    });
    if (userMembershipCount >= parseMaxTeamMembershipsPerUser(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }

    await params.prisma.teamMember.create({
      data: {
        teamId: invite.teamId,
        userId: params.userId,
        teamRole: normalizeTeamRole(invite.teamRole),
      },
      select: { id: true },
    });
  }

  await params.prisma.teamInvite.update({
    where: { id: invite.id },
    data: {
      acceptedAt: params.now,
      acceptedUserId: params.userId,
    },
    select: { id: true },
  });
}
