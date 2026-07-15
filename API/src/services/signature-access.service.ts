import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { decodeProtectedHeader } from 'jose';

import { getEnv, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { canonicalJson, verifyEvidenceManifest } from './signature-evidence.service.js';
import { hashPdf } from './signature-pdf.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import {
  createSignatureObjectStorage,
  type SignatureObjectStorage,
} from './signature-storage.service.js';

type SignatureAccessDeps = {
  env?: Env;
  now?: () => Date;
  prisma?: PrismaClient;
  storage?: SignatureObjectStorage;
};

function prismaClient(deps?: SignatureAccessDeps): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function storageClient(deps?: SignatureAccessDeps): SignatureObjectStorage {
  return deps?.storage ?? createSignatureObjectStorage(deps?.env ?? getEnv());
}

function currentTime(deps?: SignatureAccessDeps): Date {
  return deps?.now?.() ?? new Date();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeReceiptFilename(title: string, version: number): string {
  const safeTitle = title.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${safeTitle || 'agreement'}-v${version}-receipt.pdf`;
}

export async function getCurrentSignatureStatus(
  params: { domain: string; userId: string },
  deps?: SignatureAccessDeps,
) {
  const prisma = prismaClient(deps);
  const policy = await evaluateSignaturePolicy(
    { domain: params.domain, userId: params.userId, now: currentTime(deps) },
    { prisma },
  );
  if (!policy.enabled) {
    return { enabled: false, complete: true, policyRevision: policy.policyRevision, requirements: [] };
  }
  const signatures = await prisma.agreementSignature.findMany({
    where: {
      domain: params.domain,
      userId: params.userId,
      agreementVersionId: { in: policy.required.map((item) => item.agreementVersionId) },
    },
    orderBy: { signedAt: 'desc' },
    include: { revocation: true },
  });
  const byVersion = new Map<string, (typeof signatures)[number]>();
  for (const signature of signatures) {
    const existing = byVersion.get(signature.agreementVersionId);
    if (!existing || (existing.revocation && !signature.revocation)) {
      byVersion.set(signature.agreementVersionId, signature);
    }
  }
  return {
    enabled: true,
    complete: policy.complete,
    policyRevision: policy.policyRevision,
    requirements: policy.required.map((requirement) => {
      const signature = byVersion.get(requirement.agreementVersionId);
      const satisfied = Boolean(signature && !signature.revocation);
      return {
        ...requirement,
        satisfied,
        signatureId: satisfied ? signature?.id ?? null : null,
        signedAt: satisfied ? signature?.signedAt ?? null : null,
        verificationReference: satisfied ? signature?.verificationReference ?? null : null,
        receiptPdfSha256: satisfied ? signature?.receiptPdfSha256 ?? null : null,
      };
    }),
  };
}

export async function readSignerReceipt(
  params: { domain: string; userId: string; signatureId: string },
  deps?: SignatureAccessDeps,
): Promise<{ filename: string; value: Buffer; sha256: string }> {
  const signature = await prismaClient(deps).agreementSignature.findFirst({
    where: { id: params.signatureId, domain: params.domain, userId: params.userId },
    include: { version: { include: { agreement: true } } },
  });
  if (!signature) throw new AppError('NOT_FOUND', 404, 'SIGNATURE_NOT_FOUND');
  const value = await storageClient(deps).read(signature.receiptStorageKey);
  if (hashPdf(value) !== signature.receiptPdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_RECEIPT_HASH_MISMATCH');
  }
  return {
    filename: safeReceiptFilename(signature.version.agreement.title, signature.version.version),
    value,
    sha256: signature.receiptPdfSha256,
  };
}

function evidenceMatchesRecord(
  manifest: Awaited<ReturnType<typeof verifyEvidenceManifest>>,
  signature: {
    id: string;
    verificationReference: string;
    userId: string;
    userEmail: string;
    signerName: string;
    domain: string;
    agreementVersionId: string;
    signingContinuationId: string;
    signingMethod: string;
    typedName: string | null;
    acceptanceStatement: string;
    sourcePdfSha256: string;
    authMethod: string;
    twoFaCompleted: boolean;
    ipAddress: string | null;
    userAgent: string | null;
    signedAt: Date;
    version: { agreementId: string; version: number; agreement: { title: string } };
  },
): boolean {
  return (
    manifest.signatureId === signature.id &&
    manifest.verificationReference === signature.verificationReference &&
    manifest.userId === signature.userId &&
    manifest.userEmail.toLowerCase() === signature.userEmail.toLowerCase() &&
    manifest.signerName === signature.signerName &&
    manifest.domain === signature.domain &&
    manifest.agreementId === signature.version.agreementId &&
    manifest.agreementVersionId === signature.agreementVersionId &&
    manifest.agreementVersion === signature.version.version &&
    manifest.agreementTitle === signature.version.agreement.title &&
    manifest.sourcePdfSha256 === signature.sourcePdfSha256 &&
    manifest.acceptanceStatement === signature.acceptanceStatement &&
    manifest.signingMethod === signature.signingMethod &&
    manifest.typedName === signature.typedName &&
    manifest.signedAt === signature.signedAt.toISOString() &&
    manifest.authMethod === signature.authMethod &&
    manifest.twoFaCompleted === signature.twoFaCompleted &&
    manifest.ipAddress === signature.ipAddress &&
    manifest.userAgent === signature.userAgent &&
    manifest.signingContinuationId === signature.signingContinuationId
  );
}

export async function verifyPublicSignatureReference(
  reference: string,
  deps?: SignatureAccessDeps,
) {
  const signature = await prismaClient(deps).agreementSignature.findUnique({
    where: { verificationReference: reference },
    include: {
      revocation: true,
      version: { include: { agreement: true } },
    },
  });
  if (!signature) throw new AppError('NOT_FOUND', 404, 'SIGNATURE_NOT_FOUND');
  const env = deps?.env ?? getEnv();
  if (!env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_KEY_MISSING');
  }
  const manifest = await verifyEvidenceManifest(
    signature.evidenceSignature,
    env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON,
  );
  const evidenceHeader = decodeProtectedHeader(signature.evidenceSignature);
  const manifestHash = sha256Text(
    canonicalJson(manifest as unknown as Parameters<typeof canonicalJson>[0]),
  );
  const [sourcePdf, receiptPdf] = await Promise.all([
    storageClient(deps).read(signature.version.sourceStorageKey),
    storageClient(deps).read(signature.receiptStorageKey),
  ]);
  if (
    !evidenceMatchesRecord(manifest, signature) ||
    manifestHash !== signature.evidenceManifestSha256 ||
    hashPdf(sourcePdf) !== signature.sourcePdfSha256 ||
    hashPdf(receiptPdf) !== signature.receiptPdfSha256 ||
    signature.version.sourcePdfSha256 !== signature.sourcePdfSha256 ||
    evidenceHeader.kid !== signature.evidenceKeyId
  ) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_EVIDENCE_INTEGRITY_FAILED');
  }
  return {
    state: signature.revocation ? ('revoked' as const) : ('valid' as const),
    integrityVerified: true,
    verificationReference: signature.verificationReference,
    agreementId: signature.version.agreementId,
    agreementVersionId: signature.agreementVersionId,
    agreementVersion: signature.version.version,
    sourcePdfSha256: signature.sourcePdfSha256,
    receiptPdfSha256: signature.receiptPdfSha256,
    signedAt: signature.signedAt,
    evidenceKeyId: signature.evidenceKeyId,
    revokedAt: signature.revocation?.revokedAt ?? null,
  };
}
