import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeSignatureAdminAudit } from './signature-admin-audit.service.js';
import { hashPdf } from './signature-pdf.service.js';
import {
  createSignatureObjectStorage,
  type SignatureObjectStorage,
} from './signature-storage.service.js';

type SignatureOperationsPrisma = Pick<
  PrismaClient,
  | 'agreementSignature'
  | 'signatureRevocation'
  | 'signatureAuditEvent'
  | 'adminAuditLog'
  | '$transaction'
>;

type SignatureOperationsDeps = {
  prisma?: SignatureOperationsPrisma;
  storage?: SignatureObjectStorage;
};

function prismaClient(deps?: SignatureOperationsDeps): SignatureOperationsPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as SignatureOperationsPrisma);
}

function storageClient(deps?: SignatureOperationsDeps): SignatureObjectStorage {
  return deps?.storage ?? createSignatureObjectStorage();
}

function dateRange(from?: Date, to?: Date): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

export async function searchAgreementSignatures(
  params: {
    domain: string;
    query?: string;
    agreementId?: string;
    agreementVersionId?: string;
    from?: Date;
    to?: Date;
    cursor?: string;
    limit: number;
  },
  deps?: SignatureOperationsDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  if (params.from && params.to && params.from > params.to) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_DATE_RANGE');
  }
  if (params.cursor) {
    const cursor = await prisma.agreementSignature.findFirst({
      where: { id: params.cursor, domain },
      select: { id: true },
    });
    if (!cursor) throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_CURSOR');
  }
  const query = params.query?.trim();
  const rows = await prisma.agreementSignature.findMany({
    where: {
      domain,
      ...(params.agreementVersionId
        ? { agreementVersionId: params.agreementVersionId }
        : params.agreementId
          ? { version: { agreementId: params.agreementId } }
          : {}),
      ...(dateRange(params.from, params.to) ? { signedAt: dateRange(params.from, params.to) } : {}),
      ...(query
        ? {
            OR: [
              { userEmail: { contains: query, mode: 'insensitive' } },
              { signerName: { contains: query, mode: 'insensitive' } },
              { verificationReference: { contains: query } },
            ],
          }
        : {}),
    },
    orderBy: [{ signedAt: 'desc' }, { id: 'desc' }],
    take: params.limit,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      version: { include: { agreement: true } },
      revocation: true,
    },
  });
  return {
    data: rows,
    nextCursor: rows.length === params.limit ? rows.at(-1)?.id ?? null : null,
  };
}

async function findSignatureOrThrow(
  prisma: SignatureOperationsPrisma,
  domain: string,
  signatureId: string,
) {
  const signature = await prisma.agreementSignature.findFirst({
    where: { id: signatureId, domain },
    include: {
      version: { include: { agreement: true } },
      revocation: true,
    },
  });
  if (!signature) throw new AppError('NOT_FOUND', 404, 'SIGNATURE_NOT_FOUND');
  return signature;
}

export async function readAdminSignatureReceipt(
  params: { domain: string; signatureId: string; actorEmail: string },
  deps?: SignatureOperationsDeps,
): Promise<{ filename: string; value: Buffer; sha256: string }> {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  const signature = await findSignatureOrThrow(prisma, domain, params.signatureId);
  const value = await storageClient(deps).read(signature.receiptStorageKey);
  if (hashPdf(value) !== signature.receiptPdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_RECEIPT_HASH_MISMATCH');
  }
  await runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.receipt_accessed',
        targetType: 'signature',
        targetId: signature.id,
        metadata: {
          agreement_id: signature.version.agreementId,
          agreement_version_id: signature.agreementVersionId,
          receipt_pdf_sha256: signature.receiptPdfSha256,
        },
      },
      { prisma: tx },
    );
  });
  const safeTitle = signature.version.agreement.title.replace(/[^a-zA-Z0-9._-]+/gu, '-');
  return {
    filename: `${safeTitle || 'agreement'}-v${signature.version.version}-receipt.pdf`,
    value,
    sha256: signature.receiptPdfSha256,
  };
}

function isUniqueConflict(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export async function revokeAgreementSignature(
  params: { domain: string; signatureId: string; reason: string; actorEmail: string },
  deps?: SignatureOperationsDeps,
) {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  const reason = params.reason.trim();
  if (reason.length < 1 || reason.length > 1000) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_REVOCATION_REASON');
  }
  try {
    return await runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
      const signature = await findSignatureOrThrow(
        tx as unknown as SignatureOperationsPrisma,
        domain,
        params.signatureId,
      );
      if (signature.revocation) return signature.revocation;
      const revocation = await tx.signatureRevocation.create({
        data: {
          signatureId: signature.id,
          actorEmail: params.actorEmail,
          reason,
        },
      });
      await writeSignatureAdminAudit(
        {
          domain,
          actorEmail: params.actorEmail,
          action: 'signature.revoked',
          targetType: 'signature',
          targetId: signature.id,
          metadata: {
            agreement_version_id: signature.agreementVersionId,
            reason,
          } as Prisma.InputJsonValue,
        },
        { prisma: tx },
      );
      return revocation;
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const signature = await findSignatureOrThrow(prisma, domain, params.signatureId);
    if (signature.revocation) return signature.revocation;
    throw err;
  }
}
