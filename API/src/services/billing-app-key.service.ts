import type { Prisma, PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import {
  billingAppKeyDisplayPrefix,
  digestBillingAppKey,
  generateBillingAppKey,
} from '../utils/billing-app-key.js';
import { AppError } from '../utils/errors.js';
import { importClientJwkKey, parsePublicRsaJwk, type PublicRsaJwk } from './client-jwk.service.js';

export type BillingAppKeyRecord = {
  id: string;
  serviceId: string;
  name: string;
  keyPrefix: string;
  actorIssuer: string;
  actorAudience: string;
  actorKeyId: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdByEmail: string | null;
  createdAt: Date;
};

export type VerifiedBillingAppKey = {
  id: string;
  actorIssuer: string;
  actorAudience: string;
  actorKeyId: string;
  actorPublicJwk: Prisma.JsonValue;
  service: {
    id: string;
    identifier: string;
    name: string;
  };
};

type BillingAppKeyPrisma = Pick<
  PrismaClient,
  'billingService' | 'billingAppKey' | 'adminAuditLog' | '$transaction'
>;

const recordSelect = {
  id: true,
  serviceId: true,
  name: true,
  keyPrefix: true,
  actorIssuer: true,
  actorAudience: true,
  actorKeyId: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdByEmail: true,
  createdAt: true,
} as const;

function prismaClient(deps?: { prisma?: BillingAppKeyPrisma }): BillingAppKeyPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as BillingAppKeyPrisma);
}

function normalizeHttpsUrl(value: string, code: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error('invalid');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new AppError('BAD_REQUEST', 400, code);
  }
}

function validateActorJwk(input: unknown): PublicRsaJwk {
  const jwk = parsePublicRsaJwk(input);
  if ((jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_ACTOR_JWK');
  }
  return jwk;
}

export async function createBillingAppKey(
  params: {
    serviceId: string;
    name: string;
    actorIssuer: string;
    actorAudience: string;
    actorPublicJwk: unknown;
    expiresAt?: Date | null;
    createdBy?: { userId?: string | null; email?: string | null };
  },
  deps?: { prisma?: BillingAppKeyPrisma },
): Promise<{ record: BillingAppKeyRecord; plaintext: string }> {
  const name = params.name.trim();
  if (!name || name.length > 120) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_APP_KEY_NAME');
  }
  if (params.expiresAt && Number.isNaN(params.expiresAt.getTime())) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_APP_KEY_EXPIRY');
  }

  const actorIssuer = normalizeHttpsUrl(params.actorIssuer, 'INVALID_ACTOR_ISSUER');
  const actorAudience = normalizeHttpsUrl(params.actorAudience, 'INVALID_ACTOR_AUDIENCE');
  const requiredActorAudience = normalizeHttpsUrl(
    `${getPublicBaseUrl()}/billing/v1/effective-tariff`,
    'INVALID_ACTOR_AUDIENCE',
  );
  if (actorAudience !== requiredActorAudience) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_ACTOR_AUDIENCE');
  }
  const actorPublicJwk = validateActorJwk(params.actorPublicJwk);
  await importClientJwkKey(actorPublicJwk);

  const plaintext = generateBillingAppKey();
  const prisma = prismaClient(deps);
  const record = await prisma.$transaction(async (tx) => {
    const service = await tx.billingService.findUnique({
      where: { id: params.serviceId },
      select: { id: true, identifier: true, active: true },
    });
    if (!service?.active) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_SERVICE_NOT_FOUND');
    }

    const created = await tx.billingAppKey.create({
      data: {
        serviceId: service.id,
        name,
        keyPrefix: billingAppKeyDisplayPrefix(plaintext),
        secretDigest: digestBillingAppKey(plaintext),
        actorIssuer,
        actorAudience,
        actorKeyId: actorPublicJwk.kid,
        actorPublicJwk: actorPublicJwk as unknown as Prisma.InputJsonValue,
        expiresAt: params.expiresAt ?? null,
        createdByUserId: params.createdBy?.userId ?? null,
        createdByEmail: params.createdBy?.email ?? null,
      },
      select: recordSelect,
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.createdBy?.email ?? 'unknown',
        action: 'billing.app_key_created',
        metadata: {
          service_id: service.id,
          product: service.identifier,
          app_key_id: created.id,
          actor_kid: actorPublicJwk.kid,
        },
      },
    });
    return created;
  });

  return { record, plaintext };
}

export async function listBillingAppKeys(
  serviceId: string,
  deps?: { prisma?: BillingAppKeyPrisma },
): Promise<BillingAppKeyRecord[]> {
  return prismaClient(deps).billingAppKey.findMany({
    where: { serviceId },
    orderBy: { createdAt: 'desc' },
    select: recordSelect,
  });
}

export async function revokeBillingAppKey(
  params: { serviceId: string; keyId: string; actorEmail: string },
  deps?: { prisma?: BillingAppKeyPrisma },
): Promise<void> {
  const prisma = prismaClient(deps);
  await prisma.$transaction(async (tx) => {
    const key = await tx.billingAppKey.findFirst({
      where: { id: params.keyId, serviceId: params.serviceId },
      select: { id: true, revokedAt: true },
    });
    if (!key) throw new AppError('NOT_FOUND', 404, 'BILLING_APP_KEY_NOT_FOUND');
    if (!key.revokedAt) {
      await tx.billingAppKey.update({
        where: { id: key.id },
        data: { revokedAt: new Date() },
      });
    }
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actorEmail,
        action: 'billing.app_key_revoked',
        metadata: { service_id: params.serviceId, app_key_id: key.id },
      },
    });
  });
}

export async function verifyBillingAppKey(
  rawKey: string,
  deps?: { prisma?: BillingAppKeyPrisma; now?: () => Date },
): Promise<VerifiedBillingAppKey> {
  if (!getEnv().DATABASE_URL) throw new AppError('UNAUTHORIZED', 401);
  const now = deps?.now?.() ?? new Date();
  const prisma = prismaClient(deps);
  const row = await prisma.billingAppKey.findUnique({
    where: { secretDigest: digestBillingAppKey(rawKey) },
    select: {
      id: true,
      actorIssuer: true,
      actorAudience: true,
      actorKeyId: true,
      actorPublicJwk: true,
      revokedAt: true,
      expiresAt: true,
      service: {
        select: { id: true, identifier: true, name: true, active: true },
      },
    },
  });

  if (
    !row ||
    row.revokedAt ||
    (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) ||
    !row.service.active
  ) {
    throw new AppError('UNAUTHORIZED', 401);
  }

  try {
    await prisma.billingAppKey.update({
      where: { id: row.id },
      data: { lastUsedAt: now },
    });
  } catch {
    // Credential validity is authoritative; a telemetry touch is not.
  }

  return {
    id: row.id,
    actorIssuer: row.actorIssuer,
    actorAudience: row.actorAudience,
    actorKeyId: row.actorKeyId,
    actorPublicJwk: row.actorPublicJwk,
    service: {
      id: row.service.id,
      identifier: row.service.identifier,
      name: row.service.name,
    },
  };
}
