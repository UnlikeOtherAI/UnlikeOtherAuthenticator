import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import {
  apiKeyDisplayPrefix,
  digestApiKey,
  generateAdminApiKey,
} from '../utils/api-key.js';
import { AppError } from '../utils/errors.js';

// HUGO-539: Admin API keys. Global/superuser-scoped opaque bearer keys used to operate
// feature flags & kill switches from a terminal/CI. Uses getAdminPrisma() (no tenant context);
// the secret is never persisted, only its HMAC digest.

export type AdminApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdByEmail: string | null;
  createdAt: Date;
};

const recordSelect = {
  id: true,
  name: true,
  keyPrefix: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdByEmail: true,
  createdAt: true,
} as const;

export async function createAdminApiKey(params: {
  name: string;
  expiresAt?: Date | null;
  createdBy?: { userId?: string | null; email?: string | null };
}): Promise<{ record: AdminApiKeyRecord; plaintext: string }> {
  const name = params.name.trim();
  if (!name || name.length > 120) throw new AppError('BAD_REQUEST', 400, 'INVALID_API_KEY_NAME');
  if (params.expiresAt && Number.isNaN(params.expiresAt.getTime())) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_API_KEY_EXPIRY');
  }

  const plaintext = generateAdminApiKey();
  const record = await getAdminPrisma().adminApiKey.create({
    data: {
      name,
      keyPrefix: apiKeyDisplayPrefix(plaintext),
      secretDigest: digestApiKey(plaintext),
      expiresAt: params.expiresAt ?? null,
      createdByUserId: params.createdBy?.userId ?? null,
      createdByEmail: params.createdBy?.email ?? null,
    },
    select: recordSelect,
  });

  return { record, plaintext };
}

export async function listAdminApiKeys(): Promise<AdminApiKeyRecord[]> {
  return getAdminPrisma().adminApiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: recordSelect,
  });
}

export async function revokeAdminApiKey(id: string): Promise<AdminApiKeyRecord> {
  const existing = await getAdminPrisma().adminApiKey.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'API_KEY_NOT_FOUND');

  return getAdminPrisma().adminApiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
    select: recordSelect,
  });
}

/**
 * Verify a raw Admin API key. Returns `{ id }` on success; throws 401 otherwise.
 * Global unique-index lookup on the digest (a deliberate global-key pattern, unlike the
 * per-domain scan in domain-secret.service.ts). When DATABASE_URL is unset the service runs
 * DB-less (matching admin-superuser.ts / domain-secret.service.ts) and cannot verify.
 */
export async function verifyAdminApiKey(rawKey: string): Promise<{ id: string }> {
  if (!getEnv().DATABASE_URL) throw new AppError('UNAUTHORIZED', 401);

  const prisma = getAdminPrisma();
  const row = await prisma.adminApiKey.findUnique({
    where: { secretDigest: digestApiKey(rawKey) },
    select: { id: true, revokedAt: true, expiresAt: true },
  });

  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < Date.now())) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  // Best-effort lastUsedAt touch. Awaited (never fire-and-forget — an unhandled rejection
  // must not crash the process) but its failure must not block a valid request.
  try {
    await prisma.adminApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  } catch {
    // Swallow: the key is valid; a failed touch is non-fatal.
  }

  return { id: row.id };
}
