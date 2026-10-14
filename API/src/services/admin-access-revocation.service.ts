import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
const hash = (token: string) => createHash('sha256').update(`uoa:admin-access-revocation:v1:${token}`).digest('hex');

/** Online Admin only. No identity/profile, raw bearer, or sibling-family authority. */
export async function assertAdminAccessNotRevoked(token: string, prisma: PrismaClient) {
  const row = await prisma.adminAccessTokenRevocation.findUnique({ where: { tokenHash: hash(token) }, select: { tokenHash: true } });
  if (row) throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
}
/** Caller already verified this exact bearer; retain through JWT clock tolerance. */
export async function revokeAdminAccess(token: string, prisma: PrismaClient) {
  const exp = decodeJwt(token).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new AppError('UNAUTHORIZED', 401);
  const expiresAt = new Date((exp + 31) * 1000);
  await prisma.adminAccessTokenRevocation.upsert({ where: { tokenHash: hash(token) },
    create: { tokenHash: hash(token), expiresAt }, update: {} });
}
