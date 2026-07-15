import { randomUUID } from 'node:crypto';

import type { PrismaClient, SignatureMethod } from '@prisma/client';

import { getEnv, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeSignatureAdminAudit } from './signature-admin-audit.service.js';
import {
  createSignatureMalwareScanner,
  type SignatureMalwareScanner,
} from './signature-malware.service.js';
import { hashPdf, validateSourcePdf } from './signature-pdf.service.js';
import {
  createSignatureObjectStorage,
  validateSignatureStorageKey,
  type SignatureObjectStorage,
} from './signature-storage.service.js';

type SignatureLifecyclePrisma = Pick<
  PrismaClient,
  | 'agreement'
  | 'agreementVersion'
  | 'domainSignatureSettings'
  | 'signatureAuditEvent'
  | 'adminAuditLog'
  | '$transaction'
>;

type SignatureLifecycleDeps = {
  prisma?: SignatureLifecyclePrisma;
  storage?: SignatureObjectStorage;
  scanner?: SignatureMalwareScanner;
  env?: Env;
  now?: () => Date;
  idFactory?: () => string;
};

function prismaClient(deps?: SignatureLifecycleDeps): SignatureLifecyclePrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as SignatureLifecyclePrisma);
}

function environment(deps?: SignatureLifecycleDeps): Env {
  return deps?.env ?? getEnv();
}

function objectStorage(deps?: SignatureLifecycleDeps): SignatureObjectStorage {
  return deps?.storage ?? createSignatureObjectStorage(environment(deps));
}

function malwareScanner(deps?: SignatureLifecycleDeps): SignatureMalwareScanner {
  return deps?.scanner ?? createSignatureMalwareScanner(environment(deps));
}

function currentTime(deps?: SignatureLifecycleDeps): Date {
  return deps?.now?.() ?? new Date();
}

function newId(deps?: SignatureLifecycleDeps): string {
  return deps?.idFactory?.() ?? randomUUID();
}

function cleanText(value: string, max: number, error: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) {
    throw new AppError('BAD_REQUEST', 400, error);
  }
  return normalized;
}

function cleanFilename(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    !normalized.toLowerCase().endsWith('.pdf')
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_PDF_FILENAME');
  }
  return normalized;
}

async function findAgreementOrThrow(
  prisma: SignatureLifecyclePrisma,
  domain: string,
  agreementId: string,
) {
  const agreement = await prisma.agreement.findFirst({ where: { id: agreementId, domain } });
  if (!agreement) throw new AppError('NOT_FOUND', 404, 'AGREEMENT_NOT_FOUND');
  return agreement;
}

async function findVersionOrThrow(
  prisma: SignatureLifecyclePrisma,
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

async function validateAndScanPdf(
  sourcePdf: Uint8Array,
  deps?: SignatureLifecycleDeps,
) {
  const validation = await validateSourcePdf(sourcePdf, environment(deps));
  await malwareScanner(deps).scanPdf(sourcePdf);
  return validation;
}

export async function uploadDraftAgreementVersion(
  params: {
    domain: string;
    agreementId: string;
    title: string;
    originalFilename: string;
    signingMethod: SignatureMethod;
    acceptanceStatement: string;
    sourcePdf: Uint8Array;
    actorEmail: string;
  },
  deps?: SignatureLifecycleDeps,
) {
  const domain = normalizeDomain(params.domain);
  const title = cleanText(params.title, 200, 'INVALID_AGREEMENT_VERSION_TITLE');
  const originalFilename = cleanFilename(params.originalFilename);
  const acceptanceStatement = cleanText(
    params.acceptanceStatement,
    4000,
    'INVALID_ACCEPTANCE_STATEMENT',
  );
  const validation = await validateAndScanPdf(params.sourcePdf, deps);
  const prisma = prismaClient(deps);
  const storage = objectStorage(deps);
  const versionId = newId(deps);
  let storedKey: string | undefined;
  try {
    return await runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
      const agreement = await findAgreementOrThrow(
        tx as unknown as SignatureLifecyclePrisma,
        domain,
        params.agreementId,
      );
      await tx.agreement.update({
        where: { id: agreement.id },
        data: { updatedAt: currentTime(deps) },
      });
      const latest = await tx.agreementVersion.findFirst({
        where: { agreementId: agreement.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const versionNumber = (latest?.version ?? 0) + 1;
      storedKey = validateSignatureStorageKey(
        `sources/${domain}/${agreement.id}/${versionId}/source.pdf`,
      );
      await storage.putImmutable(storedKey, params.sourcePdf, 'application/pdf');
      const version = await tx.agreementVersion.create({
        data: {
          id: versionId,
          agreementId: agreement.id,
          version: versionNumber,
          title,
          originalFilename,
          sourceStorageKey: storedKey,
          sourcePdfSha256: validation.sha256,
          signingMethod: params.signingMethod,
          acceptanceStatement,
        },
      });
      await writeSignatureAdminAudit(
        {
          domain,
          actorEmail: params.actorEmail,
          action: 'signature.version_uploaded',
          targetType: 'agreement_version',
          targetId: version.id,
          metadata: {
            agreement_id: agreement.id,
            version: version.version,
            source_pdf_sha256: version.sourcePdfSha256,
            page_count: validation.pageCount,
          },
        },
        { prisma: tx },
      );
      return version;
    });
  } catch (err) {
    if (storedKey) {
      try {
        await storage.deleteDraft(storedKey);
      } catch {
        // Preserve the original error. The random unreferenced draft key cannot be served.
      }
    }
    throw err;
  }
}

export async function updateDraftAgreementVersion(
  params: {
    domain: string;
    agreementId: string;
    versionId: string;
    title: string;
    signingMethod: SignatureMethod;
    acceptanceStatement: string;
    actorEmail: string;
  },
  deps?: SignatureLifecycleDeps,
) {
  const domain = normalizeDomain(params.domain);
  const title = cleanText(params.title, 200, 'INVALID_AGREEMENT_VERSION_TITLE');
  const acceptanceStatement = cleanText(
    params.acceptanceStatement,
    4000,
    'INVALID_ACCEPTANCE_STATEMENT',
  );
  const prisma = prismaClient(deps);
  return runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    const existing = await findVersionOrThrow(
      tx as unknown as SignatureLifecyclePrisma,
      domain,
      params.agreementId,
      params.versionId,
    );
    if (existing.status !== 'DRAFT') {
      throw new AppError('BAD_REQUEST', 409, 'PUBLISHED_VERSION_IMMUTABLE');
    }
    const version = await tx.agreementVersion.update({
      where: { id: existing.id },
      data: { title, signingMethod: params.signingMethod, acceptanceStatement },
    });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.version_updated',
        targetType: 'agreement_version',
        targetId: version.id,
        metadata: { agreement_id: existing.agreementId, version: existing.version },
      },
      { prisma: tx },
    );
    return version;
  });
}

