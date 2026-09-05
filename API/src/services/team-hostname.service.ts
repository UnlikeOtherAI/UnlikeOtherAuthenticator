import type { PrismaClient } from '@prisma/client';
import { checkSlug, type SlugRejection } from '@unlikeotherai/slug';

import { getPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';

/**
 * Turning a tenant hostname back into ids, and telling a person whether the
 * address they typed is free.
 *
 * A team hostname is `<team.slug>.<organisation.slug>.<product base domain>`
 * (Docs/brief.md, "Team Subdomain Clarification"). The organisation label is
 * the tenant key; the team label is only meaningful once that organisation is
 * known, because team slugs are unique per organisation and nothing else.
 * Resolution therefore always walks left from the organisation, never straight
 * to a team.
 *
 * Every read here is scoped to the calling client domain. A product resolving a
 * hostname may only ever see organisations on its own domain, which is the same
 * boundary `@@unique([domain, slug])` draws.
 */

type HostnamePrisma = {
  organisation: Pick<PrismaClient['organisation'], 'findFirst'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
};

type HostnameDeps = { prisma?: HostnamePrisma };

export type ResolvedTeamHostname = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
};

/** Resolve `<teamSlug>.<orgSlug>` within one client domain. */
export async function resolveTeamHostname(
  params: { domain: string; orgSlug: string; teamSlug: string },
  deps: HostnameDeps = {},
): Promise<ResolvedTeamHostname | null> {
  const domain = normalizeDomain(params.domain);
  const orgSlug = params.orgSlug.trim().toLowerCase();
  const teamSlug = params.teamSlug.trim().toLowerCase();
  if (!orgSlug || !teamSlug) return null;

  const prisma = deps.prisma ?? (getPrisma() as unknown as HostnamePrisma);

  const org = await prisma.organisation.findFirst({
    where: { domain, slug: orgSlug },
    select: { id: true, name: true, slug: true },
  });
  if (!org) return null;

  const team = await prisma.team.findFirst({
    where: { orgId: org.id, slug: teamSlug },
    select: { id: true, name: true, slug: true },
  });
  if (!team) return null;

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.slug,
  };
}

export type ResolvedOrgHostname = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** The organisation's own mark, or null when it has never set one. */
  orgIconUrl: string | null;
};

/**
 * Resolve an organisation label alone — the tenant host one level above a
 * team's, `<organisation.slug>.<base domain>`.
 *
 * A product serves a branded landing page there, so this deliberately returns
 * the organisation's display name and icon as well as its id: rendering
 * somebody else's brand should not cost a second authenticated round trip.
 *
 * It reveals that an organisation exists on this domain, and what it is called,
 * to anyone who can guess the label. That is inherent to giving a tenant a
 * public address at all — but it is why this answers about the ORGANISATION
 * only. Its teams are never listed here; a product must not turn a guessable
 * hostname into a directory of a customer's internal structure.
 */
export async function resolveOrgHostname(
  params: { domain: string; orgSlug: string },
  deps: HostnameDeps = {},
): Promise<ResolvedOrgHostname | null> {
  const domain = normalizeDomain(params.domain);
  const orgSlug = params.orgSlug.trim().toLowerCase();
  if (!orgSlug) return null;

  const prisma = deps.prisma ?? (getPrisma() as unknown as HostnamePrisma);
  const org = await prisma.organisation.findFirst({
    where: { domain, slug: orgSlug },
    select: { id: true, name: true, slug: true, iconUrl: true },
  });
  if (!org) return null;

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    orgIconUrl: org.iconUrl ?? null,
  };
}

export type SlugAvailability =
  | { available: true; slug: string }
  | { available: false; reason: SlugRejection | 'taken' };

/**
 * Whether an organisation may take this address on this client domain.
 *
 * Deliberately answers only about the caller's own domain. It reveals that a
 * label is taken, which is unavoidable — the answer is the point — but says
 * nothing about who holds it.
 */
export async function checkOrgSlugAvailability(
  params: { domain: string; slug: string; reservedLabels?: Iterable<string> },
  deps: HostnameDeps = {},
): Promise<SlugAvailability> {
  const result = checkSlug(params.slug, { reserved: params.reservedLabels });
  if (!result.ok) return { available: false, reason: result.reason };

  const prisma = deps.prisma ?? (getPrisma() as unknown as HostnamePrisma);
  const existing = await prisma.organisation.findFirst({
    where: { domain: normalizeDomain(params.domain), slug: result.slug },
    select: { id: true },
  });

  return existing ? { available: false, reason: 'taken' } : { available: true, slug: result.slug };
}

/**
 * Whether a team may take this label inside one organisation.
 *
 * Scoped to the organisation, which is what makes the nested hostname shape
 * worth its extra label: the question "is `design` free?" is answered from the
 * asker's own organisation and cannot be used to enumerate another customer's
 * team names.
 */
export async function checkTeamSlugAvailability(
  params: { orgId: string; slug: string; reservedLabels?: Iterable<string> },
  deps: HostnameDeps = {},
): Promise<SlugAvailability> {
  const result = checkSlug(params.slug, { reserved: params.reservedLabels });
  if (!result.ok) return { available: false, reason: result.reason };

  const prisma = deps.prisma ?? (getPrisma() as unknown as HostnamePrisma);
  const existing = await prisma.team.findFirst({
    where: { orgId: params.orgId, slug: result.slug },
    select: { id: true },
  });

  return existing ? { available: false, reason: 'taken' } : { available: true, slug: result.slug };
}
