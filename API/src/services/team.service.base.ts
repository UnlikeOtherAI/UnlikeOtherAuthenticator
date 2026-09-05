import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  resolveRoleGrants,
  resolveTeamRoleVocabulary,
  roleHoldsCapability,
  type UoaCapability,
} from './role-grants.js';

import {
  checkSlug,
  deriveSlugBase,
  isReservedLabel,
  randomSlugSuffix,
  withSlugSuffix,
} from '@unlikeotherai/slug';

import {
  assertDatabaseEnabled,
  getOrganisationMember,
  memberAvatarImageUrl,
  normalizeIconUrl,
  resolveOrgActor,
  resolveOrganisation,
  teamAvatarImageUrl,
  toListLimit,
  type CursorList,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
  isP2002Error,
} from './organisation.service.base.js';

export type TeamJoinPolicyValue =
  | 'INVITE_ONLY'
  | 'APPROVED_DOMAIN'
  | 'REQUEST_TO_JOIN'
  | 'OPEN_TO_ORG'
  | 'HIDDEN';

const ALLOWED_TEAM_JOIN_POLICIES = new Set<TeamJoinPolicyValue>([
  'INVITE_ONLY',
  'APPROVED_DOMAIN',
  'REQUEST_TO_JOIN',
  'OPEN_TO_ORG',
  'HIDDEN',
]);

export function normalizeTeamJoinPolicy(value: string): TeamJoinPolicyValue {
  const normalized = value.trim().toUpperCase();
  if (!ALLOWED_TEAM_JOIN_POLICIES.has(normalized as TeamJoinPolicyValue)) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return normalized as TeamJoinPolicyValue;
}

