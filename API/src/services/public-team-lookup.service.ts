import type { PrismaClient } from '@prisma/client';

import { avatarImageBaseUrl, publicTeamAvatarImageUrl } from '../utils/avatar-url.js';

/**
 * Public team display lookup — `POST /public/teams/lookup`.
 *
 * Ruling (2026-11-08): a team id → name is not a secret. A caller that already holds team ids
 * (Nessie's API server naming the teams a computer belongs to, without anyone's session) may read
 * the display fields of those teams and nothing else. Every row is read by exact id, so the
 * response can never name a team the caller did not ask for, and an id that is unknown, or whose
 * team or organisation is not ACTIVE (disabled, archived, deleting, deleted), is simply omitted —
 * the same lifecycle rule the public `/teams/:teamId/avatar` route uses to decide whether a real
 * logo is published.
 *
 * Members, roles, domains, email policies, settings, descriptions and the external `iconUrl`
 * never leave this function. `avatarUrl` is the existing credential-free team image URL
 * (Docs/Auth/avatars.md §11.3–§11.4), identical to the one GET /org/me and the sign-in chooser
 * hand out.
 */

export const PUBLIC_TEAM_LOOKUP_MAX_IDS = 50;

export type PublicTeamDisplay = {
  teamId: string;
  teamName: string;
  teamSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  avatarUrl: string;
};

type PublicTeamLookupPrisma = { team: Pick<PrismaClient['team'], 'findMany'> };

export async function lookupPublicTeams(
  prisma: PublicTeamLookupPrisma,
  teamIds: readonly string[],
  baseUrl: string = avatarImageBaseUrl(),
): Promise<PublicTeamDisplay[]> {
  const requested = [...new Set(teamIds)];
  if (requested.length === 0) return [];

  const rows = await prisma.team.findMany({
    where: {
      id: { in: requested },
      lifecycleStatus: 'ACTIVE',
      org: { lifecycleStatus: 'ACTIVE' },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      updatedAt: true,
      org: { select: { id: true, name: true, slug: true } },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  return requested.flatMap((teamId) => {
    const row = byId.get(teamId);
    if (!row) return [];
    return [{
      teamId: row.id,
      teamName: row.name,
      teamSlug: row.slug,
      orgId: row.org.id,
      orgName: row.org.name,
      orgSlug: row.org.slug,
      avatarUrl: publicTeamAvatarImageUrl({ baseUrl, teamId: row.id, updatedAt: row.updatedAt }),
    }];
  });
}