export async function replaceDraftAgreementVersionPdf(
  params: {
    domain: string;
    agreementId: string;
    versionId: string;
    originalFilename: string;
    sourcePdf: Uint8Array;
    actorEmail: string;
  },
  deps?: SignatureLifecycleDeps,
) {
  const domain = normalizeDomain(params.domain);
  const originalFilename = cleanFilename(params.originalFilename);
  const validation = await validateAndScanPdf(params.sourcePdf, deps);
  const prisma = prismaClient(deps);
  const storage = objectStorage(deps);
  const replacementId = newId(deps);
  let replacementKey: string | undefined;
  let oldKey: string | undefined;
  let version;
  try {
    version = await runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
      const existing = await findVersionOrThrow(
        tx as unknown as SignatureLifecyclePrisma,
        domain,
        params.agreementId,
        params.versionId,
      );
      if (existing.status !== 'DRAFT') {
        throw new AppError('BAD_REQUEST', 409, 'PUBLISHED_VERSION_IMMUTABLE');
      }
      oldKey = existing.sourceStorageKey;
      replacementKey = validateSignatureStorageKey(
        `sources/${domain}/${existing.agreementId}/${existing.id}/${replacementId}.pdf`,
      );
      await storage.putImmutable(replacementKey, params.sourcePdf, 'application/pdf');
      const updated = await tx.agreementVersion.update({
        where: { id: existing.id },
        data: {
          originalFilename,
          sourceStorageKey: replacementKey,
          sourcePdfSha256: validation.sha256,
        },
      });
      await writeSignatureAdminAudit(
        {
          domain,
          actorEmail: params.actorEmail,
          action: 'signature.version_updated',
          targetType: 'agreement_version',
          targetId: updated.id,
          metadata: {
            agreement_id: existing.agreementId,
            version: existing.version,
            source_pdf_sha256: updated.sourcePdfSha256,
            page_count: validation.pageCount,
          },
        },
        { prisma: tx },
      );
      return updated;
    });
  } catch (err) {
    if (replacementKey) {
      try {
        await storage.deleteDraft(replacementKey);
      } catch {
        // Preserve the original error; the replacement key is not referenced on rollback.
      }
    }
    throw err;
  }
  if (oldKey) await storage.deleteDraft(oldKey);
  return version;
}

export async function deleteDraftAgreementVersion(
  params: { domain: string; agreementId: string; versionId: string; actorEmail: string },
  deps?: SignatureLifecycleDeps,
): Promise<void> {
  const domain = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);
  const storage = objectStorage(deps);
  const storageKey = await runInTransaction(prisma as unknown as PrismaClient, async (tx) => {
    const existing = await findVersionOrThrow(
      tx as unknown as SignatureLifecyclePrisma,
      domain,
      params.agreementId,
      params.versionId,
    );
    if (existing.status !== 'DRAFT') {
      throw new AppError('BAD_REQUEST', 409, 'PUBLISHED_VERSION_IMMUTABLE');
    }
    await tx.agreementVersion.delete({ where: { id: existing.id } });
    await writeSignatureAdminAudit(
      {
        domain,
        actorEmail: params.actorEmail,
        action: 'signature.version_deleted',
        targetType: 'agreement_version',
        targetId: existing.id,
        metadata: { agreement_id: existing.agreementId, version: existing.version },
      },
      { prisma: tx },
    );
    return existing.sourceStorageKey;
  });
  await storage.deleteDraft(storageKey);
}

export async function readAgreementVersionSource(
  params: { domain: string; agreementId: string; versionId: string },
  deps?: SignatureLifecycleDeps,
): Promise<{ filename: string; value: Buffer; sha256: string }> {
  const domain = normalizeDomain(params.domain);
  const version = await findVersionOrThrow(
    prismaClient(deps),
    domain,
    params.agreementId,
    params.versionId,
  );
  const value = await objectStorage(deps).read(version.sourceStorageKey);
  if (hashPdf(value) !== version.sourcePdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_SOURCE_HASH_MISMATCH');
  }
  return { filename: version.originalFilename, value, sha256: version.sourcePdfSha256 };
}