export type TeamRecord = {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  joinPolicy: TeamJoinPolicyValue;
  iconUrl: string | null;
  /**
   * Always-resolving team avatar image URL (Docs/Auth/avatars.md §11). `iconUrl` stays what it was
   * — the externally hosted icon, possibly null; this one is derived and never null.
   */
  avatarImageUrl: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamMemberRecord = {
  id: string;
  teamId: string;
  userId: string;
  avatarImageUrl: string;
  teamRole: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamWithMembersRecord = TeamRecord & {
  members: TeamMemberRecord[];
};

const TEAM_SLUG_FALLBACK = 'team';

// Ten, where this was 10_000. The old loop walked `-2`, `-3`, `-4` in order and
// genuinely needed thousands of attempts on a popular name; a random
// four-character suffix draws from 1.6 million, so ten attempts is already a
// vanishing probability of failure.
const MAX_TEAM_SLUG_COLLISION_RETRIES = 10;

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

/**
 * Validate a team slug that a person chose.
 *
 * Refuses rather than coerces, which is the behaviour change: the previous
 * implementation normalised first and validated after, so its rejection branch
 * was unreachable and an explicit `"a"` was stored as `team` without comment.
 * A slug is a DNS label a person is about to put in an address bar, so quietly
 * storing a different one is worse than saying it will not work.
 */
export function normalizeTeamSlug(value: string, reservedLabels?: Iterable<string>): string {
  const result = checkSlug(value, { reserved: reservedLabels });
  if (!result.ok) {
    throw new AppError('BAD_REQUEST', 400, `TEAM_SLUG_${result.reason.toUpperCase()}`);
  }
  return result.slug;
}

/**
 * Derive an available team slug from a team's name.
 *
 * Only a derived slug is ever suffixed. An explicit one that collides is
 * refused by `ensureAvailableTeamSlug`, because silently handing someone
 * `design-k4f2` when they asked for `design` is the same class of surprise the
 * coercion above was.
 *
 * A reserved label is treated exactly like a taken one: a team genuinely named
 * "API" derives to `api`, which no tenant may hold, so it takes a suffix and
 * becomes `api-k4f2` rather than failing a creation that has nothing wrong
 * with it.
 */
export async function deriveUniqueTeamSlug(params: {
  orgId: string;
  prisma: Pick<OrgServicePrisma, 'team'>;
  name: string;
  existingSlugToIgnore?: string;
  reservedLabels?: Iterable<string>;
}): Promise<string> {
  const base = deriveSlugBase(params.name, { fallback: TEAM_SLUG_FALLBACK });
  const ignoredSlug = params.existingSlugToIgnore?.trim();

  for (let attempt = 0; attempt < MAX_TEAM_SLUG_COLLISION_RETRIES; attempt += 1) {
    const candidate = attempt === 0 ? base : withSlugSuffix(base, randomSlugSuffix());

    if (candidate === ignoredSlug) return candidate;
    if (isReservedLabel(candidate, params.reservedLabels)) continue;

    const existing = await params.prisma.team.findFirst({
      where: { orgId: params.orgId, slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  throw new AppError('INTERNAL', 500, 'TEAM_SLUG_COLLISION_RETRY_EXHAUSTED');
}

/**
 * Validate an explicitly supplied team slug and confirm it is free.
 *
 * Uniqueness stays scoped to the organisation, which is what
 * `@@unique([orgId, slug])` already enforces and what the Tenant Subdomain
 * Contract requires: a team slug is a label beneath its organisation's own
 * subdomain, never a tenant key in its own right, so two organisations both
 * holding `design` is correct rather than a collision.
 */
export async function ensureAvailableTeamSlug(params: {
  orgId: string;
  prisma: Pick<OrgServicePrisma, 'team'>;
  slug: string;
  existingSlugToIgnore?: string;
  reservedLabels?: Iterable<string>;
}): Promise<string> {
  const candidate = normalizeTeamSlug(params.slug, params.reservedLabels);
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
    throw new AppError('BAD_REQUEST', 400, 'TEAM_SLUG_TAKEN');
  }

  return candidate;
}

/**
 * Validate a team role against THIS domain's configured vocabulary (`org_features.team_roles`).
 *
 * Before `team_roles` existed the canonical three (`owner|admin|member`) were the law; they are now
 * only the default, so a domain that names its own team roles gets them enforced on every write the
 * same way `org_roles` has always been enforced. An omitted role still means `member` — and, like
 * `ensureOrgRole('member', …)` on the org side, a domain whose vocabulary omits `member` must pass
 * one explicitly rather than have UOA invent a substitute.
 */
export function normalizeTeamRole(value: string | undefined, config: ClientConfig): string {
  const role = value?.trim() ?? 'member';
  if (!resolveTeamRoleVocabulary(config).includes(role)) throw new AppError('BAD_REQUEST', 400);
  return role;
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

export function toTeamRecord(
  row: {
    id: string;
    orgId: string;
    groupId: string | null;
    name: string;
    slug: string;
    description: string | null;
    isDefault: boolean;
    joinPolicy?: string;
    iconUrl?: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  domain: string,
): TeamRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    groupId: row.groupId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isDefault: row.isDefault,
    joinPolicy: (row.joinPolicy ?? 'INVITE_ONLY') as TeamJoinPolicyValue,
    iconUrl: row.iconUrl ?? null,
    avatarImageUrl: teamAvatarImageUrl(domain, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTeamMemberRecord(
  row: {
    id: string;
    teamId: string;
    userId: string;
    teamRole: string;
    createdAt: Date;
    updatedAt: Date;
  },
  domain: string,
): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    avatarImageUrl: memberAvatarImageUrl(domain, row.userId),
    teamRole: row.teamRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * What the acting user must be standing in for a capability check to be answerable.
 *
 * `actorUserId: undefined` means the domain pairing authorised the call and there is no acting user
 * (backend mode) — the pairing outranks any member role, so every capability is held. Only
 * `resolveOrgActor` may produce that `undefined`; these helpers never invent it.
 *
 * `teamId` is omitted only where there is genuinely no team to stand in — creating one. Then only
 * org-scope grants can authorise, which is exactly what `requireTeamManager` used to do everywhere.
 */
export type TeamCapabilityCheck = {
  orgId: string;
  teamId?: string;
  actorUserId: string | undefined;
  config: ClientConfig;
};

/**
 * Does the acting user hold `capability` in this team?
 *
 * The single non-throwing source of truth for UOA's own gates, replacing the hard-coded
 * `role === 'owner' || role === 'admin'` predicates (`isTeamManager` / `isOrgOrTeamManager`). It
 * resolves the domain's grant table rather than comparing role strings, so a role a domain invented
 * can hold real authority — and answers §3's union: org-role grants ∪ team-role grants, with
 * `owner` structurally holding everything at the scope it stands in.
 *
 * The org lookup runs first and short-circuits, so the common manager path costs the same one query
 * it always did.
 */
export async function hasTeamCapability(
  prisma: OrgServicePrisma,
  capability: UoaCapability,
  params: TeamCapabilityCheck,
): Promise<boolean> {
  if (!params.actorUserId) return true;

  const grants = resolveRoleGrants(params.config);

  const actorOrgMembership = await getOrganisationMember(
    prisma,
    { orgId: params.orgId, userId: params.actorUserId },
    { activeOnly: true },
  );
  if (roleHoldsCapability(grants, 'org', actorOrgMembership?.role, capability)) {
    return true;
  }

  if (!params.teamId) return false;

  const actorTeamMembership = await prisma.teamMember.findFirst({
    where: { teamId: params.teamId, userId: params.actorUserId, status: 'ACTIVE' },
    select: { teamRole: true },
  });
  return roleHoldsCapability(grants, 'team', actorTeamMembership?.teamRole, capability);
}

/** `hasTeamCapability` as a 403. The refusal names no role — under a custom vocabulary it could not. */
export async function requireTeamCapability(
  prisma: OrgServicePrisma,
  capability: UoaCapability,
  params: TeamCapabilityCheck,
): Promise<void> {
  if (!(await hasTeamCapability(prisma, capability, params))) {
    throw new AppError('FORBIDDEN', 403);
  }
}

export async function resolveAndAuthorizeTeamOrg(
  prisma: OrgServicePrisma,
  params: { orgId: string; actorUserId?: string },
): Promise<{
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}> {
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  if (!params.actorUserId) return org;

  const actorMembership = await getOrganisationMember(prisma, {
    orgId: org.id,
    userId: params.actorUserId,
  }, { activeOnly: true });
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
  memberAvatarImageUrl,
  normalizeIconUrl,
  teamAvatarImageUrl,
  resolveOrgActor,
  toListLimit,
  type CursorList,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
};
