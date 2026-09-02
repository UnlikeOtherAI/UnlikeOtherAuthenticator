import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  deriveSlugWithValidation,
  getOrganisationMember,
  ensureOrgName,
  isP2002Error,
  isP2003Error,
  normalizeDomain,
  normalizeIconUrl,
  normalizeMemberInvitesSetting,
  parseOrgFeatureRoles,
  requireOrgCapability,
  resolveOrgActor,
  resolveOrganisation,
  toListLimit,
  toOrganisationRecord,
  type CursorList,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type OrganisationRecord,
} from './organisation.service.base.js';
import {
  deriveUniqueTeamSlug,
  normalizeTeamJoinPolicy,
  toTeamRecord,
  type TeamRecord,
} from './team.service.base.js';
import { resolveWorkspaceCreatorTeamRole } from './role-grants.js';
import {
  lockWorkspaceMembershipRows,
  lockWorkspaceOrganisationRow,
} from './workspace-scope.service.js';

const ORGANISATION_SELECT = {
  id: true,
  domain: true,
  name: true,
  slug: true,
  ownerId: true,
  memberInvites: true,
  iconUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Everything `toTeamRecord` needs for the default team returned by create.
 * Kept beside `ORGANISATION_SELECT` so the two response shapes are read
 * together.
 */
const DEFAULT_TEAM_SELECT = {
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

/**
 * What `POST /org/organisations` answers: the organisation record plus the
 * default team the same transaction created.
 *
 * The default team is deliberately NOT added to `OrganisationRecord` itself.
 * `toOrganisationRecord` serialises that type for the single-org read AND for
 * the domain-wide list, so carrying a team on it would add a team lookup to
 * every row of every list page to serve the one caller that already holds the
 * id in hand.
 *
 * It exists because creation was otherwise unusable by an API client. The
 * transaction creates a default team and makes the owner a member of it, but
 * without its id the caller cannot address the workspace it just made — and no
 * user-credentialled read can recover it, because a subject assertion has to
 * name the org and team it is acting on, which is exactly what is unknown. A
 * product driving org creation from its own UI was forced to send the person
 * through UOA's interactive chooser instead.
 */
export type CreatedOrganisationRecord = OrganisationRecord & {
  defaultTeam: TeamRecord;
};

export async function listOrganisationsForDomain(
  params: { domain: string; limit?: number; cursor?: string },
  deps?: OrgServiceDeps,
): Promise<CursorList<OrganisationRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);

  const limit = toListLimit(params.limit);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const where = { domain };
  const cursor = params.cursor?.trim();

  const rows = await prisma.organisation.findMany({
    where,
    // Total order — see the note in team.service.teams.ts: a cursor walk on a
    // non-unique `createdAt` silently drops rows that share a millisecond.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: ORGANISATION_SELECT,
  });

  const data = rows.slice(0, limit).map(toOrganisationRecord);
  // Brief §24.11: `cursor=<last_id>` — the cursor is the last row of the
  // returned page (the follow-up query skips it), not the first of the next.
  const hasMore = rows.length > limit;

  return { data, next_cursor: hasMore ? rows[limit - 1].id : null };
}

