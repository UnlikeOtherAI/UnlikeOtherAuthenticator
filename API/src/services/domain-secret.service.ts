import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv, requireEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog, type AuditLogPrisma } from './audit-log.service.js';

type DomainSecretPrisma = Pick<
  PrismaClient,
  'clientDomain' | 'clientDomainSecret' | 'adminAuditLog' | '$transaction'
>;

const activeSecretArgs = {
  where: { active: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} satisfies Prisma.ClientDomain$secretsArgs;

const domainWithActiveSecret = {
  include: { secrets: activeSecretArgs },
} satisfies Prisma.ClientDomainDefaultArgs;

type DomainWithActiveSecret = Prisma.ClientDomainGetPayload<typeof domainWithActiveSecret>;
type DomainStatus = 'active' | 'disabled';

export type DomainAuthResult = {
  clientId: string;
  domain: string;
  hashPrefix: string;
};

export type DomainMutationResult = {
  clientHash: string;
  clientHashPrefix: string;
  clientSecret: string;
  domain: DomainWithActiveSecret;
};

function prismaClient(deps?: { prisma?: DomainSecretPrisma }): DomainSecretPrisma {
  if (!getEnv().DATABASE_URL) throw new AppError('INTERNAL', 500, 'DOMAIN_SECRETS_DATABASE_REQUIRED');
  return deps?.prisma ?? (getAdminPrisma() as unknown as DomainSecretPrisma);
}

function normalizeStatus(status: string | undefined): DomainStatus {
  return status === 'disabled' ? 'disabled' : 'active';
}

function labelForDomain(domain: string, label?: string): string {
  const trimmed = label?.trim();
  return trimmed || domain;
}

function assertClientHash(value: string): string {
  const token = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError('UNAUTHORIZED', 401);
  return token;
}

function secureEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = Buffer.from(a, 'hex');
  const bBytes = Buffer.from(b, 'hex');
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}

export function generateClientSecret(): string {
  return randomBytes(36).toString('base64url');
}

export function createDomainClientHash(domain: string, clientSecret: string): string {
  return createHash('sha256').update(`${normalizeDomain(domain)}${clientSecret}`).digest('hex');
}

export function digestDomainClientHash(clientHash: string, pepper = requireEnv('SHARED_SECRET').SHARED_SECRET): string {
  return createHmac('sha256', pepper).update(clientHash, 'utf8').digest('hex');
}

async function createSecretData(domain: string, clientSecret?: string) {
  const secret = clientSecret?.trim() || generateClientSecret();
  if (secret.length < 32) throw new AppError('BAD_REQUEST', 400, 'CLIENT_SECRET_TOO_SHORT');
  const clientHash = createDomainClientHash(domain, secret);
  return {
    clientHash,
    clientSecret: secret,
    hashPrefix: clientHash.slice(0, 12),
    secretDigest: digestDomainClientHash(clientHash),
  };
}

export async function verifyDomainAuthToken(
  params: { domain: string; token: string },
  deps?: { prisma?: DomainSecretPrisma },
): Promise<DomainAuthResult> {
  const domain = normalizeDomain(params.domain);
  const clientHash = assertClientHash(params.token);
  const row = await prismaClient(deps).clientDomain.findUnique({
    where: { domain },
    include: { secrets: { where: { active: true }, select: { secretDigest: true, hashPrefix: true } } },
  });

  if (!row || normalizeStatus(row.status) !== 'active' || row.secrets.length === 0) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  const digest = digestDomainClientHash(clientHash);
  const matched = row.secrets.find((secret) => secureEqualHex(digest, secret.secretDigest));
  if (!matched) throw new AppError('UNAUTHORIZED', 401);

  return { clientId: clientHash, domain, hashPrefix: matched.hashPrefix };
}

