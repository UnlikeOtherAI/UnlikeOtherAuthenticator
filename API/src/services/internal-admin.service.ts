import type { Prisma } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { listHandshakeErrorLogs } from './handshake-error-log.service.js';

type AdminMethod = 'email' | 'google' | 'github' | 'apple' | 'facebook' | 'linkedin' | 'microsoft';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const SECRET_OLD_MS = 90 * 24 * 60 * 60 * 1000;

const adminOrganisationArgs = {
  include: {
    owner: { select: { id: true, name: true, email: true } },
    teams: { include: { members: { include: { user: true } }, _count: { select: { members: true } } } },
    members: { include: { user: true } },
    invites: { include: { team: true } },
  },
} satisfies Prisma.OrganisationDefaultArgs;

type AdminOrganisationRow = Prisma.OrganisationGetPayload<typeof adminOrganisationArgs>;
type AdminLoginLogRow = { userId: string | null; authMethod: string; createdAt: Date };

const emptyBans = {
  emails: [],
  patterns: [],
  ips: [],
  users: [],
};

function isDatabaseEnabled(): boolean {
  return Boolean(getEnv().DATABASE_URL);
}

function displayDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function displayTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

function secretAge(value: Date | null): string | null {
  if (!value) return null;
  const days = Math.max(0, Math.floor((Date.now() - value.getTime()) / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'today';
  return `${days}d`;
}

function method(value: string | null | undefined): AdminMethod {
  const normalized = (value ?? 'email').toLowerCase();
  return ['email', 'google', 'github', 'apple', 'facebook', 'linkedin', 'microsoft'].includes(normalized)
    ? (normalized as AdminMethod)
    : 'email';
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function listLimit(limit?: number): number {
  return Math.max(1, Math.min(MAX_LIST_LIMIT, limit ?? DEFAULT_LIST_LIMIT));
}

function latestLogsByUser(logs: AdminLoginLogRow[]): Map<string, AdminLoginLogRow> {
  const latestByUser = new Map<string, AdminLoginLogRow>();
  logs.forEach((log) => {
    if (log.userId && !latestByUser.has(log.userId)) latestByUser.set(log.userId, log);
  });
  return latestByUser;
}

function formatAdminOrganisation(
  org: AdminOrganisationRow,
  latestByUser: Map<string, AdminLoginLogRow>,
) {
  const teams = org.teams.map((team) => ({
    id: team.id,
    orgId: org.id,
    name: team.name,
    description: team.description ?? '',
    isDefault: team.isDefault,
    members: team._count.members,
    orgName: org.name,
  }));

  const members = org.members.map((member) => {
    const latestLog = latestByUser.get(member.userId);
    const teamRows = org.teams.filter((team) => team.members.some((item) => item.userId === member.userId));
    return {
      id: member.user.id,
      name: member.user.name ?? member.user.email,
      email: member.user.email,
      role: member.role,
      teams: teamRows.map((team) => team.name),
      teamRoles: Object.fromEntries(
        teamRows.flatMap((team) =>
          team.members
            .filter((item) => item.userId === member.userId)
            .map((item) => [team.name, item.teamRole]),
        ),
      ),
      twofa: member.user.twoFaEnabled,
      lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
      status: 'active',
      method: method(latestLog?.authMethod),
    };
  });

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    created: displayDate(org.createdAt),
    owner: { id: org.owner.id, name: org.owner.name, email: org.owner.email },
    teams,
    members,
    preapprovedMembers: org.invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.teamRole,
      targetTeam: invite.team.name,
      method: 'ANY',
      status: invite.acceptedAt ? 'claimed' : 'pending',
      created: displayDate(invite.createdAt),
    })),
  };
}

function emptyData() {
  return {
    stats: { users: 0, domains: 0, orgs: 0, loginsToday: 0 },
    domains: [],
    organisations: [],
    users: [],
    logs: [],
    handshakeErrors: [],
    bans: emptyBans,
    apps: [],
  };
}

async function getAdminStats() {
  if (!isDatabaseEnabled()) return emptyData().stats;

  const prisma = getPrisma();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [users, orgs, roleDomains, orgDomains, logDomains, loginsToday] = await Promise.all([
    prisma.user.count(),
    prisma.organisation.count(),
    prisma.domainRole.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.organisation.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.loginLog.findMany({ distinct: ['domain'], select: { domain: true } }),
    prisma.loginLog.count({ where: { createdAt: { gte: today } } }),
  ]);
  const domains = new Set([
    ...roleDomains.map((row) => normalizeDomain(row.domain)),
    ...orgDomains.map((row) => normalizeDomain(row.domain)),
    ...logDomains.map((row) => normalizeDomain(row.domain)),
  ]);

  return { users, domains: domains.size, orgs, loginsToday };
}

