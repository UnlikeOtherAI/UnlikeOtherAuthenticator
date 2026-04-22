import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import { importJWK, type JWK, type KeyLike } from 'jose';
import { z } from 'zod';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog, type AuditLogPrisma } from './audit-log.service.js';

type ClientJwkPrisma = Pick<
  PrismaClient,
  'clientDomain' | 'clientDomainJwk' | 'adminAuditLog' | '$transaction'
>;

const privateJwkMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

export const PublicRsaJwkSchema = z
  .object({
    kty: z.literal('RSA'),
    kid: z.string().trim().min(1).max(256),
    n: z.string().trim().min(1),
    e: z.string().trim().min(1),
    alg: z.string().trim().min(1).optional(),
    use: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((key, ctx) => {
    for (const member of privateJwkMembers) {
      if (member in key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `private JWK member ${member} is not allowed`,
          path: [member],
        });
      }
    }
  });

export type PublicRsaJwk = z.infer<typeof PublicRsaJwkSchema>;

export const PublicRsaJwksSchema = z
  .object({
    keys: z.array(PublicRsaJwkSchema).min(1),
  })
  .passthrough();

export type PublicRsaJwks = z.infer<typeof PublicRsaJwksSchema>;

function prismaClient(deps?: { prisma?: ClientJwkPrisma }): ClientJwkPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as ClientJwkPrisma);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function computeJwkFingerprint(jwk: PublicRsaJwk): string {
  const canonical = JSON.stringify({ e: jwk.e, kid: jwk.kid, kty: jwk.kty, n: jwk.n });
  return base64url(createHash('sha256').update(canonical, 'utf8').digest());
}

export function parsePublicRsaJwk(input: unknown): PublicRsaJwk {
  const result = PublicRsaJwkSchema.safeParse(input);
  if (!result.success) throw new AppError('BAD_REQUEST', 400, 'INVALID_JWK');
  return result.data;
}

export function parsePublicRsaJwks(input: unknown): PublicRsaJwks {
  const result = PublicRsaJwksSchema.safeParse(input);
  if (!result.success) throw new AppError('BAD_REQUEST', 400, 'INVALID_JWKS');
  const keys: PublicRsaJwk[] = result.data.keys.map((entry) => {
    const parsed = PublicRsaJwkSchema.safeParse(entry);
    if (!parsed.success) throw new AppError('BAD_REQUEST', 400, 'INVALID_JWK');
    return parsed.data;
  });
  return { ...result.data, keys };
}

export function findJwkByKid(
  jwks: PublicRsaJwks,
  kid: string,
): PublicRsaJwk | null {
  const match = jwks.keys.find((key) => key.kid === kid);
  return match ?? null;
}

type ClientDomainJwkRow = {
  id: string;
  domainId: string;
  kid: string;
  jwk: Prisma.JsonValue;
  fingerprint: string;
  active: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
  createdByEmail: string | null;
};

type ClientDomainJwkWithDomain = ClientDomainJwkRow & {
  domain: { domain: string };
};

export async function listActiveJwks(
  deps?: { prisma?: ClientJwkPrisma },
): Promise<ClientDomainJwkRow[]> {
  return prismaClient(deps).clientDomainJwk.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listJwksForDomain(
  domain: string,
  deps?: { prisma?: ClientJwkPrisma },
): Promise<ClientDomainJwkRow[]> {
  const normalized = normalizeDomain(domain);
  const row = await prismaClient(deps).clientDomain.findUnique({
    where: { domain: normalized },
    select: { id: true },
  });
  if (!row) return [];
  return prismaClient(deps).clientDomainJwk.findMany({
    where: { domainId: row.id },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findJwkByKidDb(
  kid: string,
  deps?: { prisma?: ClientJwkPrisma },
): Promise<ClientDomainJwkWithDomain | null> {
  if (!kid) return null;
  const row = await prismaClient(deps).clientDomainJwk.findUnique({
    where: { kid },
    include: { domain: { select: { domain: true } } },
  });
  if (!row) return null;
  if (!row.active) return null;
  return row;
}

export async function addJwkForDomain(
  params: { domain: string; jwk: unknown; actorEmail: string },
  deps?: { prisma?: ClientJwkPrisma },
): Promise<ClientDomainJwkRow> {
  const normalized = normalizeDomain(params.domain);
  const jwk = parsePublicRsaJwk(params.jwk);
  const fingerprint = computeJwkFingerprint(jwk);

  const prisma = prismaClient(deps);
  return prisma.$transaction(async (tx) => {
    const domainRow = await tx.clientDomain.findUnique({
      where: { domain: normalized },
      select: { id: true },
    });
    if (!domainRow) throw new AppError('NOT_FOUND', 404, 'DOMAIN_NOT_FOUND');

    const existing = await tx.clientDomainJwk.findUnique({
      where: { kid: jwk.kid },
      select: { id: true, domainId: true },
    });
    if (existing && existing.domainId !== domainRow.id) {
      throw new AppError('BAD_REQUEST', 400, 'JWK_KID_CONFLICT');
    }

    const row = existing
      ? await tx.clientDomainJwk.update({
          where: { id: existing.id },
          data: {
            jwk: jwk as unknown as Prisma.InputJsonValue,
            fingerprint,
            active: true,
            deactivatedAt: null,
            createdByEmail: params.actorEmail,
          },
        })
      : await tx.clientDomainJwk.create({
          data: {
            domainId: domainRow.id,
            kid: jwk.kid,
            jwk: jwk as unknown as Prisma.InputJsonValue,
            fingerprint,
            active: true,
            createdByEmail: params.actorEmail,
          },
        });

    await writeAuditLog(
      {
        actorEmail: params.actorEmail,
        action: 'jwk.added',
        targetDomain: normalized,
        metadata: { kid: row.kid, fingerprint: row.fingerprint },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return row;
  });
}

export async function deactivateJwk(
  params: { domain: string; kid: string; actorEmail: string },
  deps?: { prisma?: ClientJwkPrisma },
): Promise<ClientDomainJwkRow> {
  const normalized = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  return prisma.$transaction(async (tx) => {
    const domainRow = await tx.clientDomain.findUnique({
      where: { domain: normalized },
      select: { id: true },
    });
    if (!domainRow) throw new AppError('NOT_FOUND', 404, 'DOMAIN_NOT_FOUND');

    const jwk = await tx.clientDomainJwk.findUnique({
      where: { kid: params.kid },
    });
    if (!jwk || jwk.domainId !== domainRow.id) {
      throw new AppError('NOT_FOUND', 404, 'JWK_NOT_FOUND');
    }
    if (!jwk.active) return jwk;

    const row = await tx.clientDomainJwk.update({
      where: { id: jwk.id },
      data: { active: false, deactivatedAt: new Date() },
    });

    await writeAuditLog(
      {
        actorEmail: params.actorEmail,
        action: 'jwk.deactivated',
        targetDomain: normalized,
        metadata: { kid: row.kid, fingerprint: row.fingerprint },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return row;
  });
}

export async function importClientJwkKey(jwk: PublicRsaJwk): Promise<KeyLike> {
  const key = await importJWK(jwk as unknown as JWK, jwk.alg ?? 'RS256');
  if (!isKeyLike(key)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_JWK');
  }
  return key;
}

function isKeyLike(value: unknown): value is KeyLike {
  return typeof value === 'object' && value !== null;
}

export function jwkToPublic(jwk: Prisma.JsonValue): PublicRsaJwk {
  return parsePublicRsaJwk(jwk);
}
