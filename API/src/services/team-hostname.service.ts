import type { Prisma, PrismaClient } from '@prisma/client';
import { checkSlug, type SlugRejection } from '@unlikeotherai/slug';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { resolveProductTeamPolicy, type ProductTeamPolicyPrisma } from './product-team-policy.service.js';

/**
 * UOA owns hostname labels and their inverse. A recognized product uses the
 * same server-owned cross-product namespace as its sign-in chooser. Other
 * clients retain their original domain namespace. Neither lookup grants access.
 * Globally ambiguous labels fail closed in both directions; a caller must not
 * build a URL that would resolve to a different organisation.
 */
type HostnamePrisma = ProductTeamPolicyPrisma & {
  organisation: Pick<PrismaClient['organisation'], 'findFirst' | 'findMany'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
};
type HostnameDeps = { prisma?: HostnamePrisma };
const database = (deps: HostnameDeps): HostnamePrisma => deps.prisma ?? getAdminPrisma();
const orgSelect = { id: true, name: true, slug: true, iconUrl: true } as const;

async function namespace(domain: string, prisma: HostnamePrisma) {
  const policy = await resolveProductTeamPolicy({ domain }, { prisma });
  return policy.scope === 'all_active_memberships' ? {} : { domain: normalizeDomain(domain) };
}

async function addressableOrg(domain: string, selector: { id: string } | { slug: string }, prisma: HostnamePrisma) {
  const scope = await namespace(domain, prisma);
  if ('domain' in scope) return prisma.organisation.findFirst({
    where: { ...scope, ...selector }, select: orgSelect,
  });
  const where: Prisma.OrganisationWhereInput = { lifecycleStatus: 'ACTIVE' };
  const selected = 'id' in selector ? await prisma.organisation.findFirst({
    where: { ...where, id: selector.id }, select: orgSelect,
  }) : null;
  if ('id' in selector && !selected) return null;
  const slug = 'slug' in selector ? selector.slug : selected!.slug;
  const matches = await prisma.organisation.findMany({
    where: { ...where, slug }, select: orgSelect, take: 2,
  });
  return matches.length === 1 && (!selected || matches[0].id === selected.id) ? matches[0] : null;
}

export type ResolvedTeamHostname = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
};

/** Resolve `<teamSlug>.<orgSlug>` within the registered product namespace. */
export async function resolveTeamHostname(
  params: { domain: string; orgSlug: string; teamSlug: string },
  deps: HostnameDeps = {},
): Promise<ResolvedTeamHostname | null> {
  const orgSlug = params.orgSlug.trim().toLowerCase();
  const teamSlug = params.teamSlug.trim().toLowerCase();
  if (!orgSlug || !teamSlug) return null;

  const prisma = database(deps);

  const org = await addressableOrg(params.domain, { slug: orgSlug }, prisma);
  if (!org) return null;

  const team = await prisma.team.findFirst({
    where: { orgId: org.id, slug: teamSlug, lifecycleStatus: 'ACTIVE' },
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
  const orgSlug = params.orgSlug.trim().toLowerCase();
  if (!orgSlug) return null;

  const prisma = database(deps);
  const org = await addressableOrg(params.domain, { slug: orgSlug }, prisma);
  if (!org) return null;

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    orgIconUrl: org.iconUrl ?? null,
  };
}

/**
 * The address of an organisation the caller already knows the id of.
 *
 * The inverse of `resolveOrgHostname`, and the reason it exists: a product
 * stores UOA's ids and no slug of its own — the slug belongs to UOA — so
 * "which hostname is this organisation at?" is otherwise unanswerable. Without
 * it a product can route a hostname it was given but cannot build one, which is
 * exactly half a feature.
 */
export async function resolveOrgById(
  params: { domain: string; orgId: string },
  deps: HostnameDeps = {},
): Promise<ResolvedOrgHostname | null> {
  const prisma = database(deps);
  const org = await addressableOrg(params.domain, { id: params.orgId.trim() }, prisma);
  if (!org) return null;

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    orgIconUrl: org.iconUrl ?? null,
  };
}

export type ResolvedTeamById = {
  teamId: string;
  teamName: string;
  teamSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
};

/**
 * Both labels of a team's address, from the team's id.
 *
 * A team hostname is `<team.slug>.<organisation.slug>.<base domain>`, so a
 * caller needs both labels and holds neither. This returns the pair in one
 * read — a team picker that moves the address bar would otherwise make a
 * request per row.
 */
export async function resolveTeamById(
  params: { domain: string; teamId: string },
  deps: HostnameDeps = {},
): Promise<ResolvedTeamById | null> {
  const prisma = database(deps);
  const scope = await namespace(params.domain, prisma);
  const team = await prisma.team.findFirst({
    where: { id: params.teamId.trim(), lifecycleStatus: 'ACTIVE',
      org: { ...scope, lifecycleStatus: 'ACTIVE' } },
    select: {
      id: true,
      name: true,
      slug: true,
      org: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!team?.org) return null;
  const org = await addressableOrg(params.domain, { id: team.org.id }, prisma);
  if (!org || org.slug !== team.org.slug) return null;

  return {
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.slug,
    orgId: team.org.id,
    orgName: team.org.name,
    orgSlug: team.org.slug,
  };
}

export type SlugAvailability =
  | { available: true; slug: string }
  | { available: false; reason: SlugRejection | 'taken' };

/**
 * Whether an organisation may take this address on this client domain.
 *
 * Answers within the caller's registered product namespace. It reveals that a
 * label is taken, which is unavoidable — the answer is the point — but says
 * nothing about who holds it.
 */
export async function checkOrgSlugAvailability(
  params: { domain: string; slug: string; reservedLabels?: Iterable<string> },
  deps: HostnameDeps = {},
): Promise<SlugAvailability> {
  const result = checkSlug(params.slug, { reserved: params.reservedLabels });
  if (!result.ok) return { available: false, reason: result.reason };

  const prisma = database(deps);
  const existing = await prisma.organisation.findFirst({
    where: { ...await namespace(params.domain, prisma), slug: result.slug },
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

  const prisma = database(deps);
  const existing = await prisma.team.findFirst({
    where: { orgId: params.orgId, slug: result.slug },
    select: { id: true },
  });

  return existing ? { available: false, reason: 'taken' } : { available: true, slug: result.slug };
}
