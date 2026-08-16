import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import type { AvatarStyle } from '../utils/avatar-svg.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  resolveSubjectAvatar,
  sniffAvatarUpload,
  toAvatarBytes,
  type AvatarProviderDeps,
  type AvatarUploadResult,
  type ResolvedAvatar,
} from './avatar-subject.service.js';
import {
  requireWorkspaceCapability,
  resolveAndAuthorizeTeamOrg,
  resolveOrgActor,
  type OrgServicePrisma,
} from './team.service.base.js';
import type { OrgActorProvenance } from './org-audit-log.service.js';

/**
 * Team ("company") avatars — the team mirror of `avatar.service.ts` (Docs/Auth/avatars.md §11).
 *
 * Precedence per team: uploaded `team_avatars` row → `teams.icon_url` proxied server-side under the
 * same SSRF/timeout/size/sniff rules as a user's provider URL → deterministic generated SVG seeded
 * from the team id. Everything source-agnostic lives in `avatar-subject.service.ts`; this module
 * only supplies the team-shaped lookups and the ownership checks.
 *
 * Table access always runs on the BYPASSRLS admin client: `team_avatars` denies `uoa_app` outright
 * (see the 20260725130000 migration), exactly like `user_avatars`.
 */

type TeamAvatarPrisma = {
  team: Pick<PrismaClient['team'], 'findFirst'>;
  teamAvatar: Pick<PrismaClient['teamAvatar'], 'findUnique' | 'upsert' | 'deleteMany'>;
};

export type TeamAvatarDeps = AvatarProviderDeps & {
  prisma?: TeamAvatarPrisma;
};

export type TeamAvatarContext = {
  teamId: string;
  orgId: string;
  domain: string;
};

function prismaFor(deps?: TeamAvatarDeps): TeamAvatarPrisma {
  if (deps?.prisma) return deps.prisma;
  if (!getEnv().DATABASE_URL) throw new AppError('NOT_FOUND', 404, 'AVATAR_DB_DISABLED');
  return getAdminPrisma() as unknown as TeamAvatarPrisma;
}

/**
 * Resolve a `:teamId` for the `/domain/teams/:teamId/avatar` backend route: the team's organisation
 * must belong to the authenticated domain, the same org↔domain ownership rule
 * `resolveOrganisationByDomain` enforces on every `/org/*` read. Unknown ids and teams owned by
 * another domain are both the standard generic 404 — no cross-domain enumeration signal.
 */
export async function requireDomainTeamId(
  params: { domain: string; teamId: string },
  deps?: TeamAvatarDeps,
): Promise<string> {
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');

  const team = await prismaFor(deps).team.findFirst({
    where: { id: params.teamId, org: { domain } },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  return team.id;
}

/**
 * Resolve a team through the full `/org/*` ownership chain — domain → organisation → team — exactly
 * as the sibling team routes do. `resolveAndAuthorizeTeamOrg` rejects an org that is not on the
 * authenticated domain (404) and an actor who is not an ACTIVE member of it (403); `requireManager`
 * additionally demands the `teams.manage` capability, the same gate `updateTeam` applies.
 */
export async function requireOrgTeamId(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    /** Absent in backend mode — see `resolveOrgActor`. */
    actorUserId?: string;
    actor?: OrgActorProvenance;
    requireManager?: boolean;
    config: ClientConfig;
  },
  deps: { prisma: OrgServicePrisma },
): Promise<string> {
  const actorUserId = resolveOrgActor(params);

  const org = await resolveAndAuthorizeTeamOrg(deps.prisma, {
    orgId: params.orgId,
    domain: params.domain,
    actorUserId,
  });

  if (params.requireManager) {
    await requireWorkspaceCapability(deps.prisma, 'teams.manage', {
      orgId: org.id,
      teamId: params.teamId,
      actorUserId,
      config: params.config,
    });
  }

  const team = await deps.prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404);

  return team.id;
}

/**
 * Resolve a team for the admin routes, which may target any team. Returns the org id and the
 * owning domain so mutations can be audit-logged against the right domain.
 */
export async function requireTeamContext(
  teamId: string,
  deps?: TeamAvatarDeps,
): Promise<TeamAvatarContext> {
  const team = await prismaFor(deps).team.findFirst({
    where: { id: teamId },
    select: { id: true, orgId: true, org: { select: { domain: true } } },
  });
  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  return { teamId: team.id, orgId: team.orgId, domain: team.org.domain };
}

/**
 * Fixed precedence (Docs/Auth/avatars.md §11): uploaded → proxied `icon_url` → generated. Always
 * returns an image for a known team; unknown teams are a generic 404.
 */
export async function resolveTeamAvatar(
  params: {
    teamId: string;
    style?: AvatarStyle | null;
    configDefaultStyle?: AvatarStyle | null;
    size?: number | null;
  },
  deps?: TeamAvatarDeps,
): Promise<ResolvedAvatar> {
  const prisma = prismaFor(deps);

  const [uploaded, team] = await Promise.all([
    prisma.teamAvatar.findUnique({
      where: { teamId: params.teamId },
      select: { contentType: true, data: true },
    }),
    prisma.team.findFirst({
      where: { id: params.teamId },
      select: { id: true, iconUrl: true },
    }),
  ]);

  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  return await resolveSubjectAvatar(
    { id: params.teamId, uploaded, externalUrl: team.iconUrl },
    { style: params.style, configDefaultStyle: params.configDefaultStyle, size: params.size },
    deps,
  );
}

/**
 * Store an uploaded team avatar. Same validation as a user upload: the sniffed magic-byte type wins
 * over the client mimetype, SVG and any non-raster payload is rejected, 1 MiB cap.
 */
export async function uploadTeamAvatar(
  params: { teamId: string; data: Buffer },
  deps?: TeamAvatarDeps,
): Promise<AvatarUploadResult> {
  const prisma = prismaFor(deps);
  const contentType = sniffAvatarUpload(params.data);

  const team = await prisma.team.findFirst({
    where: { id: params.teamId },
    select: { id: true },
  });
  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  const sizeBytes = params.data.byteLength;
  const data = toAvatarBytes(params.data);
  const row = await prisma.teamAvatar.upsert({
    where: { teamId: params.teamId },
    create: { teamId: params.teamId, contentType, data, sizeBytes },
    update: { contentType, data, sizeBytes },
    select: { contentType: true, sizeBytes: true, updatedAt: true },
  });

  return {
    source: 'uploaded',
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}

/**
 * Remove the uploaded team avatar. Idempotent: deleting when nothing is stored still succeeds, and
 * resolution simply falls back to `icon_url` or the generated image.
 */
export async function deleteTeamAvatar(
  params: { teamId: string },
  deps?: TeamAvatarDeps,
): Promise<void> {
  const prisma = prismaFor(deps);
  await prisma.teamAvatar.deleteMany({ where: { teamId: params.teamId } });
}
