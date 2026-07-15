import type { PrismaClient } from '@prisma/client';

import { getEnv, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeSignatureAdminAudit } from './signature-admin-audit.service.js';

type SignatureAdminPrisma = Pick<
  PrismaClient,
  | 'clientDomain'
  | 'domainSignatureSettings'
  | 'agreement'
  | 'agreementVersion'
  | 'signatureAuditEvent'
  | 'adminAuditLog'
  | '$transaction'
>;

type SignatureAdminDeps = { prisma?: SignatureAdminPrisma; env?: Env; now?: () => Date };

function prismaClient(deps?: SignatureAdminDeps): SignatureAdminPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as SignatureAdminPrisma);
}

function now(deps?: SignatureAdminDeps): Date {
  return deps?.now?.() ?? new Date();
}

async function requireDomain(prisma: SignatureAdminPrisma, domain: string): Promise<void> {
  const exists = await prisma.clientDomain.findUnique({
    where: { domain },
    select: { domain: true },
  });
  if (!exists) throw new AppError('NOT_FOUND', 404, 'DOMAIN_NOT_FOUND');
}

export function assertSignatureRuntimeReady(env: Env = getEnv()): void {
  if (env.SIGNATURE_STORAGE_PROVIDER === 'disabled') {
    throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_STORAGE_NOT_CONFIGURED');
  }
  if (env.SIGNATURE_MALWARE_SCANNER !== 'clamav') {
    throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_MALWARE_SCANNER_NOT_CONFIGURED');
  }
  if (!env.SIGNATURE_EVIDENCE_PRIVATE_JWK || !env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON) {
    throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_EVIDENCE_KEYS_NOT_CONFIGURED');
  }
}

export async function getSignatureAdminOverview(
  inputDomain: string,
  deps?: SignatureAdminDeps,
) {
  const domain = normalizeDomain(inputDomain);
  const prisma = prismaClient(deps);
  await requireDomain(prisma, domain);
  const [settings, agreements, auditEvents] = await Promise.all([
    prisma.domainSignatureSettings.findUnique({ where: { domain } }),
    prisma.agreement.findMany({
      where: { domain },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        versions: {
          orderBy: { version: 'desc' },
          include: { _count: { select: { signatures: true } } },
        },
      },
    }),
    prisma.signatureAuditEvent.findMany({
      where: { domain },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  return {
    settings: settings ?? {
      domain,
      enabled: false,
      policyRevision: 0,
      retentionDays: null,
      createdAt: null,
      updatedAt: null,
    },
    agreements,
    auditEvents,
  };
}

export async function updateSignatureSettings(
  params: {
    domain: string;
    enabled: boolean;
    retentionDays: number | null;
    actorEmail: string;
  },
  deps?: SignatureAdminDeps,
) {
  const domain = normalizeDomain(params.domain);
  if (
    params.retentionDays !== null &&
    (!Number.isInteger(params.retentionDays) ||
      params.retentionDays < 1 ||
      params.retentionDays > 36_500)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_RETENTION');
  }
  if (params.enabled && params.retentionDays === null) {
    throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_RETENTION_REQUIRED');
  }
  if (params.enabled) assertSignatureRuntimeReady(deps?.env ?? getEnv());

  const prisma = prismaClient(deps);
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    await requireDomain(tx as unknown as SignatureAdminPrisma, domain);
    const existing = await tx.domainSignatureSettings.findUnique({ where: { domain } });
    if (params.enabled) {
      const activeRequiredCount = await tx.agreement.count({
        where: {
          domain,
          requiredForAccess: true,
          versions: {
            some: {
              status: 'PUBLISHED',
              OR: [{ effectiveAt: null }, { effectiveAt: { lte: now(deps) } }],
            },
          },
        },
      });
      if (activeRequiredCount < 1) {
        throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_PUBLISHED_REQUIREMENT_REQUIRED');
      }
    }

    const changed =
      !existing ||
      existing.enabled !== params.enabled ||
      existing.retentionDays !== params.retentionDays;
    if (!changed && existing) return existing;

    const settings = await tx.domainSignatureSettings.upsert({
      where: { domain },
      create: {
        domain,
        enabled: params.enabled,
        retentionDays: params.retentionDays,
        policyRevision: 1,
      },
      update: {
        enabled: params.enabled,
        retentionDays: params.retentionDays,
        policyRevision: { increment: 1 },
      },
    });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.settings_updated',
        targetType: 'settings',
        targetId: domain,
        metadata: {
          enabled: settings.enabled,
          retention_days: settings.retentionDays,
          policy_revision: settings.policyRevision,
        },
      },
      { prisma: tx },
    );
    return settings;
  });
}