export async function createOrganisation(
  params: {
    domain: string;
    name: string;
    /** Optional default-team visibility for the hosted first-workspace continuation. */
    defaultTeamJoinPolicy?: string;
    ownerId: string;
    config: ClientConfig;
    actorUserId?: string;
    actor?: OrgActorProvenance;
  },
  deps?: OrgServiceDeps,
): Promise<CreatedOrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const domain = normalizeDomain(params.domain);
  const ownerId = params.ownerId.trim();
  const name = ensureOrgName(params.name);
  const defaultTeamJoinPolicy =
    params.defaultTeamJoinPolicy === undefined
      ? undefined
      : normalizeTeamJoinPolicy(params.defaultTeamJoinPolicy);
  if (!ownerId || !domain) throw new AppError('BAD_REQUEST', 400);
  parseOrgFeatureRoles(params.config); // validates array is usable for later writes.

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);

  const created = await runInTransaction(prisma, async (tx) => {
    const userExists = await tx.user.findUnique({
      where: { id: ownerId },
      select: { id: true },
    });
    if (!userExists) throw new AppError('BAD_REQUEST', 400);

    // On the user path the owner IS the acting user, and `requireOrgRole`
    // already proved their access token was issued for this domain.
    //
    // In backend mode the owner is an arbitrary id chosen by the caller, and
    // "the user exists" is NOT a tenant boundary: `user_scope` defaults to
    // `global`, so in a default deployment EVERY user row has `domain: null`
    // and passes the `users_select` RLS policy on every domain. Requiring a
    // `DomainRole` on the calling domain binds the named owner to a user who has
    // actually authenticated here, which is the same signal login uses
    // (`ensureDomainRoleForUser`).
    //
    // What that does and does not exclude, precisely — `superuser` is a
    // TOKEN CLAIM derived from a `DomainRole` row, not an attribute of the user
    // row, so this check treats superusers like anyone else:
    //   - a platform superuser (SUPERUSER on ADMIN_AUTH_DOMAIN) who has never
    //     signed in on this domain has no `DomainRole` here and is REJECTED;
    //   - one who has signed in here does have one, and is ACCEPTED, exactly
    //     like any other user of this domain.
    // That is intended. The check is a tenant boundary — "has this person
    // authenticated on the domain whose backend is asking?" — not a privilege
    // filter, and a superuser who is a real user of this domain is a legitimate
    // organisation owner. Excluding them would need a separate rule, and none is
    // specified.
    if (!actorUserId) {
      const ownerDomainRole = await tx.domainRole.findUnique({
        where: { domain_userId: { domain, userId: ownerId } },
        select: { userId: true },
      });
      if (!ownerDomainRole) throw new AppError('BAD_REQUEST', 400);
    }

    const slug = await deriveSlugWithValidation(domain, tx, name);
    const createdOrg = await tx.organisation.create({
      data: {
        domain,
        name,
        slug,
        ownerId,
      },
      select: ORGANISATION_SELECT,
    });

    const defaultTeam = await tx.team.create({
      data: {
        orgId: createdOrg.id,
        name: 'General',
        slug: await deriveUniqueTeamSlug({
          orgId: createdOrg.id,
          prisma: tx,
          name: 'General',
        }),
        isDefault: true,
        ...(defaultTeamJoinPolicy === undefined ? {} : { joinPolicy: defaultTeamJoinPolicy }),
      },
      // Widened from `{ id }` so the create response can carry the whole team
      // record. The row is already being written here; selecting its columns
      // costs nothing and saves every API client a follow-up read it may not
      // even be able to make — see `CreatedOrganisationRecord` below.
      select: DEFAULT_TEAM_SELECT,
    });

    try {
      await tx.orgMember.create({
        data: {
          orgId: createdOrg.id,
          userId: ownerId,
          role: 'owner',
        },
      });
    } catch (err) {
      if (isP2002Error(err) || isP2003Error(err)) {
        throw new AppError('BAD_REQUEST', 400);
      }
      throw err;
    }

    await tx.teamMember.create({
      data: {
        teamId: defaultTeam.id,
        userId: ownerId,
        // Founding an organisation makes you the steward of its first workspace,
        // not a rank-and-file member of it. Without this the row took Prisma's
        // `member` default, so the founder came out organisation `owner` and
        // team `member` — holding no team capability over the only workspace
        // they had just created.
        teamRole: resolveWorkspaceCreatorTeamRole(params.config),
      },
    });

    return {
      ...toOrganisationRecord(createdOrg),
      defaultTeam: toTeamRecord(defaultTeam, domain),
    };
  });

  await auditOrg({
    orgId: created.id,
    actorUserId,
    actor: params.actor,
    action: 'org.created',
    targetType: 'organisation',
    targetId: created.id,
    metadata: { name: created.name, slug: created.slug, ownerId },
  }, { prisma: deps?.auditPrisma });

  return created;
}