export async function createAdminDomain(
  params: { clientSecret?: string; domain: string; label?: string; actorEmail: string },
  deps?: { prisma?: DomainSecretPrisma },
): Promise<DomainMutationResult> {
  const prisma = prismaClient(deps);
  const domain = normalizeDomain(params.domain);
  const secret = await createSecretData(domain, params.clientSecret);

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.clientDomain.findUnique({ where: { domain }, select: { id: true } });
    if (existing) throw new AppError('BAD_REQUEST', 400, 'DOMAIN_ALREADY_EXISTS');

    const created = await tx.clientDomain.create({
      data: {
        domain,
        label: labelForDomain(domain, params.label),
        status: 'active',
        secrets: {
          create: {
            active: true,
            hashPrefix: secret.hashPrefix,
            secretDigest: secret.secretDigest,
          },
        },
      },
      ...domainWithActiveSecret,
    });

    await writeAuditLog(
      {
        actorEmail: params.actorEmail,
        action: 'domain.enabled',
        targetDomain: domain,
        metadata: { hashPrefix: secret.hashPrefix, created: true },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return created;
  });

  return { clientHash: secret.clientHash, clientHashPrefix: secret.hashPrefix, clientSecret: secret.clientSecret, domain: row };
}

export async function updateAdminDomain(
  params: { domain: string; label?: string; status?: DomainStatus; actorEmail: string },
  deps?: { prisma?: DomainSecretPrisma },
): Promise<DomainWithActiveSecret> {
  const prisma = prismaClient(deps);
  const domain = normalizeDomain(params.domain);
  const label = params.label === undefined ? undefined : labelForDomain(domain, params.label);
  const status = params.status === undefined ? undefined : normalizeStatus(params.status);

  return prisma.$transaction(async (tx) => {
    const prior = await tx.clientDomain.findUnique({
      where: { domain },
      select: { status: true },
    });

    const row = await tx.clientDomain.upsert({
      where: { domain },
      create: { domain, label: label ?? domain, status: status ?? 'active' },
      update: { ...(label ? { label } : {}), ...(status ? { status } : {}) },
      ...domainWithActiveSecret,
    });

    const priorStatus = prior ? normalizeStatus(prior.status) : undefined;
    const nextStatus = normalizeStatus(row.status);
    if (status !== undefined && priorStatus !== nextStatus) {
      await writeAuditLog(
        {
          actorEmail: params.actorEmail,
          action: nextStatus === 'disabled' ? 'domain.disabled' : 'domain.enabled',
          targetDomain: domain,
          metadata: { priorStatus: priorStatus ?? null, nextStatus },
        },
        { prisma: tx as unknown as AuditLogPrisma },
      );
    }

    return row;
  });
}

export async function rotateAdminDomainSecret(
  params: { clientSecret?: string; domain: string; actorEmail: string },
  deps?: { prisma?: DomainSecretPrisma },
): Promise<DomainMutationResult> {
  const prisma = prismaClient(deps);
  const domain = normalizeDomain(params.domain);
  const secret = await createSecretData(domain, params.clientSecret);
  const now = new Date();

  const row = await prisma.$transaction(async (tx) => {
    const registry = await tx.clientDomain.upsert({
      where: { domain },
      create: { domain, label: domain, status: 'active' },
      update: { status: 'active' },
      select: { id: true },
    });
    await tx.clientDomainSecret.updateMany({
      where: { domainId: registry.id, active: true },
      data: { active: false, deactivatedAt: now },
    });
    await tx.clientDomainSecret.create({
      data: {
        domainId: registry.id,
        active: true,
        hashPrefix: secret.hashPrefix,
        secretDigest: secret.secretDigest,
      },
    });

    await writeAuditLog(
      {
        actorEmail: params.actorEmail,
        action: 'domain.secret_rotated',
        targetDomain: domain,
        metadata: { hashPrefix: secret.hashPrefix },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return tx.clientDomain.findUniqueOrThrow({ where: { domain }, ...domainWithActiveSecret });
  });

  return { clientHash: secret.clientHash, clientHashPrefix: secret.hashPrefix, clientSecret: secret.clientSecret, domain: row };
}
