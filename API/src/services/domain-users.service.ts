import { requireIdentityEmail } from './entity-lifecycle.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { avatarImageBaseUrl, domainAvatarImageUrl } from '../utils/avatar-url.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import type { AvatarSource } from './avatar.service.js';

type DomainUsersPrisma = {
  domainRole: Pick<PrismaClient['domainRole'], 'findMany'>;
  userAvatar?: Pick<PrismaClient['userAvatar'], 'findMany'>;
};

type DomainUsersDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: DomainUsersPrisma;
};

export type DomainUserRecord = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  avatarSource: AvatarSource;
  avatarImageUrl: string;
  twoFaEnabled: boolean;
  role: 'superuser' | 'user';
  createdAt: Date;
};

function roleToPublic(role: UserRole): 'superuser' | 'user' {
  return role === 'SUPERUSER' ? 'superuser' : 'user';
}

/**
 * Brief 17: Domain-scoped API: list users for a domain.
 *
 * Returns only non-sensitive user fields (no password hash, no 2FA secret, no user_key).
 */
export async function listUsersForDomain(
  params: { domain: string; limit?: number; userId?: string },
  deps?: DomainUsersDeps,
): Promise<DomainUserRecord[]> {
  const env = deps?.env ?? getEnv();
  if (!env.DATABASE_URL) return [];

  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as DomainUsersPrisma);
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));

  const rows = await prisma.domainRole.findMany({
    where: { domain, user: { lifecycleStatus: 'ACTIVE' }, ...(params.userId ? { userId: params.userId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      role: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          twoFaEnabled: true,
          createdAt: true,
        },
      },
    },
  });

  // Additive per Docs/Auth/avatars.md §5: which source a user's avatar resolves from today.
  // One extra query for the whole page — `avatarUrl` is already in the rows above, so only the
  // presence of an uploaded row still needs looking up.
  const uploadedUserIds = await findUploadedAvatarUserIds(
    prisma,
    rows.map((r) => r.user.id),
  );

  // Docs/Auth/avatars.md §9: identity payloads carry a URL that always resolves to an image,
  // fetchable with the same domain-hash credential that authorized this listing.
  const baseUrl = avatarImageBaseUrl(env);

  return rows.map((r) => ({
    id: r.user.id,
    email: requireIdentityEmail(r.user.email),
    name: r.user.name,
    avatarUrl: r.user.avatarUrl,
    avatarSource: uploadedUserIds.has(r.user.id)
      ? 'uploaded'
      : r.user.avatarUrl
        ? 'provider'
        : 'generated',
    avatarImageUrl: domainAvatarImageUrl({ baseUrl, domain, userId: r.user.id }),
    twoFaEnabled: r.user.twoFaEnabled,
    role: roleToPublic(r.role),
    createdAt: r.user.createdAt,
  }));
}

async function findUploadedAvatarUserIds(
  prisma: DomainUsersPrisma,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0 || !prisma.userAvatar) return new Set();

  const uploads = await prisma.userAvatar.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true },
  });

  return new Set(uploads.map((row) => row.userId));
}

