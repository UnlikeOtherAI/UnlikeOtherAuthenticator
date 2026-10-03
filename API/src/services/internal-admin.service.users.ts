import { getAdminPrisma } from '../db/prisma.js';
import { adminAvatarImageUrl, avatarImageBaseUrl } from '../utils/avatar-url.js';
import {
  DEFAULT_LIST_LIMIT,
  adminAvatarSource,
  displayDate,
  displayTimestamp,
  isDatabaseEnabled,
  listLimit,
  method,
} from './internal-admin.service.base.js';
import { writeAuditLog, type AuditLogPrisma } from './audit-log.service.js';
import { resetTwoFactorForUser } from './twofactor-disable.service.js';

export async function getAdminLogs(limit = 100, userId?: string) {
  if (!isDatabaseEnabled()) return [];

  const rows = await getAdminPrisma().loginLog.findMany({
    where: userId ? { userId } : undefined,
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
    userId: log.userId,
    occurredAt: log.createdAt.toISOString(),
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

  const prisma = getAdminPrisma();
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: listLimit(limit) });
  const userIds = users.map((user) => user.id);
  const [roles, logs, uploadedAvatars] = await Promise.all([
    prisma.domainRole.findMany({ where: { userId: { in: userIds } }, select: { userId: true, domain: true } }),
    prisma.loginLog.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(userIds.length * 5, DEFAULT_LIST_LIMIT),
    }),
    prisma.userAvatar.findMany({ where: { userId: { in: userIds } }, select: { userId: true } }),
  ]);
  const uploadedAvatarUserIds = new Set(uploadedAvatars.map((row) => row.userId));
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

  // Docs/Auth/avatars.md §9: every admin identity payload carries an image URL fetchable with
  // the same admin bearer the caller already used.
  const baseUrl = avatarImageBaseUrl();

  return users.map((user) => {
    const latestLog = latestLogByUser.get(user.id);
    return {
      id: user.id,
      name: user.lifecycleStatus === 'DELETED' ? 'Deleted user' : user.name,
      deleted: user.lifecycleStatus === 'DELETED',
      email: user.email,
      domains: Array.from(domainsByUser.get(user.id) ?? []),
      twofa: user.twoFaEnabled,
      avatarSource: adminAvatarSource(uploadedAvatarUserIds.has(user.id), user.avatarUrl),
      avatarImageUrl: adminAvatarImageUrl({ baseUrl, userId: user.id }),
      lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
      status: user.lifecycleStatus.toLowerCase(),
      method: method(latestLog?.authMethod),
      created: displayDate(user.createdAt),
    };
  });
}

export async function getAdminUser(userId: string) {
  if (!isDatabaseEnabled()) return null;

  const prisma = getAdminPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const [roles, latestLog, uploadedAvatar] = await Promise.all([
    prisma.domainRole.findMany({ where: { userId }, select: { domain: true } }),
    prisma.loginLog.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    prisma.userAvatar.findUnique({ where: { userId }, select: { userId: true } }),
  ]);

  return {
    id: user.id,
    name: user.lifecycleStatus === 'DELETED' ? 'Deleted user' : user.name,
      deleted: user.lifecycleStatus === 'DELETED',
    email: user.email,
    domains: roles.map((role) => role.domain),
    twofa: user.twoFaEnabled,
    avatarSource: adminAvatarSource(Boolean(uploadedAvatar), user.avatarUrl),
    avatarImageUrl: adminAvatarImageUrl({ baseUrl: avatarImageBaseUrl(), userId: user.id }),
    lastLogin: latestLog ? displayTimestamp(latestLog.createdAt) : 'Never',
    status: user.lifecycleStatus.toLowerCase(),
    method: method(latestLog?.authMethod),
    created: displayDate(user.createdAt),
  };
}

export async function resetAdminUserTwoFactor(params: {
  actorEmail: string;
  userId: string;
}) {
  const prisma = getAdminPrisma();
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, domain: true },
  });
  if (!user) return null;

  await resetTwoFactorForUser({ userId: user.id }, { prisma });
  await writeAuditLog(
    {
      actorEmail: params.actorEmail,
      action: 'user.twofa_reset',
      targetDomain: user.domain,
      metadata: { userId: user.id, email: user.email },
    },
    { prisma: prisma as unknown as AuditLogPrisma },
  );

  return getAdminUser(user.id);
}
