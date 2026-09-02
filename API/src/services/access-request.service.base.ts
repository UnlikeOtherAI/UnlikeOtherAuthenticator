import type { AccessRequestStatus, PrismaClient } from '@prisma/client';
import type { ClientConfig } from './config.service.js';

import { getEnv } from '../config/env.js';
import { extractEmailDomain } from '../utils/email-domain.js';
import { AppError } from '../utils/errors.js';
import {
  assertDatabaseEnabled,
  ensureOrgRole,
  memberAvatarImageUrl,
  normalizeDomain,
  parseOrgFeatureRoles,
  parseOrgLimit,
  resolveOrganisationByDomain,
} from './organisation.service.base.js';
import {
  normalizeTeamRole,
  parseMaxMembersPerTeam,
  parseMaxTeamMembershipsPerUser,
} from './team.service.base.js';

export type AccessRequestPrisma = PrismaClient;

export type AccessRequestRecord = {
  id: string;
  orgId: string;
  teamId: string;
  email: string;
  requestName: string | null;
  status: Lowercase<AccessRequestStatus>;
  requestedAt: Date;
  lastRequestedAt: Date;
  reviewedAt: Date | null;
  reviewReason: string | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  userId: string | null;
  reviewedByUserId: string | null;
  // Docs/Auth/avatars.md §9 — the requester's avatar; null until the request is tied to a UOA
  // user. `reviewedByUserId` surfaces no name/email, so it deliberately gets no URL.
  avatarImageUrl: string | null;
};

type AccessRequestRow = Omit<AccessRequestRecord, 'status' | 'avatarImageUrl'> & {
  status: AccessRequestStatus;
};

export function toAccessRequestRecord(row: AccessRequestRow, domain: string): AccessRequestRecord {
  return {
    ...row,
    status: row.status.toLowerCase() as AccessRequestRecord['status'],
    avatarImageUrl: row.userId ? memberAvatarImageUrl(domain, row.userId) : null,
  };
}

export function normalizeRequestName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) throw new AppError('BAD_REQUEST', 400);
  return trimmed;
}

export function normalizeAccessRequestStatus(value?: string): AccessRequestStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'PENDING' || normalized === 'APPROVED' || normalized === 'REJECTED') {
    return normalized;
  }
  throw new AppError('BAD_REQUEST', 400);
}

export function assertAccessRequestsEnabled(config: ClientConfig): void {
  if (!config.access_requests?.enabled) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

export function assertConfiguredAccessTarget(params: {
  config: ClientConfig;
  orgId: string;
  teamId: string;
}): void {
  assertAccessRequestsEnabled(params.config);
  if (
    params.config.access_requests?.target_org_id !== params.orgId ||
    params.config.access_requests?.target_team_id !== params.teamId
  ) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Resolve the `(orgId, teamId)` an access-request admin route was called with,
 * and refuse anything that is not this domain's own.
 *
 * `assertConfiguredAccessTarget` alone is NOT a tenant boundary. It compares the
 * path ids against `access_requests.target_org_id`/`target_team_id` — values
 * that come from the CALLER'S OWN signed config, which the caller authors. A
 * domain can therefore sign a perfectly valid config naming another tenant's
 * org and team, pass that check with its own bearer and `?domain=`, and reach
 * another tenant's rows.
 *
 * RLS is no backstop here either: the `access_requests` policies key on
 * `app.org_id`, which these routes populate from the raw path `:orgId`, and
 * (before the accompanying migration) never consulted `app.domain`.
 *
 * So the ids are resolved the same way every other `/org/*` route resolves
 * them — org by `(id, domain)`, team by `(id, orgId)` — and a target on another
 * domain is a 404, exactly as if it did not exist.
 */
export async function resolveConfiguredAccessTarget(params: {
  prisma: AccessRequestPrisma;
  config: ClientConfig;
  orgId: string;
  teamId: string;
}): Promise<void> {
  assertConfiguredAccessTarget({
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const org = await resolveOrganisationByDomain(
    params.prisma as unknown as Parameters<typeof resolveOrganisationByDomain>[0],
    { orgId: params.orgId, domain: params.config.domain },
  );

  const team = await params.prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404);
}

export function isAutoGrantDomain(params: { email: string; config: ClientConfig }): boolean {
  const domains = params.config.access_requests?.auto_grant_domains;
  if (!domains?.length) return false;

  const emailDomain = extractEmailDomain(params.email);
  if (!emailDomain) return false;
  return domains.includes(emailDomain);
}

export function buildAdminReviewUrl(config: ClientConfig): string {
  const configured = config.access_requests?.admin_review_url?.trim();
  if (configured) {
    return configured;
  }

  return `https://${normalizeDomain(config.domain)}/`;
}

export async function resolveAccessTarget(params: {
  prisma: AccessRequestPrisma;
  config: ClientConfig;
}): Promise<{
  org: { id: string; name: string; domain: string };
  team: { id: string; name: string; joinPolicy: string };
}> {
  const orgId = params.config.access_requests?.target_org_id;
  const teamId = params.config.access_requests?.target_team_id;
  if (!orgId || !teamId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const org = await resolveOrganisationByDomain(params.prisma, {
    orgId,
    domain: params.config.domain,
  });
  const team = await params.prisma.team.findFirst({
    where: {
      id: teamId,
      orgId: org.id,
    },
    select: {
      id: true,
      name: true,
      joinPolicy: true,
    },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  return {
    org: { id: org.id, name: org.name, domain: org.domain },
    team,
  };
}

export async function ensureUserAssignedToConfiguredAccessTarget(params: {
  prisma: AccessRequestPrisma;
  config: ClientConfig;
  userId: string;
  now: Date;
}): Promise<void> {
  const { org, team } = await resolveAccessTarget({
    prisma: params.prisma,
    config: params.config,
  });

  ensureOrgRole('member', parseOrgFeatureRoles(params.config));

  const existingMembershipInOrganisation = await params.prisma.orgMember.findFirst({
    where: {
      userId: params.userId,
      orgId: org.id,
    },
    select: { id: true, orgId: true },
  });

  if (!existingMembershipInOrganisation) {
    const memberCount = await params.prisma.orgMember.count({
      where: { orgId: org.id },
    });
    if (memberCount >= parseOrgLimit(params.config)) {
      throw new AppError('BAD_REQUEST', 400);
    }

    await params.prisma.orgMember.create({
      data: {
        orgId: org.id,
        userId: params.userId,
        role: 'member',
      },
      select: { id: true },
    });
  }

  const existingTeamMembership = await params.prisma.teamMember.findFirst({
    where: {
      teamId: team.id,
      userId: params.userId,
    },
    select: { id: true },
  });
  if (existingTeamMembership) {
    return;
  }

  const teamMemberCount = await params.prisma.teamMember.count({
    where: { teamId: team.id },
  });
  if (teamMemberCount >= parseMaxMembersPerTeam(params.config)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const teamMembershipCount = await params.prisma.teamMember.count({
    where: {
      userId: params.userId,
      team: { orgId: org.id },
    },
  });
  if (teamMembershipCount >= parseMaxTeamMembershipsPerUser(params.config)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await params.prisma.teamMember.create({
    data: {
      teamId: team.id,
      userId: params.userId,
      teamRole: normalizeTeamRole(undefined, params.config),
    },
    select: { id: true },
  });
}

export { getEnv, assertDatabaseEnabled };
