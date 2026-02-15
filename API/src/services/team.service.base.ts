import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  getOrganisationMember,
  resolveOrganisationByDomain,
  toListLimit,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  isP2002Error,
} from './organisation.service.base.js';

export type TeamRecord = {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamMemberRecord = {
  id: string;
  teamId: string;
  userId: string;
  teamRole: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamWithMembersRecord = TeamRecord & {
  members: TeamMemberRecord[];
};

const ALLOWED_TEAM_ROLES = new Set(['member', 'lead']);

export function normalizeTeamName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

export function normalizeTeamDescription(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length > 500) throw new AppError('BAD_REQUEST', 400);
  return trimmed === '' ? null : trimmed;
}

export function normalizeTeamRole(value: string | undefined): string {
  const role = value?.trim() ?? 'member';
  if (!ALLOWED_TEAM_ROLES.has(role)) throw new AppError('BAD_REQUEST', 400);
  return role;
}

export function isTeamManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export function parseMaxTeamsPerOrg(config: ClientConfig): number {
  return config.org_features?.max_teams_per_org ?? 100;
}

export function parseMaxMembersPerTeam(config: ClientConfig): number {
  return config.org_features?.max_members_per_team ?? 200;
}

export function parseMaxTeamMembershipsPerUser(config: ClientConfig): number {
  return config.org_features?.max_team_memberships_per_user ?? 50;
}

export function toTeamRecord(row: {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): TeamRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    groupId: row.groupId,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTeamMemberRecord(row: {
  id: string;
  teamId: string;
  userId: string;
  teamRole: string;
  createdAt: Date;
  updatedAt: Date;
}): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    teamRole: row.teamRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function requireTeamManager(
  prisma: OrgServicePrisma,
  orgId: string,
  userId: string,
): Promise<void> {
  const actorMembership = await getOrganisationMember(prisma, { orgId, userId });
  if (!actorMembership || !isTeamManager(actorMembership.role)) {
    throw new AppError('FORBIDDEN', 403);
  }
}

export async function resolveAndAuthorizeTeamOrg(
  prisma: OrgServicePrisma,
  params: { orgId: string; domain: string; actorUserId?: string },
): Promise<{
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}> {
  const org = await resolveOrganisationByDomain(prisma, {
    orgId: params.orgId,
    domain: params.domain,
  });

  if (!params.actorUserId) return org;

  const actorMembership = await getOrganisationMember(prisma, {
    orgId: org.id,
    userId: params.actorUserId,
  });
  if (!actorMembership) {
    throw new AppError('FORBIDDEN', 403);
  }

  return org;
}

export {
  assertDatabaseEnabled,
  getEnv,
  getOrganisationMember,
  getPrisma,
  isP2002Error,
  toListLimit,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
};
