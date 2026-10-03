import { requireIdentityEmail } from './entity-lifecycle.service.js';
import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import type { AvatarStyle } from '../utils/avatar-svg.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import type { ProviderAvatarImage } from './avatar-provider.service.js';
import {
  avatarSourceFor,
  resolveSubjectAvatar,
  sniffAvatarUpload,
  toAvatarBytes,
  type AvatarProviderDeps,
  type AvatarSource,
  type AvatarUploadResult,
  type ResolvedAvatar,
} from './avatar-subject.service.js';

export type { AvatarSource, AvatarUploadResult, ResolvedAvatar };

type AvatarPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique' | 'findMany'>;
  userAvatar: Pick<
    PrismaClient['userAvatar'],
    'findUnique' | 'findMany' | 'upsert' | 'deleteMany'
  >;
  domainRole: Pick<PrismaClient['domainRole'], 'findUnique'>;
};

export type AvatarDeps = AvatarProviderDeps & {
  prisma?: AvatarPrisma;
};

function prismaFor(deps?: AvatarDeps): AvatarPrisma {
  if (deps?.prisma) return deps.prisma;
  if (!getEnv().DATABASE_URL) throw new AppError('NOT_FOUND', 404, 'AVATAR_DB_DISABLED');
  return getAdminPrisma() as unknown as AvatarPrisma;
}

/**
 * Resolve a `:userId` under the same visibility rules as `GET /domain/users`: the user must hold a
 * DomainRole on the authenticated domain. Anything else — unknown id, or a user that exists but
 * belongs to another domain — is the standard generic 404, so these routes add no enumeration
 * signal beyond what the same credentials already get from the user list.
 */
export async function requireDomainUserId(
  params: { domain: string; userId: string },
  deps?: AvatarDeps,
): Promise<string> {
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');

  const prisma = prismaFor(deps);
  const role = await prisma.domainRole.findUnique({
    where: { domain_userId: { domain, userId: params.userId } },
    select: { userId: true },
  });
  if (!role) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  return role.userId;
}

export type UserAvatarContext = {
  userId: string;
  email: string;
  domain: string | null;
};

/**
 * Resolve a user for the admin routes, which may target any user. Returns the identifying email
 * and the user's domain so mutations can be audit-logged against the right domain, the same shape
 * `requireTeamContext` gives the admin team routes. Unknown ids are the standard generic 404.
 */
export async function requireUserContext(
  userId: string,
  deps?: AvatarDeps,
): Promise<UserAvatarContext> {
  const user = await prismaFor(deps).user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', id: userId },
    select: { id: true, email: true, domain: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  return { userId: user.id, email: requireIdentityEmail(user.email), domain: user.domain };
}

/**
 * Fixed precedence (Docs/Auth/avatars.md §1): uploaded → proxied provider → generated.
 * Always returns an image for a known user; unknown users are a generic 404.
 */
export async function resolveAvatar(
  params: {
    userId: string;
    style?: AvatarStyle | null;
    configDefaultStyle?: AvatarStyle | null;
    size?: number | null;
  },
  deps?: AvatarDeps,
): Promise<ResolvedAvatar> {
  const prisma = prismaFor(deps);

  const [uploaded, user] = await Promise.all([
    prisma.userAvatar.findUnique({
      where: { userId: params.userId },
      select: { contentType: true, data: true },
    }),
    prisma.user.findUnique({
      where: { lifecycleStatus: 'ACTIVE', id: params.userId },
      select: { id: true, avatarUrl: true },
    }),
  ]);

  if (!user) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  return await resolveSubjectAvatar(
    { id: params.userId, uploaded, externalUrl: user.avatarUrl },
    { style: params.style, configDefaultStyle: params.configDefaultStyle, size: params.size },
    deps,
  );
}

/**
 * Which of the three sources a user's avatar currently comes from, without fetching any bytes.
 * `provider` means "a provider URL is on file" — if proxying it later fails, that GET still
 * degrades to the generated image.
 */
export async function getAvatarSources(
  userIds: string[],
  deps?: AvatarDeps,
): Promise<Map<string, AvatarSource>> {
  const sources = new Map<string, AvatarSource>();
  if (userIds.length === 0) return sources;

  const prisma = prismaFor(deps);
  const [uploads, users] = await Promise.all([
    prisma.userAvatar.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true },
    }),
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, avatarUrl: true },
    }),
  ]);

  const uploaded = new Set(uploads.map((row) => row.userId));
  for (const user of users) {
    sources.set(user.id, avatarSourceFor(uploaded.has(user.id), user.avatarUrl));
  }

  return sources;
}

export async function getAvatarSource(userId: string, deps?: AvatarDeps): Promise<AvatarSource> {
  const sources = await getAvatarSources([userId], deps);
  return sources.get(userId) ?? 'generated';
}

/**
 * Store an uploaded avatar (Docs/Auth/avatars.md §3). The sniffed magic-byte type wins over the
 * client mimetype and is what gets persisted; SVG, HTML, PDF and anything else non-raster is
 * rejected with the standard generic error, as is anything over AVATAR_MAX_BYTES.
 */
export async function uploadAvatar(
  params: { userId: string; data: Buffer },
  deps?: AvatarDeps,
): Promise<AvatarUploadResult> {
  const prisma = prismaFor(deps);
  const contentType = sniffAvatarUpload(params.data);

  const user = await prisma.user.findUnique({
    where: { lifecycleStatus: 'ACTIVE', id: params.userId },
    select: { id: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  const sizeBytes = params.data.byteLength;
  const data = toAvatarBytes(params.data);
  const row = await prisma.userAvatar.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId, contentType, data, sizeBytes },
    update: { contentType, data, sizeBytes },
    select: { contentType: true, sizeBytes: true, updatedAt: true },
  });

  return {
    source: 'uploaded',
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}

/**
 * Remove the uploaded avatar. Idempotent: deleting when nothing is stored still succeeds, and
 * resolution simply falls back to the provider URL or the generated image.
 */
export async function deleteAvatar(
  params: { userId: string },
  deps?: AvatarDeps,
): Promise<void> {
  const prisma = prismaFor(deps);
  await prisma.userAvatar.deleteMany({ where: { userId: params.userId } });
}

export type { ProviderAvatarImage };