export async function getOrganisation(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  // Domain ownership is checked for BOTH callers: an org on another domain is a
  // 404 here regardless of who asks.
  const row = await resolveOrganisation(prisma, { orgId: params.orgId });

  // Defence-in-depth: even though the route layer enforces `requireOrgRole`,
  // re-verify actor membership here so the service contract matches
  // updateOrganisation/deleteOrganisation and cannot leak org data if a future
  // route refactor omits the role guard. There is no membership to check in
  // backend mode — the caller is the domain, not a member of it.
  if (actorUserId) {
    const actorMembership = await getOrganisationMember(prisma, { orgId: row.id, userId: actorUserId }, { activeOnly: true });
    if (!actorMembership) {
      throw new AppError('FORBIDDEN', 403);
    }
  }

  return toOrganisationRecord(row);
}

export async function updateOrganisation(
  params: {
    orgId: string;
    domain: string;
    name: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
    memberInvites?: string;
    iconUrl?: string | null;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const name = ensureOrgName(params.name);
  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  // Renaming the organisation, and setting its invite policy and icon, is the organisation OBJECT —
  // `organisation.manage`, resolved against this domain's grant table at ORG scope. Team standing
  // is deliberately not consulted: administering one team must not confer authority over the tenant
  // containing it. In backend mode there is no acting user — the domain pairing already proved the
  // caller owns this whole tenant, which is strictly more authority than any single member's role.
  if (actorUserId) {
    const actorMembership = await getOrganisationMember(prisma, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
    requireOrgCapability(params.config, 'organisation.manage', actorMembership?.role);
  }

  const slug = await deriveSlugWithValidation(org.domain, prisma, name, org.slug);
  const updated = await prisma.organisation.update({
    where: { id: org.id },
    data: {
      name,
      slug,
      // Member-initiated invite policy (design §4.7, Phase 4) — owner/admin only, validated against
      // the allowed/admin_approval/disabled vocabulary; omitted leaves the current setting unchanged.
      ...(params.memberInvites !== undefined
        ? { memberInvites: normalizeMemberInvitesSetting(params.memberInvites) }
        : {}),
      // Workspace icon (design §11.3, gap-fix A Task 3) — omitted leaves the current icon
      // unchanged; `null` clears it; validated https-only/≤2048 chars by normalizeIconUrl.
      ...(params.iconUrl !== undefined ? { iconUrl: normalizeIconUrl(params.iconUrl) } : {}),
    },
    select: ORGANISATION_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'org.updated',
    targetType: 'organisation',
    targetId: org.id,
    metadata: {
      name: updated.name,
      slug: updated.slug,
      ...(params.memberInvites !== undefined ? { memberInvites: updated.memberInvites } : {}),
      ...(params.iconUrl !== undefined ? { iconUrlSet: updated.iconUrl !== null } : {}),
    },
  });

  return toOrganisationRecord(updated);
}

export async function deleteOrganisation(
  params: {
    orgId: string;
    domain?: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
  },
  deps?: OrgServiceDeps,
): Promise<{ deleted: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);

  const prisma =
    deps?.prisma ??
    ((params.actor?.via === 'admin_superuser' ? getAdminPrisma() : getPrisma()) as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  // "Must be the owner" is a check on the acting user; backend mode has none.
  if (actorUserId && org.ownerId !== actorUserId) {
    throw new AppError('FORBIDDEN', 403);
  }

  try {
    await runInTransaction(prisma, async (tx) => {
      if (!(await lockWorkspaceOrganisationRow(org.id, { prisma: tx }))) {
        throw new AppError('NOT_FOUND', 404);
      }
      const members = await tx.orgMember.findMany({
        where: { orgId: org.id },
        orderBy: { userId: 'asc' },
        select: { userId: true },
      });
      for (const member of members) {
        await lockWorkspaceMembershipRows(
          { userId: member.userId, orgId: org.id },
          { prisma: tx },
        );
      }
      await tx.organisation.delete({ where: { id: org.id } });
    });
  } catch (err) {
    if (isP2003Error(err)) {
      throw new AppError('BAD_REQUEST', 400, 'ORG_HAS_PROTECTED_RECORDS');
    }
    throw err;
  }

  // Written after the delete commits. `OrgAuditLog.orgId` is not a foreign key
  // to organisations, so the trail outlives the organisation it describes —
  // which is the whole point for a deletion.
  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'org.deleted',
    targetType: 'organisation',
    targetId: org.id,
    metadata: { name: org.name, slug: org.slug, ownerId: org.ownerId },
  }, { prisma: deps?.auditPrisma });

  return { deleted: true };
}
