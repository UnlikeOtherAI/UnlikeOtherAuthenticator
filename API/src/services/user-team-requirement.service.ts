import { Prisma, type PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import type { ClientConfig } from './config.service.js';
import {
  assertDatabaseEnabled,
  deriveSlugWithValidation,
  normalizeDomain,
} from './organisation.service.base.js';
import { deriveUniqueTeamSlug, parseMaxTeamsPerOrg } from './team.service.base.js';

type UserTeamRequirementPrisma = PrismaClient;
type UserTeamRequirementTx = Prisma.TransactionClient;

type UserTeamRequirementDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: UserTeamRequirementPrisma;
};

type UserIdentity = {
  id: string;
  email: string;
  name: string | null;
};

export type RequiredTeamPlacement = {
  orgId: string;
  teamId: string;
};

/**
 * Serialize the first placement decision for one stable UOA user. Product
 * choice resolution must take this lock before reading memberships, otherwise
 * two first-time product exchanges can both observe zero rows and create two
 * personal workspaces.
 */
export async function lockRequiredTeamPlacementUser(
  userId: string,
  deps: { prisma: Pick<PrismaClient, '$queryRaw'> },
): Promise<void> {
  await deps.prisma.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`uoa:required-team-placement:${userId}`}, 0)
      )::text AS "lockResult"
    `,
  );
}

function isUserNeedsTeamEnabled(config: ClientConfig): boolean {
  return config.org_features?.enabled === true && config.org_features?.user_needs_team === true;
}

function deriveDisplayName(user: UserIdentity): string {
  const fromName = user.name?.trim();
  if (fromName) return fromName.slice(0, 80);

  const localPart = user.email.split('@')[0]?.trim() ?? '';
  const normalized = localPart.replace(/[._-]+/g, ' ').trim();
  if (normalized) return normalized.slice(0, 80);

  return 'User';
}

function buildPersonalOrgName(user: UserIdentity): string {
  return deriveDisplayName(user).slice(0, 100);
}

function buildPersonalTeamName(user: UserIdentity): string {
  const base = deriveDisplayName(user);
  const suffix = "'s team";
  const trimmedBase = base.slice(0, Math.max(1, 100 - suffix.length)).trim();
  return `${trimmedBase}${suffix}`;
}

async function createPersonalOrgAndTeam(params: {
  tx: UserTeamRequirementTx;
  domain: string;
  user: UserIdentity;
}): Promise<RequiredTeamPlacement> {
  const orgName = buildPersonalOrgName(params.user);
  const teamName = buildPersonalTeamName(params.user);

  const slug = await deriveSlugWithValidation(params.domain, params.tx, orgName);
  const org = await params.tx.organisation.create({
    data: {
      domain: params.domain,
      name: orgName,
      slug,
      ownerId: params.user.id,
    },
    select: { id: true },
  });

  const team = await params.tx.team.create({
    data: {
      orgId: org.id,
      name: teamName,
      slug: await deriveUniqueTeamSlug({
        orgId: org.id,
        prisma: params.tx,
        name: teamName,
      }),
      isDefault: true,
    },
    select: { id: true },
  });

  await params.tx.orgMember.create({
    data: {
      orgId: org.id,
      userId: params.user.id,
      role: 'owner',
    },
  });

  await params.tx.teamMember.create({
    data: {
      teamId: team.id,
      userId: params.user.id,
      teamRole: 'admin',
    },
  });

  return { orgId: org.id, teamId: team.id };
}

async function createPersonalTeamForExistingOrg(params: {
  tx: UserTeamRequirementTx;
  config: ClientConfig;
  user: UserIdentity;
  orgMembership: { id: string; orgId: string; role: string; status: string };
}): Promise<RequiredTeamPlacement> {
  const teamCount = await params.tx.team.count({
    where: { orgId: params.orgMembership.orgId },
  });
  if (teamCount >= parseMaxTeamsPerOrg(params.config)) {
    throw new AppError('INTERNAL', 500, 'USER_NEEDS_TEAM_TEAM_LIMIT_REACHED');
  }

  const teamName = buildPersonalTeamName(params.user);
  const team = await params.tx.team.create({
    data: {
      orgId: params.orgMembership.orgId,
      name: teamName,
      slug: await deriveUniqueTeamSlug({
        orgId: params.orgMembership.orgId,
        prisma: params.tx,
        name: teamName,
      }),
      isDefault: false,
    },
    select: { id: true },
  });

  await params.tx.teamMember.create({
    data: {
      teamId: team.id,
      userId: params.user.id,
      teamRole: 'admin',
    },
  });

  if (
    params.orgMembership.role === 'member' &&
    params.config.org_features?.org_roles?.includes('admin')
  ) {
    await params.tx.orgMember.update({
      where: { id: params.orgMembership.id },
      data: { role: 'admin' },
    });
  }

  return { orgId: params.orgMembership.orgId, teamId: team.id };
}

export async function ensureUserHasRequiredTeam(
  params: {
    userId: string;
    config: ClientConfig;
  },
  deps?: UserTeamRequirementDeps,
): Promise<RequiredTeamPlacement | null> {
  if (!isUserNeedsTeamEnabled(params.config)) {
    return null;
  }

  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as UserTeamRequirementPrisma);
  const userId = params.userId.trim();
  const domain = normalizeDomain(params.config.domain);
  if (!userId || !domain) {
    return null;
  }

  return runInTransaction(prisma, async (tx) => {
    await lockRequiredTeamPlacementUser(userId, { prisma: tx });

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });
    if (!user) return null;

    const orgMembership = await tx.orgMember.findFirst({
      where: {
        userId,
        org: { domain },
      },
      select: {
        id: true,
        orgId: true,
        role: true,
        status: true,
      },
    });

    if (!orgMembership) {
      return createPersonalOrgAndTeam({
        tx,
        domain,
        user,
      });
    }

    // Lifecycle tombstones are an intentional denial, not an absence to heal
    // around. Creating a new workspace here would bypass deactivation/removal.
    if (orgMembership.status !== 'ACTIVE') return null;

    const teamMembershipCount = await tx.teamMember.count({
      where: {
        userId,
        team: {
          orgId: orgMembership.orgId,
        },
      },
    });
    if (teamMembershipCount > 0) {
      return null;
    }

    return createPersonalTeamForExistingOrg({
      tx,
      config: params.config,
      user,
      orgMembership,
    });
  });
}