export async function getAdminSession(claims: { userId: string; email: string; domain: string }) {
  return {
    ok: true,
    adminUser: {
      id: claims.userId,
      email: claims.email,
      domain: claims.domain,
      role: 'superuser',
    },
  };
}

export async function getAdminDomains(limit?: number) {
  if (!isDatabaseEnabled()) return [];

  const prisma = getPrisma();
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
        created: entry.createdAt ? displayDate(entry.createdAt) : '',
        hash: activeSecret ? `sha256:${activeSecret.hashPrefix}...` : 'not configured',
      };
    });
}

export async function getAdminLogs(limit = 100) {
  if (!isDatabaseEnabled()) return [];

  const rows = await getPrisma().loginLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(500, limit)),
    select: {
      id: true,
      userId: true,
      email: true,
      domain: true,
      authMethod: true,
      ip: true,
      userAgent: true,
      createdAt: true,
    },
  });

  return rows.map((log) => ({
    id: log.id,
    ts: displayTimestamp(log.createdAt),
    user: log.email || null,
    domain: log.domain,
    method: method(log.authMethod),
    ip: log.ip,
    userAgent: log.userAgent,
    result: 'ok',
  }));
}

export async function getAdminUsers(limit?: number) {
  if (!isDatabaseEnabled()) return [];

  const prisma = getPrisma();
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: listLimit(limit) });
  const userIds = users.map((user) => user.id);
  const [roles, logs] = await Promise.all([
    prisma.domainRole.findMany({ where: { userId: { in: userIds } }, select: { userId: true, domain: true } }),
    prisma.loginLog.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(userIds.length * 5, DEFAULT_LIST_LIMIT),
    }),
  ]);
  const domainsByUser = new Map<string, Set<string>>();
  const latestLogByUser = new Map<string, (typeof logs)[number]>();
  roles.forEach((role) => {
    const list = domainsByUser.get(role.userId) ?? new Set<string>();
    list.add(role.domain);
    domainsByUser.set(role.userId, list);
  });
  logs.forEach((log) => {
    const key = log.userId ?? '';
    if (key && !latestLogByUser.has(key)) latestLogByUser.set(key, log);
  });

  return users.map((user) => {
    const latestLog = latestLogByUser.get(user.id);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      domains: Array.from(domainsByUser.get(user.id) ?? []),
      twofa: user.twoFaEnabled,
      lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
      status: 'active',
      method: method(latestLog?.authMethod),
      created: displayDate(user.createdAt),
    };
  });
}

export async function getAdminUser(userId: string) {
  if (!isDatabaseEnabled()) return null;

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const [roles, latestLog] = await Promise.all([
    prisma.domainRole.findMany({ where: { userId }, select: { domain: true } }),
    prisma.loginLog.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    domains: roles.map((role) => role.domain),
    twofa: user.twoFaEnabled,
    lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
    status: 'active',
    method: method(latestLog?.authMethod),
    created: displayDate(user.createdAt),
  };
}

export async function getAdminOrganisations(limit?: number) {
  if (!isDatabaseEnabled()) return [];

  const prisma = getPrisma();
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

  const prisma = getPrisma();
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

export async function getAdminDashboard() {
  const [stats, domains, organisations, users, logs, handshakeErrors] = await Promise.all([
    getAdminStats(),
    getAdminDomains(),
    getAdminOrganisations(),
    getAdminUsers(),
    getAdminLogs(100),
    listHandshakeErrorLogs({ limit: 100 }),
  ]);

  return {
    ...emptyData(),
    stats,
    domains,
    organisations,
    users,
    logs,
    handshakeErrors,
  };
}

export async function getAdminSettings() {
  return { bans: emptyBans, apps: [] };
}

export async function searchAdmin(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const [organisations, users] = await Promise.all([getAdminOrganisations(), getAdminUsers()]);
  const orgMatches = organisations
    .filter((org) => org.name.toLowerCase().includes(normalized) || org.slug.toLowerCase().includes(normalized))
    .slice(0, 4)
    .map((organisation) => ({ type: 'organisation', organisation }));
  const teamMatches = organisations
    .flatMap((organisation) => organisation.teams.map((team) => ({ type: 'team', organisation, team })))
    .filter(({ team }) => team.name.toLowerCase().includes(normalized))
    .slice(0, 4);
  const userMatches = users
    .filter((user) => (user.name ?? '').toLowerCase().includes(normalized) || user.email.toLowerCase().includes(normalized))
    .slice(0, 5)
    .map((user) => ({ type: 'user', user }));

  return [...orgMatches, ...teamMatches, ...userMatches];
}
