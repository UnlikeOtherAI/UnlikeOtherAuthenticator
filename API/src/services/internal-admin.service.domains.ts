import { getAdminPrisma } from '../db/prisma.js';
import {
  DEFAULT_LIST_LIMIT,
  SECRET_OLD_MS,
  adminOrganisationArgs,
  displayDate,
  displayTimestamp,
  formatAdminOrganisation,
  isDatabaseEnabled,
  latestLogsByUser,
  listLimit,
  method,
  normalizeDomain,
  secretAge,
} from './internal-admin.service.base.js';

export async function getAdminDomains(limit?: number) {
  if (!isDatabaseEnabled()) return [];

  const prisma = getAdminPrisma();
  const [roles, orgs, logs, registries] = await Promise.all([
    prisma.domainRole.groupBy({
      by: ['domain'],
      _count: { userId: true },
      _min: { createdAt: true },
    }),
    prisma.organisation.groupBy({
      by: ['domain'],
      _count: { id: true },
    }),
    prisma.loginLog.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.clientDomain.findMany({
      include: { secrets: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
  ]);
  const domains = new Map<string, { createdAt: Date | null; orgs: number; users: number }>();
  const registryByDomain = new Map(registries.map((registry) => [normalizeDomain(registry.domain), registry]));

  const ensure = (domain: string) => {
    const normalized = normalizeDomain(domain);
    const existing = domains.get(normalized);
    if (existing) return existing;
    const next = { createdAt: null as Date | null, orgs: 0, users: 0 };
    domains.set(normalized, next);
    return next;
  };

  roles.forEach((role) => {
    const entry = ensure(role.domain);
    entry.users = role._count.userId;
    if (role._min.createdAt) entry.createdAt = role._min.createdAt;
  });
  orgs.forEach((org) => {
    ensure(org.domain).orgs = org._count.id;
  });
  logs.forEach((log) => ensure(log.domain));
  registries.forEach((registry) => {
    const entry = ensure(registry.domain);
    if (!entry.createdAt || registry.createdAt < entry.createdAt) entry.createdAt = registry.createdAt;
  });

  return Array.from(domains.entries())
    .filter(([domain]) => registryByDomain.has(domain))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, listLimit(limit))
    .map(([domain, entry]) => {
      const registry = registryByDomain.get(domain);
      const activeSecret = registry?.secrets[0] ?? null;
      return {
        id: domain,
        name: domain,
        label: registry?.label ?? domain,
        secretAge: secretAge(activeSecret?.createdAt ?? null),
        secretOld: activeSecret ? Date.now() - activeSecret.createdAt.getTime() > SECRET_OLD_MS : false,
        users: entry.users,
        orgs: entry.orgs,
        status: registry?.status === 'disabled' ? 'disabled' : 'active',
        allowedEmailDomains: registry?.allowedEmailDomains ?? [],
        allowedEmails: registry?.allowedEmails ?? [],
        allowedRedirectUrls: registry?.allowedRedirectUrls ?? [],
        created: entry.createdAt ? displayDate(entry.createdAt) : '',
        hash: activeSecret ? `sha256:${activeSecret.hashPrefix}...` : 'not configured',
      };
    });
}

export async function getAdminDomain(domain: string) {
  if (!isDatabaseEnabled()) return null;

  const normalized = normalizeDomain(domain);
  const prisma = getAdminPrisma();
  const [registry, roles, orgs, userIdsRaw] = await Promise.all([
    prisma.clientDomain.findUnique({
      where: { domain: normalized },
      include: { secrets: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
    prisma.domainRole.findMany({ where: { domain: normalized } }),
    prisma.organisation.findMany({
      where: { domain: normalized },
      ...adminOrganisationArgs,
    }),
    prisma.domainRole.findMany({ where: { domain: normalized }, select: { userId: true }, distinct: ['userId'] }),
  ]);
  const orgRoleDomainPresent = orgs.length > 0 || roles.length > 0 || Boolean(registry);
  if (!orgRoleDomainPresent) return null;

  const userIds = userIdsRaw.map((row) => row.userId);
  const [users, logs] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } } }) : Promise.resolve([]),
    userIds.length
      ? prisma.loginLog.findMany({
          where: { userId: { in: userIds } },
          orderBy: { createdAt: 'desc' },
          take: Math.max(userIds.length * 5, DEFAULT_LIST_LIMIT),
        })
      : Promise.resolve([]),
  ]);
  const latestByUser = latestLogsByUser(logs);
  const rolesByUser = new Map<string, string[]>();
  roles.forEach((role) => {
    const list = rolesByUser.get(role.userId) ?? [];
    list.push(role.role);
    rolesByUser.set(role.userId, list);
  });

  const organisations = orgs.map((org) => formatAdminOrganisation(org, latestByUser));
  const teams = organisations.flatMap((org) => org.teams.map((team) => ({ ...team, orgName: org.name })));
  const userSummaries = users.map((user) => {
    const latestLog = latestByUser.get(user.id);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      domains: [normalized],
      twofa: user.twoFaEnabled,
      lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
      status: 'active',
      method: method(latestLog?.authMethod),
      created: displayDate(user.createdAt),
      domainRoles: rolesByUser.get(user.id) ?? [],
    };
  });

  const activeSecret = registry?.secrets[0] ?? null;
  const domainSummary = {
    id: normalized,
    name: normalized,
    label: registry?.label ?? normalized,
    secretAge: secretAge(activeSecret?.createdAt ?? null),
    secretOld: activeSecret ? Date.now() - activeSecret.createdAt.getTime() > SECRET_OLD_MS : false,
    users: userSummaries.length,
    orgs: organisations.length,
    status: registry?.status === 'disabled' ? 'disabled' : 'active',
    allowedEmailDomains: registry?.allowedEmailDomains ?? [],
    allowedEmails: registry?.allowedEmails ?? [],
    allowedRedirectUrls: registry?.allowedRedirectUrls ?? [],
    created: registry ? displayDate(registry.createdAt) : '',
    hash: activeSecret ? `sha256:${activeSecret.hashPrefix}...` : 'not configured',
  };

  return { domain: domainSummary, organisations, teams, users: userSummaries };
}
