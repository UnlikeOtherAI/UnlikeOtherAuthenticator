import { getAdminPrisma } from '../db/prisma.js';
import { normalizeAllowedEmailDomains } from '../utils/email-domain-list.js';
import { AppError } from '../utils/errors.js';
import {
  DEFAULT_LIST_LIMIT,
  adminOrganisationArgs,
  formatAdminOrganisation,
  isDatabaseEnabled,
  latestLogsByUser,
  listLimit,
} from './internal-admin.service.base.js';

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

export async function updateAdminOrganisation(
  orgId: string,
  input: { allowedEmailDomains: string[] },
) {
  const prisma = getAdminPrisma();
  const existing = await prisma.organisation.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'ORGANISATION_NOT_FOUND');

  await prisma.organisation.update({
    where: { id: orgId },
    data: { allowedEmailDomains: normalizeAllowedEmailDomains(input.allowedEmailDomains) },
  });

  return getAdminOrganisation(orgId);
}

export async function updateAdminTeam(
  orgId: string,
  teamId: string,
  input: { allowedEmailDomains: string[] },
) {
  const prisma = getAdminPrisma();
  const team = await prisma.team.findFirst({ where: { id: teamId, orgId }, select: { id: true } });
  if (!team) throw new AppError('NOT_FOUND', 404, 'TEAM_NOT_FOUND');

  await prisma.team.update({
    where: { id: teamId },
    data: { allowedEmailDomains: normalizeAllowedEmailDomains(input.allowedEmailDomains) },
  });

  return getAdminTeam(orgId, teamId);
}
