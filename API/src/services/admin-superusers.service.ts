import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

type AdminSuperuserRow = {
  userId: string;
  email: string;
  name: string | null;
  createdAt: string;
};

type AdminSuperuserSearchRow = Omit<AdminSuperuserRow, 'createdAt'>;

function adminDomain(): string {
  return normalizeDomain(getAdminAuthDomain(getEnv()));
}

function serialize(row: {
  userId: string;
  createdAt: Date;
  user: { email: string; name: string | null };
}): AdminSuperuserRow {
  return {
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
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

  return rows.map((row) => ({ userId: row.id, email: row.email, name: row.name }));
}

export async function grantAdminSuperuser(userId: string): Promise<AdminSuperuserRow> {
  const domain = adminDomain();
  const prisma = getAdminPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 404);

  const row = await prisma.domainRole.upsert({
    where: { domain_userId: { domain, userId } },
    update: { role: 'SUPERUSER' },
    create: { domain, userId, role: 'SUPERUSER' },
    include: { user: { select: { email: true, name: true } } },
  });

  return serialize(row);
}

export async function revokeAdminSuperuser(params: {
  userId: string;
  actorUserId: string;
}): Promise<void> {
  if (params.userId === params.actorUserId) {
    throw new AppError('BAD_REQUEST', 409, 'CANNOT_REMOVE_SELF');
  }

  const domain = adminDomain();
  const prisma = getAdminPrisma();

  await prisma.$transaction(async (tx) => {
    const count = await tx.domainRole.count({ where: { domain, role: 'SUPERUSER' } });
    if (count <= 1) {
      throw new AppError('BAD_REQUEST', 409, 'CANNOT_REMOVE_LAST_SUPERUSER');
    }

    await tx.domainRole.delete({
      where: { domain_userId: { domain, userId: params.userId } },
    });
  });
}
