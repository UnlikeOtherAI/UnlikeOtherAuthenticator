import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import {
  decryptClaimSecret,
  encryptClaimSecret,
  type EncryptedClaimSecret,
} from '../utils/claim-secret-crypto.js';

type ClaimTokenPrisma = Pick<PrismaClient, 'integrationClaimToken' | '$transaction'>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Prisma's `Bytes` column typing requires `Uint8Array<ArrayBuffer>`; Node `Buffer`
// is structurally compatible but TS sees `Buffer<ArrayBufferLike>`. Copy into a
// fresh ArrayBuffer-backed view at the persistence boundary.
function toBytes(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

export type IntegrationClaimTokenRow = {
  id: string;
  integrationId: string;
  tokenHash: string;
  encryptedSecret: Uint8Array | null;
  encryptionIv: Uint8Array | null;
  encryptionTag: Uint8Array | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

export type ClaimTokenCreated = {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
};

export type ClaimPeekResult =
  | { state: 'valid'; integrationId: string; expiresAt: Date }
  | { state: 'missing' }
  | { state: 'expired' }
  | { state: 'already_used' };

export type ClaimConsumeResult =
  | {
      state: 'consumed';
      integrationId: string;
      clientSecret: string;
      usedAt: Date;
    }
  | { state: 'missing' }
  | { state: 'expired' }
  | { state: 'already_used' };

function prismaClient(deps?: { prisma?: ClaimTokenPrisma }): ClaimTokenPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as ClaimTokenPrisma);
}

export function hashClaimToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Generate a 32-byte base64url claim token and its SHA-256 hash (hex). The raw
 * token is only surfaced to the caller — persist the hash, not the raw value.
 */
export function generateClaimToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashClaimToken(rawToken) };
}

function toRow(row: unknown): IntegrationClaimTokenRow {
  return row as IntegrationClaimTokenRow;
}

function toEncrypted(row: IntegrationClaimTokenRow): EncryptedClaimSecret | null {
  if (!row.encryptedSecret || !row.encryptionIv || !row.encryptionTag) return null;
  return {
    ciphertext: row.encryptedSecret,
    iv: row.encryptionIv,
    tag: row.encryptionTag,
  };
}

export type CreateClaimTokenParams = {
  integrationId: string;
  clientSecret: string;
  ttlMs?: number;
  now?: Date;
};

/**
 * Insert a claim token row wrapping an AES-256-GCM-encrypted copy of `clientSecret`.
 * Returns the raw token (for inclusion in the claim URL) and its hash. The raw token
 * is never persisted; callers must email it or discard it.
 */
export async function createClaimToken(
  params: CreateClaimTokenParams,
  deps?: { prisma?: ClaimTokenPrisma; sharedSecret?: string },
): Promise<ClaimTokenCreated> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const { rawToken, tokenHash } = generateClaimToken();
  const encrypted = encryptClaimSecret(params.clientSecret, { sharedSecret: deps?.sharedSecret });

  await prismaClient(deps).integrationClaimToken.create({
    data: {
      integrationId: params.integrationId,
      tokenHash,
      encryptedSecret: toBytes(encrypted.ciphertext),
      encryptionIv: toBytes(encrypted.iv),
      encryptionTag: toBytes(encrypted.tag),
      expiresAt,
    },
  });

  return { rawToken, tokenHash, expiresAt };
}

/**
 * Look up a claim row by raw token and report its state without modifying it.
 */
export async function peekClaim(
  rawToken: string,
  deps?: { prisma?: ClaimTokenPrisma; now?: Date },
): Promise<ClaimPeekResult> {
  const tokenHash = hashClaimToken(rawToken);
  const row = toRow(
    await prismaClient(deps).integrationClaimToken.findUnique({ where: { tokenHash } }),
  );
  if (!row) return { state: 'missing' };

  if (row.usedAt) return { state: 'already_used' };
  const now = deps?.now ?? new Date();
  if (row.expiresAt.getTime() <= now.getTime()) return { state: 'expired' };

  return { state: 'valid', integrationId: row.integrationId, expiresAt: row.expiresAt };
}

/**
 * Atomically validate, decrypt, and consume a claim token. On success returns the
 * decrypted `clientSecret`; the row's `usedAt` is set and the encrypted blob is
 * nulled in the same transaction, so the plaintext is only ever available once.
 */
export async function consumeClaim(
  rawToken: string,
  deps?: { prisma?: ClaimTokenPrisma; sharedSecret?: string; now?: Date },
): Promise<ClaimConsumeResult> {
  const tokenHash = hashClaimToken(rawToken);
  const prisma = prismaClient(deps);
  const now = deps?.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const row = toRow(
      await tx.integrationClaimToken.findUnique({ where: { tokenHash } }),
    );
    if (!row) return { state: 'missing' } as const;
    if (row.usedAt) return { state: 'already_used' } as const;
    if (row.expiresAt.getTime() <= now.getTime()) return { state: 'expired' } as const;

    const encrypted = toEncrypted(row);
    if (!encrypted) return { state: 'expired' } as const;

    // Conditional update: if a concurrent request consumed the token between our
    // findUnique and this write, `count` is 0 and we report `already_used`
    // without decrypting or returning the client secret. Prisma's default
    // READ COMMITTED isolation does not prevent two callers from both reading
    // `usedAt: null`, so the uniqueness must be enforced by a predicate-scoped
    // update rather than the prior read.
    const { count } = await tx.integrationClaimToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: {
        usedAt: now,
        encryptedSecret: null,
        encryptionIv: null,
        encryptionTag: null,
      },
    });
    if (count === 0) return { state: 'already_used' } as const;

    const clientSecret = decryptClaimSecret(encrypted, { sharedSecret: deps?.sharedSecret });

    return {
      state: 'consumed',
      integrationId: row.integrationId,
      clientSecret,
      usedAt: now,
    } as const;
  });
}

/**
 * Invalidate any outstanding claim tokens for `integrationId` and create a fresh one.
 * Used by resend-claim and by the admin Rotate flow.
 */
export async function replaceClaimToken(
  params: CreateClaimTokenParams,
  deps?: { prisma?: ClaimTokenPrisma; sharedSecret?: string },
): Promise<ClaimTokenCreated> {
  const now = params.now ?? new Date();
  const prisma = prismaClient(deps);

  return prisma.$transaction(async (tx) => {
    await tx.integrationClaimToken.deleteMany({
      where: { integrationId: params.integrationId, usedAt: null },
    });
    return createClaimToken(
      { ...params, now },
      { prisma: tx as unknown as ClaimTokenPrisma, sharedSecret: deps?.sharedSecret },
    );
  });
}

/**
 * Periodic sweep: null the encrypted blob on any expired rows that still carry it.
 * The row itself is retained for audit (it links to the integration request).
 */
export async function sweepExpiredClaims(
  deps?: { prisma?: ClaimTokenPrisma; now?: Date },
): Promise<{ nulled: number }> {
  const now = deps?.now ?? new Date();
  const { count } = await prismaClient(deps).integrationClaimToken.updateMany({
    where: {
      expiresAt: { lt: now },
      encryptedSecret: { not: null },
    },
    data: {
      encryptedSecret: null,
      encryptionIv: null,
      encryptionTag: null,
    },
  });
  return { nulled: count };
}