export async function createAgreement(
  params: {
    domain: string;
    title: string;
    description: string | null;
    displayOrder: number;
    requiredForAccess: boolean;
    actorEmail: string;
  },
  deps?: SignatureAdminDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    await requireDomain(tx as unknown as SignatureAdminPrisma, domain);
    await tx.domainSignatureSettings.upsert({
      where: { domain },
      create: { domain, enabled: false },
      update: {},
    });
    const agreement = await tx.agreement.create({
      data: {
        domain,
        title: params.title,
        description: params.description,
        displayOrder: params.displayOrder,
        requiredForAccess: params.requiredForAccess,
      },
    });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.agreement_created',
        targetType: 'agreement',
        targetId: agreement.id,
        metadata: {
          display_order: agreement.displayOrder,
          required_for_access: agreement.requiredForAccess,
        },
      },
      { prisma: tx },
    );
    return agreement;
  });
}

export async function updateAgreement(
  params: {
    domain: string;
    agreementId: string;
    title: string;
    description: string | null;
    displayOrder: number;
    requiredForAccess: boolean;
    actorEmail: string;
  },
  deps?: SignatureAdminDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    const existing = await tx.agreement.findFirst({
      where: { id: params.agreementId, domain },
    });
    if (!existing) throw new AppError('NOT_FOUND', 404, 'AGREEMENT_NOT_FOUND');
    const settings = await tx.domainSignatureSettings.findUnique({ where: { domain } });
    if (settings?.enabled && params.requiredForAccess && !existing.requiredForAccess) {
      const published = await tx.agreementVersion.count({
        where: {
          agreementId: existing.id,
          status: 'PUBLISHED',
          OR: [{ effectiveAt: null }, { effectiveAt: { lte: now(deps) } }],
        },
      });
      if (published < 1) {
        throw new AppError('BAD_REQUEST', 409, 'AGREEMENT_PUBLISHED_VERSION_REQUIRED');
      }
    }
    if (settings?.enabled && !params.requiredForAccess && existing.requiredForAccess) {
      const otherActiveRequirements = await tx.agreement.count({
        where: {
          domain,
          id: { not: existing.id },
          requiredForAccess: true,
          versions: {
            some: {
              status: 'PUBLISHED',
              OR: [{ effectiveAt: null }, { effectiveAt: { lte: now(deps) } }],
            },
          },
        },
      });
      if (otherActiveRequirements < 1) {
        throw new AppError('BAD_REQUEST', 409, 'LAST_REQUIRED_AGREEMENT_CANNOT_BE_REMOVED');
      }
    }
    const agreement = await tx.agreement.update({
      where: { id: existing.id },
      data: {
        title: params.title,
        description: params.description,
        displayOrder: params.displayOrder,
        requiredForAccess: params.requiredForAccess,
      },
    });
    if (settings && existing.requiredForAccess !== agreement.requiredForAccess) {
      await tx.domainSignatureSettings.update({
        where: { domain },
        data: { policyRevision: { increment: 1 } },
      });
    }
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.agreement_updated',
        targetType: 'agreement',
        targetId: agreement.id,
        metadata: {
          display_order: agreement.displayOrder,
          required_for_access: agreement.requiredForAccess,
        },
      },
      { prisma: tx },
    );
    return agreement;
  });
}
