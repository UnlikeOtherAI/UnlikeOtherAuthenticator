import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const TOKEN_PATTERN = /^uoa_ledger_[A-Za-z0-9_-]{43}$/;

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
      throw new Error('invalid');
    }
    return value;
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_LEDGER_AUDIENCE_INVALID');
  }
}

export async function createLedgerRuntimeKey(
  params: { product: string; ledgerAudience: string; sourceDomain: string; actorEmail: string },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const service = await prisma.billingService.findUnique({
    where: { identifier: params.product }, select: { id: true, active: true },
  });
  if (!service?.active) throw new AppError('NOT_FOUND', 404, 'BILLING_SERVICE_NOT_FOUND');
  const sourceDomain = params.sourceDomain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(sourceDomain) || sourceDomain.startsWith('.') ||
    sourceDomain.endsWith('.')) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_LEDGER_SOURCE_DOMAIN_INVALID');
  }
  const secret = `uoa_ledger_${randomBytes(32).toString('base64url')}`;
  const key = await prisma.$transaction(async (tx) => {
    const created = await tx.billingLedgerRuntimeKey.create({
      data: {
        serviceId: service.id,
        secretDigest: digest(secret),
        keyPrefix: secret.slice(0, 18),
        ledgerAudience: origin(params.ledgerAudience),
        sourceDomain,
        createdByEmail: params.actorEmail,
      },
      select: { id: true, keyPrefix: true, createdAt: true },
    });
    await tx.adminAuditLog.create({ data: { actorEmail: params.actorEmail,
      action: 'billing.ledger_runtime_key_created', metadata: {
        key_id: created.id, service_id: service.id, ledger_audience: params.ledgerAudience,
        source_domain: sourceDomain,
      } } });
    return created;
  });
  return { ...key, secret };
}

export async function verifyLedgerRuntimeKey(secret: string, deps?: { prisma?: PrismaClient }) {
  if (!TOKEN_PATTERN.test(secret)) throw new AppError('UNAUTHORIZED', 401, 'INVALID_LEDGER_RUNTIME_KEY');
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await prisma.billingLedgerRuntimeKey.findUnique({
    where: { secretDigest: digest(secret) },
    include: { service: { select: { id: true, identifier: true, active: true } } },
  });
  if (!key || key.revokedAt || !key.service.active) {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_LEDGER_RUNTIME_KEY');
  }
  return key;
}

export async function revokeLedgerRuntimeKey(
  id: string, actorEmail: string, deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await prisma.$transaction(async (tx) => {
    const updated = await tx.billingLedgerRuntimeKey.update({
      where: { id }, data: { revokedAt: new Date() },
      select: { id: true, revokedAt: true },
    });
    await tx.adminAuditLog.create({ data: { actorEmail,
      action: 'billing.ledger_runtime_key_revoked', metadata: { key_id: id } } });
    return updated;
  });
  return key;
}
