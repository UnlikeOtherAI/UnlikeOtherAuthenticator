import { getAdminPrisma } from '../db/prisma.js';
import {
  normalizeAllowedEmailDomains,
  normalizeAllowedEmails,
} from '../utils/email-domain-list.js';
import { AppError } from '../utils/errors.js';
import {
  DEFAULT_LIST_LIMIT,
  adminOrganisationArgs,
  displayDate,
  formatAdminOrganisation,
  isDatabaseEnabled,
  latestLogsByUser,
  listLimit,
  normalizeDomain,
} from './internal-admin.service.base.js';
import { deriveSlugWithValidation, isP2002Error, isP2003Error } from './organisation.service.base.js';
import { deriveUniqueTeamSlug } from './team.service.base.js';

export async function getAdminOrganisations(limit?: number) {
  if (!isDatabaseEnabled()) return [];

  const prisma = getAdminPrisma();
  const orgs = await prisma.organisation.findMany({
    orderBy: { createdAt: 'desc' },
    take: listLimit(limit),
    ...adminOrganisationArgs,
  });
  const memberIds = [...new Set(orgs.flatMap((org) => org.members.map((member) => member.userId)))];
  const logs = memberIds.length
    ? await prisma.loginLog.findMany({
        where: { userId: { in: memberIds } },
        orderBy: { createdAt: 'desc' },
        take: Math.max(memberIds.length * 5, DEFAULT_LIST_LIMIT),
      })
    : [];
  return orgs.map((org) => formatAdminOrganisation(org, latestLogsByUser(logs)));
}

export async function getAdminOrganisation(orgId: string) {
  if (!isDatabaseEnabled()) return null;

  const prisma = getAdminPrisma();
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, ...adminOrganisationArgs });
  if (!org) return null;

  const memberIds = org.members.map((member) => member.userId);
  const logs = memberIds.length
    ? await prisma.loginLog.findMany({
        where: { userId: { in: memberIds } },
        orderBy: { createdAt: 'desc' },
        take: Math.max(memberIds.length * 5, DEFAULT_LIST_LIMIT),
      })
    : [];

  return formatAdminOrganisation(org, latestLogsByUser(logs));
}

export async function getAdminTeams(limit?: number) {
  const orgs = await getAdminOrganisations(limit);
  return orgs
    .flatMap((org) => org.teams.map((team) => ({ ...team, orgName: org.name })))
    .slice(0, listLimit(limit));
}

export async function getAdminTeam(orgId: string, teamId: string) {
  const org = await getAdminOrganisation(orgId);
  return org ? { org, team: org.teams.find((team) => team.id === teamId) ?? null } : null;
}

export async function createAdminOrganisation(input: {
  name: string;
  domain: string;
  ownerEmail: string;
  allowedEmailDomains?: string[];
  allowedEmails?: string[];
}) {
  const prisma = getAdminPrisma();
  const name = input.name.trim();
  const domain = normalizeDomain(input.domain);
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!name || name.length > 100 || !domain || !ownerEmail) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_ORGANISATION_INPUT');
  }

  const owner = await prisma.user.findFirst({
    where: { email: ownerEmail },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!owner) throw new AppError('BAD_REQUEST', 400, 'OWNER_NOT_FOUND');

  const created = await prisma.$transaction(async (tx) => {
    const slug = await deriveSlugWithValidation(domain, tx, name);
    const org = await tx.organisation.create({
      data: {
        domain,
        name,
        slug,
        ownerId: owner.id,
        allowedEmailDomains: normalizeAllowedEmailDomains(input.allowedEmailDomains ?? []),
        allowedEmails: normalizeAllowedEmails(input.allowedEmails ?? []),
      },
      select: { id: true, createdAt: true },
    });
    const team = await tx.team.create({
      data: {
        orgId: org.id,
        name: 'General',
        slug: await deriveUniqueTeamSlug({ orgId: org.id, prisma: tx, name: 'General' }),
        isDefault: true,
      },
      select: { id: true },
    });

    try {
      await tx.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
      await tx.teamMember.create({ data: { teamId: team.id, userId: owner.id, teamRole: 'owner' } });
    } catch (err) {
      if (isP2002Error(err) || isP2003Error(err)) throw new AppError('BAD_REQUEST', 400);
      throw err;
    }

    return { id: org.id, createdAt: org.createdAt };
  });

  return {
    ...(await getAdminOrganisation(created.id)),
    created: displayDate(created.createdAt),
  };
}

export async function updateAdminOrganisation(
  orgId: string,
  input: { allowedEmailDomains?: string[]; allowedEmails?: string[] },
) {
  const prisma = getAdminPrisma();
  const existing = await prisma.organisation.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'ORGANISATION_NOT_FOUND');

  const data: { allowedEmailDomains?: string[]; allowedEmails?: string[] } = {};
  if (input.allowedEmailDomains !== undefined) {
    data.allowedEmailDomains = normalizeAllowedEmailDomains(input.allowedEmailDomains);
  }
  if (input.allowedEmails !== undefined) {
    data.allowedEmails = normalizeAllowedEmails(input.allowedEmails);
  }

  if (Object.keys(data).length > 0) {
    await prisma.organisation.update({ where: { id: orgId }, data });
  }

  return getAdminOrganisation(orgId);
}

export async function updateAdminTeam(
  orgId: string,
  teamId: string,
  input: { allowedEmailDomains?: string[]; allowedEmails?: string[] },
) {
  const prisma = getAdminPrisma();
  const team = await prisma.team.findFirst({ where: { id: teamId, orgId }, select: { id: true } });
  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  const data: { allowedEmailDomains?: string[]; allowedEmails?: string[] } = {};
  if (input.allowedEmailDomains !== undefined) {
    data.allowedEmailDomains = normalizeAllowedEmailDomains(input.allowedEmailDomains);
  }
  if (input.allowedEmails !== undefined) {
    data.allowedEmails = normalizeAllowedEmails(input.allowedEmails);
  }

  if (Object.keys(data).length > 0) {
    await prisma.team.update({ where: { id: teamId }, data });
  }

  return getAdminTeam(orgId, teamId);
}
