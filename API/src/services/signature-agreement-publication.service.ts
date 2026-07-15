import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeSignatureAdminAudit } from './signature-admin-audit.service.js';

type SignaturePublicationPrisma = Pick<
  PrismaClient,
  | 'agreement'
  | 'agreementVersion'
  | 'domainSignatureSettings'
  | 'signatureAuditEvent'
  | 'adminAuditLog'
  | '$transaction'
>;

type SignaturePublicationDeps = {
  prisma?: SignaturePublicationPrisma;
  now?: () => Date;
};

function prismaClient(deps?: SignaturePublicationDeps): SignaturePublicationPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as SignaturePublicationPrisma);
}

async function findAgreement(
  prisma: SignaturePublicationPrisma,
  domain: string,
  agreementId: string,
) {
  const agreement = await prisma.agreement.findFirst({ where: { id: agreementId, domain } });
  if (!agreement) throw new AppError('NOT_FOUND', 404, 'AGREEMENT_NOT_FOUND');
  return agreement;
}

async function findVersion(
  prisma: SignaturePublicationPrisma,
  domain: string,
  agreementId: string,
  versionId: string,
) {
  const version = await prisma.agreementVersion.findFirst({
    where: { id: versionId, agreementId, agreement: { domain } },
    include: { agreement: true },
  });
  if (!version) throw new AppError('NOT_FOUND', 404, 'AGREEMENT_VERSION_NOT_FOUND');
  return version;
}

export async function publishAgreementVersion(
  params: {
    domain: string;
    agreementId: string;
    versionId: string;
    effectiveAt: Date;
    actorEmail: string;
  },
  deps?: SignaturePublicationDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  const publishedAt = deps?.now?.() ?? new Date();
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    const agreement = await findAgreement(
      tx as unknown as SignaturePublicationPrisma,
      domain,
      params.agreementId,
    );
    await tx.agreement.update({ where: { id: agreement.id }, data: { updatedAt: publishedAt } });
    const version = await findVersion(
      tx as unknown as SignaturePublicationPrisma,
      domain,
      agreement.id,
      params.versionId,
    );
    if (version.status !== 'DRAFT') {
      throw new AppError('BAD_REQUEST', 409, 'VERSION_NOT_PUBLISHABLE');
    }
    const settings = await tx.domainSignatureSettings.findUnique({ where: { domain } });
    if (settings?.enabled && agreement.requiredForAccess && params.effectiveAt > publishedAt) {
      throw new AppError('BAD_REQUEST', 409, 'FUTURE_REQUIRED_VERSION_NOT_ALLOWED_WHILE_ENABLED');
    }
    await tx.agreementVersion.updateMany({
      where: { agreementId: agreement.id, status: 'PUBLISHED' },
      data: { status: 'SUPERSEDED' },
    });
    const published = await tx.agreementVersion.update({
      where: { id: version.id },
      data: {
        status: 'PUBLISHED',
        publishedAt,
        effectiveAt: params.effectiveAt,
        publishedByEmail: params.actorEmail,
      },
    });
    await tx.domainSignatureSettings.update({
      where: { domain },
      data: { policyRevision: { increment: 1 } },
    });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.version_published',
        targetType: 'agreement_version',
        targetId: published.id,
        metadata: {
          agreement_id: agreement.id,
          version: published.version,
          source_pdf_sha256: published.sourcePdfSha256,
          effective_at: params.effectiveAt.toISOString(),
        },
      },
      { prisma: tx },
    );
    return published;
  });
}

export async function withdrawAgreementVersion(
  params: { domain: string; agreementId: string; versionId: string; actorEmail: string },
  deps?: SignaturePublicationDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    const version = await findVersion(
      tx as unknown as SignaturePublicationPrisma,
      domain,
      params.agreementId,
      params.versionId,
    );
    if (version.status !== 'PUBLISHED') {
      throw new AppError('BAD_REQUEST', 409, 'VERSION_NOT_WITHDRAWABLE');
    }
    const settings = await tx.domainSignatureSettings.findUnique({ where: { domain } });
    if (settings?.enabled && version.agreement.requiredForAccess) {
      throw new AppError('BAD_REQUEST', 409, 'REQUIRED_VERSION_CANNOT_BE_WITHDRAWN_WHILE_ENABLED');
    }
    const withdrawn = await tx.agreementVersion.update({
      where: { id: version.id },
      data: { status: 'WITHDRAWN' },
    });
    await tx.domainSignatureSettings.update({
      where: { domain },
      data: { policyRevision: { increment: 1 } },
    });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.version_withdrawn',
        targetType: 'agreement_version',
        targetId: withdrawn.id,
        metadata: { agreement_id: version.agreementId, version: version.version },
      },
      { prisma: tx },
    );
    return withdrawn;
  });
}
