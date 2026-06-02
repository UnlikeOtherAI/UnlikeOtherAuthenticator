import type { Prisma } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';

export { normalizeDomain };

export type AdminMethod = 'email' | 'google' | 'github' | 'apple' | 'facebook' | 'linkedin' | 'microsoft';

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 200;
export const SECRET_OLD_MS = 90 * 24 * 60 * 60 * 1000;

export const adminOrganisationArgs = {
  include: {
    owner: { select: { id: true, name: true, email: true } },
    teams: { include: { members: { include: { user: true } }, _count: { select: { members: true } } } },
    members: { include: { user: true } },
    invites: { include: { team: true } },
  },
} satisfies Prisma.OrganisationDefaultArgs;

export type AdminOrganisationRow = Prisma.OrganisationGetPayload<typeof adminOrganisationArgs>;
export type AdminLoginLogRow = { userId: string | null; authMethod: string; createdAt: Date };

export type AdminAppRow = Prisma.AppGetPayload<{
  include: {
    org: { select: { id: true; name: true } };
    flags: true;
    killSwitches: true;
  };
}>;

export const emptyBans = {
  emails: [],
  patterns: [],
  ips: [],
  users: [],
};

export function isDatabaseEnabled(): boolean {
  return Boolean(getEnv().DATABASE_URL);
}

export function displayDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function displayTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

export function secretAge(value: Date | null): string | null {
  if (!value) return null;
  const days = Math.max(0, Math.floor((Date.now() - value.getTime()) / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'today';
  return `${days}d`;
}

export function method(value: string | null | undefined): AdminMethod {
  const normalized = (value ?? 'email').toLowerCase();
  return ['email', 'google', 'github', 'apple', 'facebook', 'linkedin', 'microsoft'].includes(normalized)
    ? (normalized as AdminMethod)
    : 'email';
}

export function listLimit(limit?: number): number {
  return Math.max(1, Math.min(MAX_LIST_LIMIT, limit ?? DEFAULT_LIST_LIMIT));
}

export function latestLogsByUser(logs: AdminLoginLogRow[]): Map<string, AdminLoginLogRow> {
  const latestByUser = new Map<string, AdminLoginLogRow>();
  logs.forEach((log) => {
    if (log.userId && !latestByUser.has(log.userId)) latestByUser.set(log.userId, log);
  });
  return latestByUser;
}

export function formatAdminOrganisation(
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
    allowedEmailDomains: team.allowedEmailDomains,
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
    allowedEmailDomains: org.allowedEmailDomains,
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

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function formatAdminApp(app: AdminAppRow) {
  const domains = jsonStringArray(app.domains);
  const platform = app.platform;

  return {
    id: app.id,
    name: app.name,
    identifier: app.identifier,
    domain: domains[0] ?? '',
    org: app.org.name,
    orgId: app.org.id,
    platform,
    domains,
    storeUrl: app.storeUrl ?? undefined,
    offlinePolicy: app.offlinePolicy,
    pollIntervalSeconds: app.pollIntervalSeconds,
    flags: app.flags.length,
    platforms: [
      {
        id: `${app.id}:${platform}`,
        name: platform,
        key: platform,
        kind: platform,
        identifier: app.identifier,
      },
    ],
    flagDefinitions: app.flags.map((flag) => ({
      id: flag.id,
      key: flag.key,
      description: flag.description ?? '',
      defaultState: flag.defaultState,
      platformMode: 'all',
      platformIds: [],
      updated: displayDate(flag.updatedAt),
    })),
    killSwitches: app.killSwitches.map((entry) => ({
      id: entry.id,
      name: entry.name ?? `${entry.type} ${entry.versionValue}`,
      platformMode: entry.platform === 'both' ? 'all' : 'selected',
      platformIds: entry.platform === 'both' ? [] : [entry.platform],
      type: entry.type,
      versionField: entry.versionField,
      operator: entry.operator,
      versionValue: entry.versionValue,
      versionMax: entry.versionMax,
      versionScheme: entry.versionScheme,
      latestVersion: entry.latestVersion ?? undefined,
      active: entry.active,
      priority: entry.priority,
      cacheTtl: entry.cacheTtl,
      updated: displayDate(entry.updatedAt),
    })),
    audienceGroups: [],
    status: app.active ? 'active' : 'disabled',
  };
}

export function emptyData() {
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

export async function getAdminStats() {
  if (!isDatabaseEnabled()) return emptyData().stats;

  const prisma = getAdminPrisma();
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
