import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { requireIdentityEmail } from './entity-lifecycle.service.js';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { adminAvatarImageUrl, avatarImageBaseUrl } from '../utils/avatar-url.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';

type AdminSuperuserRow = {
  userId: string;
  email: string;
  name: string | null;
  // Docs/Auth/avatars.md §9 — fetchable with the admin bearer this route already requires.
  avatarImageUrl: string;
  createdAt: string;
};

type AdminSuperuserSearchRow = Omit<AdminSuperuserRow, 'createdAt'>;

function adminDomain(): string {
  return normalizeDomain(getAdminAuthDomain(getEnv()));
}

function serialize(row: {
  userId: string;
  createdAt: Date;
  user: { email: string | null; name: string | null };
}): AdminSuperuserRow {
  return {
    userId: row.userId,
    email: requireIdentityEmail(row.user.email),
    name: row.user.name,
    avatarImageUrl: adminAvatarImageUrl({ baseUrl: avatarImageBaseUrl(), userId: row.userId }),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAdminSuperusers(): Promise<AdminSuperuserRow[]> {
  const rows = await getAdminPrisma().domainRole.findMany({
    where: { domain: adminDomain(), role: 'SUPERUSER' },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(serialize);
}

export async function searchNonSuperusers(query: string): Promise<AdminSuperuserSearchRow[]> {
  const q = query.trim();
  if (!q) return [];

  const rows = await getAdminPrisma().user.findMany({
    where: {
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
      domainRoles: {
        none: { domain: adminDomain(), role: 'SUPERUSER' },
      },
    },
    orderBy: [{ email: 'asc' }],
    take: 20,
    select: { id: true, email: true, name: true },
  });

  const baseUrl = avatarImageBaseUrl();
  return rows.map((row) => ({
    userId: row.id,
    email: requireIdentityEmail(row.email),
    name: row.name,
    avatarImageUrl: adminAvatarImageUrl({ baseUrl, userId: row.id }),
  }));
}

export async function grantAdminSuperuser(userId: string, actor: LifecycleActor): Promise<AdminSuperuserRow> {
  const domain = adminDomain();
  const prisma = getAdminPrisma();
  return runInTransaction(prisma, async tx => {
  await lockProductTeamPolicyExclusive(tx);
  await requireLifecycleActor(tx, actor);
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, lifecycleStatus: true },
  });
  if (!user || user.lifecycleStatus !== 'ACTIVE') throw new AppError('NOT_FOUND', 404);

  const row = await tx.domainRole.upsert({
    where: { domain_userId: { domain, userId } },
    update: { role: 'SUPERUSER' },
    create: { domain, userId, role: 'SUPERUSER' },
    include: { user: { select: { email: true, name: true } } },
  });

  return serialize(row);
  });
}

export async function revokeAdminSuperuser(params: {
  userId: string;
  actorUserId: string;
  actorTokenVersion: number;
}): Promise<void> {
  if (params.userId === params.actorUserId) {
    throw new AppError('BAD_REQUEST', 409, 'CANNOT_REMOVE_SELF');
  }

  const domain = adminDomain();
  const prisma = getAdminPrisma();

  await runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyExclusive(tx);
    await requireLifecycleActor(tx, { userId: params.actorUserId, tokenVersion: params.actorTokenVersion });
    const count = await tx.domainRole.count({ where: { domain, role: 'SUPERUSER', user: { lifecycleStatus: 'ACTIVE' } } });
    if (count <= 1) {
      throw new AppError('BAD_REQUEST', 409, 'CANNOT_REMOVE_LAST_SUPERUSER');
    }

    await tx.domainRole.delete({
      where: { domain_userId: { domain, userId: params.userId } },
    });
  });
}
