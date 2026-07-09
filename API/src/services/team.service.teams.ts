import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  deriveUniqueTeamSlug,
  ensureAvailableTeamSlug,
  normalizeIconUrl,
  normalizeTeamDescription,
  normalizeTeamJoinPolicy,
  normalizeTeamName,
  parseMaxTeamsPerOrg,
  requireTeamManager,
  resolveAndAuthorizeTeamOrg,
  toListLimit,
  toTeamMemberRecord,
  toTeamRecord,
  type CursorList,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type TeamRecord,
  type TeamWithMembersRecord,
  isP2002Error,
} from './team.service.base.js';
import { getTeamInvitedEntries, type TeamInvitedEntry } from './team-invite.service.invited.js';

const TEAM_SELECT = {
  id: true,
  orgId: true,
  groupId: true,
  name: true,
  slug: true,
  description: true,
  isDefault: true,
  joinPolicy: true,
  iconUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listTeams(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    limit?: number;
    cursor?: string;
  },
  deps?: OrgServiceDeps,
): Promise<CursorList<TeamRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  const limit = toListLimit(params.limit);
  const cursor = params.cursor?.trim();

  const rows = await prisma.team.findMany({
    where: {
      orgId: org.id,
      // HIDDEN teams are excluded from any org-member-visible listing unless the caller is already
      // an ACTIVE member of that specific team (design §4.6) — invite-only discovery is preserved.
      OR: [
        { NOT: { joinPolicy: 'HIDDEN' } },
        { members: { some: { userId: actorUserId, status: 'ACTIVE' } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: TEAM_SELECT,
  });

  const data = rows.slice(0, limit).map(toTeamRecord);
  const nextCursorRow = rows[limit];

  return { data, next_cursor: nextCursorRow ? nextCursorRow.id : null };
}

export async function createTeam(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    name: string;
    slug?: string;
    description?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<TeamRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const name = normalizeTeamName(params.name);
  const description = normalizeTeamDescription(params.description);
  const maxTeams = parseMaxTeamsPerOrg(params.config);

  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  await requireTeamManager(prisma, org.id, actorUserId);

  return await runInTransaction(prisma, async (tx) => {
    const teamCount = await tx.team.count({ where: { orgId: org.id } });
    if (teamCount >= maxTeams) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const slug = params.slug
      ? await ensureAvailableTeamSlug({
          orgId: org.id,
          prisma: tx,
          slug: params.slug,
        })
      : await deriveUniqueTeamSlug({
          orgId: org.id,
          prisma: tx,
          name,
        });

    try {
      const created = await tx.team.create({
        data: {
          orgId: org.id,
          name,
          slug,
          ...(description === undefined ? {} : { description }),
        },
        select: TEAM_SELECT,
      });

      return toTeamRecord(created);
    } catch (err) {
      if (isP2002Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }
  });
}

export async function getTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    // Task 2 (gapfix-a, design §11.4 "Invited" tab): `?include=invited` on the route. Undefined/false
    // leaves the response byte-identical to before this change (no `invited` key at all).
    includeInvited?: boolean;
  },
  deps?: OrgServiceDeps,
): Promise<TeamWithMembersRecord & { invited?: TeamInvitedEntry[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  const row = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: {
      ...TEAM_SELECT,
      members: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          teamId: true,
          userId: true,
          teamRole: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!row) {
    throw new AppError('NOT_FOUND', 404);
  }

  const result: TeamWithMembersRecord & { invited?: TeamInvitedEntry[] } = {
    ...toTeamRecord(row),
    members: row.members.map(toTeamMemberRecord),
  };

  if (params.includeInvited) {
    // Gated inside getTeamInvitedEntries to org/team owner/admin only — invite emails are PII, so a
    // plain member gets `invited: []` rather than the whole read failing with 403 (design gapfix-a
    // Task 2).
    result.invited = await getTeamInvitedEntries(
      { orgId: org.id, teamId: row.id, actorUserId },
      { prisma },
    );
  }

  return result;
}

export async function updateTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    name?: string;
    slug?: string;
    description?: string | null;
    joinPolicy?: string;
    iconUrl?: string | null;
  },
  deps?: OrgServiceDeps,
): Promise<TeamRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const hasUpdates =
    params.name !== undefined ||
    params.slug !== undefined ||
    params.description !== undefined ||
    params.joinPolicy !== undefined ||
    params.iconUrl !== undefined;
  if (!hasUpdates) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const data: Partial<{
    name: string;
    slug: string;
    description: string | null;
    joinPolicy: ReturnType<typeof normalizeTeamJoinPolicy>;
    iconUrl: string | null;
  }> = {};
  if (params.name !== undefined) {
    data.name = normalizeTeamName(params.name);
  }
  if (params.description !== undefined) {
    data.description = normalizeTeamDescription(params.description);
  }
  if (params.joinPolicy !== undefined) {
    data.joinPolicy = normalizeTeamJoinPolicy(params.joinPolicy);
  }
  if (params.iconUrl !== undefined) {
    // normalizeIconUrl(non-undefined) never returns undefined; the cast documents that narrowing
    // for TS (the function's general signature also accepts/returns undefined for the "omitted"
    // case, which can't happen on this branch).
    data.iconUrl = normalizeIconUrl(params.iconUrl) as string | null;
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const existing = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true, slug: true },
  });
  if (!existing) {
    throw new AppError('NOT_FOUND', 404);
  }

  if (params.slug !== undefined) {
    data.slug = await ensureAvailableTeamSlug({
      orgId: org.id,
      prisma,
      slug: params.slug,
      existingSlugToIgnore: existing.slug,
    });
  }

  try {
    const updated = await prisma.team.update({
      where: { id: existing.id },
      data,
      select: TEAM_SELECT,
    });

    return toTeamRecord(updated);
  } catch (err) {
    if (isP2002Error(err)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    throw err;
  }
}

export async function deleteTeam(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
  },
  deps?: OrgServiceDeps,
): Promise<{ deleted: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  if (!actorUserId) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveAndAuthorizeTeamOrg(prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });
  await requireTeamManager(prisma, org.id, actorUserId);

  const team = await prisma.team.findFirst({
    where: {
      id: params.teamId,
      orgId: org.id,
    },
    select: {
      id: true,
      isDefault: true,
    },
  });

  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  if (team.isDefault) {
    throw new AppError('BAD_REQUEST', 400);
  }

  await runInTransaction(prisma, async (tx) => {
    const defaultTeam = await tx.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    if (!defaultTeam) {
      throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
    }

    const members = await tx.teamMember.findMany({
      where: { teamId: team.id, status: 'ACTIVE' },
      select: { userId: true },
    });

    for (const member of members) {
      const userMembershipCount = await tx.teamMember.count({
        where: {
          userId: member.userId,
          team: {
            orgId: org.id,
          },
          status: 'ACTIVE',
        },
      });

      if (userMembershipCount <= 1) {
        await tx.teamMember.create({
          data: {
            teamId: defaultTeam.id,
            userId: member.userId,
          },
        });
      }
    }

    await tx.team.delete({ where: { id: team.id } });
  });

  return { deleted: true };
}
