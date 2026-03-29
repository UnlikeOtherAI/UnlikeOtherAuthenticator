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
  slug: string;
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
const TEAM_SLUG_ALLOWED_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TEAM_SLUG_FALLBACK = 'team';
const MAX_TEAM_SLUG_LENGTH = 120;
const MAX_TEAM_SLUG_COLLISION_RETRIES = 10_000;

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

function normalizeTeamSlugBase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '');

  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  const base = slug || TEAM_SLUG_FALLBACK;
  const trimmed = base.slice(0, MAX_TEAM_SLUG_LENGTH).replace(/-+$/g, '');
  return trimmed.length >= 2 ? trimmed : TEAM_SLUG_FALLBACK;
}

function buildTeamSlugCandidate(base: string, suffix?: number): string {
  if (!suffix) return base;

  const suffixText = `-${suffix}`;
  const trimmedBase = base
    .slice(0, Math.max(1, MAX_TEAM_SLUG_LENGTH - suffixText.length))
    .replace(/-+$/g, '');

  const candidateBase = trimmedBase.length >= 2 ? trimmedBase : TEAM_SLUG_FALLBACK;
  return `${candidateBase}${suffixText}`;
}

export function normalizeTeamSlug(value: string): string {
  const slug = normalizeTeamSlugBase(value);
  if (slug.length < 2 || slug.length > MAX_TEAM_SLUG_LENGTH || !TEAM_SLUG_ALLOWED_RE.test(slug)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return slug;
}

export async function deriveUniqueTeamSlug(params: {
  orgId: string;
  prisma: Pick<OrgServicePrisma, 'team'>;
  name: string;
  existingSlugToIgnore?: string;
}): Promise<string> {
  const base = normalizeTeamSlugBase(params.name);
  const ignoredSlug = params.existingSlugToIgnore?.trim();

  for (let suffix = 0; suffix < MAX_TEAM_SLUG_COLLISION_RETRIES; suffix += 1) {
    const candidate = buildTeamSlugCandidate(base, suffix === 0 ? undefined : suffix + 1);
    if (candidate === ignoredSlug) {
      return candidate;
    }

    const existing = await params.prisma.team.findFirst({
      where: {
        orgId: params.orgId,
        slug: candidate,
      },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
  }

  throw new AppError('INTERNAL', 500, 'TEAM_SLUG_COLLISION_RETRY_EXHAUSTED');
}

export async function ensureAvailableTeamSlug(params: {
  orgId: string;
  prisma: Pick<OrgServicePrisma, 'team'>;
  slug: string;
  existingSlugToIgnore?: string;
}): Promise<string> {
  const candidate = normalizeTeamSlug(params.slug);
  if (candidate === params.existingSlugToIgnore?.trim()) {
    return candidate;
  }

  const existing = await params.prisma.team.findFirst({
    where: {
      orgId: params.orgId,
      slug: candidate,
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return candidate;
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
  slug: string;
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
    slug: row.slug,
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
