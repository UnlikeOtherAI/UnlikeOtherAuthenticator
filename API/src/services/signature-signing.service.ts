import { randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  lockSignaturePolicyForDecision,
  recordSigningContinuationFailure,
  requireActiveSigningContinuation,
  type SignatureContinuationDeps,
} from './signature-continuation.service.js';
import {
  createSignatureEvidence,
  type CreatedSignatureEvidence,
  type SignatureEvidenceManifest,
} from './signature-evidence.service.js';
import { hashPdf } from './signature-pdf.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import {
  createSignatureObjectStorage,
  type SignatureObjectStorage,
} from './signature-storage.service.js';

type EvidenceCreator = typeof createSignatureEvidence;

export type SignatureSigningDeps = SignatureContinuationDeps & {
  createEvidence?: EvidenceCreator;
  storage?: SignatureObjectStorage;
};

export type SigningSessionState = {
  domain: string;
  expiresAt: Date;
  initialPolicyRevision: number;
  policyRevision: number;
  complete: boolean;
  agreements: Array<{
    agreementId: string;
    agreementVersionId: string;
    agreementTitle: string;
    title: string;
    description: string | null;
    version: number;
    originalFilename: string;
    signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
    acceptanceStatement: string;
    sourcePdfSha256: string;
  }>;
  receipts: Array<{
    signatureId: string;
    agreementTitle: string;
    version: number;
    verificationReference: string;
    receiptPdfSha256: string;
    signedAt: Date;
    revoked: boolean;
  }>;
};

function signingPrisma(deps?: SignatureSigningDeps): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function signingEnv(deps?: SignatureSigningDeps): Env {
  return deps?.env ?? getEnv();
}

function storageClient(deps?: SignatureSigningDeps): SignatureObjectStorage {
  return deps?.storage ?? createSignatureObjectStorage(signingEnv(deps));
}

function now(deps?: SignatureSigningDeps): Date {
  return deps?.now?.() ?? new Date();
}

function rejectSigning(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

export async function readSigningSession(
  signingToken: string,
  deps?: SignatureSigningDeps,
): Promise<SigningSessionState> {
  const prisma = signingPrisma(deps);
  const continuation = await requireActiveSigningContinuation(
    { signingToken },
    { ...deps, prisma },
  );
  const [policy, signatures] = await Promise.all([
    evaluateSignaturePolicy(
      { domain: continuation.domain, userId: continuation.userId, now: now(deps) },
      { prisma },
    ),
    prisma.agreementSignature.findMany({
      where: { signingContinuationId: continuation.id },
      orderBy: { signedAt: 'asc' },
      include: { version: { include: { agreement: true } }, revocation: true },
    }),
  ]);
  return {
    domain: continuation.domain,
    expiresAt: continuation.expiresAt,
    initialPolicyRevision: continuation.policyRevision,
    policyRevision: policy.policyRevision,
    complete: policy.complete,
    agreements: policy.missing.map((item) => ({
      agreementId: item.agreementId,
      agreementVersionId: item.agreementVersionId,
      agreementTitle: item.agreementTitle,
      title: item.title,
      description: item.description,
      version: item.version,
      originalFilename: item.originalFilename,
      signingMethod: item.signingMethod,
      acceptanceStatement: item.acceptanceStatement,
      sourcePdfSha256: item.sourcePdfSha256,
    })),
    receipts: signatures.map((signature) => ({
      signatureId: signature.id,
      agreementTitle: signature.version.agreement.title,
      version: signature.version.version,
      verificationReference: signature.verificationReference,
      receiptPdfSha256: signature.receiptPdfSha256,
      signedAt: signature.signedAt,
      revoked: Boolean(signature.revocation),
    })),
  };
}

export async function readSigningAgreementSource(
  params: { signingToken: string; agreementVersionId: string },
  deps?: SignatureSigningDeps,
): Promise<{ filename: string; value: Buffer; sha256: string }> {
  const prisma = signingPrisma(deps);
  const continuation = await requireActiveSigningContinuation(
    { signingToken: params.signingToken },
    { ...deps, prisma },
  );
  const policy = await evaluateSignaturePolicy(
    { domain: continuation.domain, userId: continuation.userId, now: now(deps) },
    { prisma },
  );
  const required = policy.required.find(
    (item) => item.agreementVersionId === params.agreementVersionId,
  );
  if (!required) return rejectSigning();
  const version = await prisma.agreementVersion.findFirst({
    where: {
      id: required.agreementVersionId,
      agreementId: required.agreementId,
      agreement: { domain: continuation.domain },
    },
    select: { originalFilename: true, sourceStorageKey: true, sourcePdfSha256: true },
  });
  if (!version) return rejectSigning();
  const value = await storageClient(deps).read(version.sourceStorageKey);
  if (hashPdf(value) !== version.sourcePdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_SOURCE_HASH_MISMATCH');
  }
  return { filename: version.originalFilename, value, sha256: version.sourcePdfSha256 };
}

export async function signAgreementVersion(
  params: {
    signingToken: string;
    agreementVersionId: string;
    accepted: boolean;
    typedName?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  deps?: SignatureSigningDeps,
) {
  const prisma = signingPrisma(deps);
  const result = await runInTransaction(prisma, async (tx) => {
    const continuation = await requireActiveSigningContinuation(
      { signingToken: params.signingToken, lock: true },
      { ...deps, prisma: tx },
    );
    await lockSignaturePolicyForDecision(tx, continuation.domain);
    const existing = await tx.agreementSignature.findFirst({
      where: {
        signingContinuationId: continuation.id,
        agreementVersionId: params.agreementVersionId,
      },
      include: { revocation: true, version: { include: { agreement: true } } },
    });
    if (existing && !existing.revocation) return { kind: 'signed' as const, signature: existing };

    const policy = await evaluateSignaturePolicy(
      { domain: continuation.domain, userId: continuation.userId, now: now(deps) },
      { prisma: tx },
    );
    const requirement = policy.missing.find(
      (item) => item.agreementVersionId === params.agreementVersionId,
    );
    const typedName = params.typedName?.trim() || null;
    const invalidMethodInput =
      !requirement ||
      !params.accepted ||
      (requirement.signingMethod === 'TYPED_NAME' && (!typedName || typedName.length > 200)) ||
      (requirement.signingMethod === 'CLICKWRAP' && typedName !== null);
    if (existing?.revocation || invalidMethodInput) {
      await recordSigningContinuationFailure(continuation.id, { ...deps, prisma: tx });
      return { kind: 'rejected' as const };
    }

    const [user, version] = await Promise.all([
      tx.user.findUnique({
        where: { id: continuation.userId },
        select: { email: true, name: true },
      }),
      tx.agreementVersion.findFirst({
        where: {
          id: requirement.agreementVersionId,
          agreementId: requirement.agreementId,
          status: 'PUBLISHED',
          agreement: { domain: continuation.domain },
        },
        include: { agreement: true },
      }),
    ]);
    if (!user || !version) throw new AppError('INTERNAL', 500, 'SIGNATURE_CONTEXT_MISSING');
    if (
      version.sourcePdfSha256 !== requirement.sourcePdfSha256 ||
      version.acceptanceStatement !== requirement.acceptanceStatement ||
      version.signingMethod !== requirement.signingMethod
    ) {
      throw new AppError('INTERNAL', 500, 'SIGNATURE_POLICY_CHANGED_DURING_SIGNING');
    }

    const signedAt = now(deps);
    const signatureId = randomUUID();
    const verificationReference = randomBytes(32).toString('base64url');
    const signerName =
      requirement.signingMethod === 'TYPED_NAME'
        ? (typedName as string)
        : user.name?.trim() || user.email;
    const manifest: SignatureEvidenceManifest = {
      schemaVersion: 1,
      signatureId,
      verificationReference,
      userId: continuation.userId,
      userEmail: user.email,
      signerName,
      domain: continuation.domain,
      agreementId: requirement.agreementId,
      agreementVersionId: requirement.agreementVersionId,
      agreementVersion: requirement.version,
      agreementTitle: requirement.agreementTitle,
      sourcePdfSha256: requirement.sourcePdfSha256,
      acceptanceStatement: requirement.acceptanceStatement,
      signingMethod: requirement.signingMethod,
      typedName: requirement.signingMethod === 'TYPED_NAME' ? typedName : null,
      signedAt: signedAt.toISOString(),
      authMethod: continuation.authMethod,
      twoFaCompleted: continuation.twoFaCompleted,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      signingContinuationId: continuation.id,
    };
    const sourcePdf = await storageClient(deps).read(version.sourceStorageKey);
    const evidence = await (deps?.createEvidence ?? createSignatureEvidence)({
      manifest,
      sourcePdf,
      verificationUrl: `${deps?.publicBaseUrl ?? getPublicBaseUrl(signingEnv(deps))}/signatures/verify/${verificationReference}`,
      storage: storageClient(deps),
      env: signingEnv(deps),
    });
    const signature = await persistSignatureEvidence(tx, manifest, evidence);
    await tx.signatureAuditEvent.create({
      data: {
        domain: continuation.domain,
        actorUserId: continuation.userId,
        actorEmail: user.email,
        action: 'signature.signed',
        targetType: 'signature',
        targetId: signature.id,
        metadata: {
          agreement_id: requirement.agreementId,
          agreement_version_id: requirement.agreementVersionId,
          verification_reference: verificationReference,
          source_pdf_sha256: requirement.sourcePdfSha256,
          evidence_manifest_sha256: evidence.manifestSha256,
          receipt_pdf_sha256: evidence.receiptPdfSha256,
        },
      },
    });
    return { kind: 'signed' as const, signature };
  });
  if (result.kind === 'rejected') return rejectSigning();
  return result.signature;
}

async function persistSignatureEvidence(
  prisma: PrismaClient,
  manifest: SignatureEvidenceManifest,
  evidence: CreatedSignatureEvidence,
) {
  return prisma.agreementSignature.create({
    data: {
      id: manifest.signatureId,
      verificationReference: manifest.verificationReference,
      userId: manifest.userId,
      userEmail: manifest.userEmail,
      signerName: manifest.signerName,
      domain: manifest.domain,
      agreementVersionId: manifest.agreementVersionId,
      signingContinuationId: manifest.signingContinuationId,
      signingMethod: manifest.signingMethod,
      typedName: manifest.typedName,
      acceptanceStatement: manifest.acceptanceStatement,
      sourcePdfSha256: manifest.sourcePdfSha256,
      authMethod: manifest.authMethod,
      twoFaCompleted: manifest.twoFaCompleted,
      ipAddress: manifest.ipAddress,
      userAgent: manifest.userAgent,
      evidenceManifestSha256: evidence.manifestSha256,
      receiptPdfSha256: evidence.receiptPdfSha256,
      receiptStorageKey: evidence.receiptStorageKey,
      evidenceKeyId: evidence.keyId,
      evidenceSignature: evidence.compactJws,
      signedAt: new Date(manifest.signedAt),
    },
    include: { revocation: true, version: { include: { agreement: true } } },
  });
}

export async function readSigningReceipt(
  params: { signingToken: string; signatureId: string },
  deps?: SignatureSigningDeps,
): Promise<{ filename: string; value: Buffer; sha256: string }> {
  const prisma = signingPrisma(deps);
  const continuation = await requireActiveSigningContinuation(
    { signingToken: params.signingToken },
    { ...deps, prisma },
  );
  const signature = await prisma.agreementSignature.findFirst({
    where: {
      id: params.signatureId,
      signingContinuationId: continuation.id,
      userId: continuation.userId,
      domain: continuation.domain,
    },
    include: { version: { include: { agreement: true } } },
  });
  if (!signature) return rejectSigning();
  const value = await storageClient(deps).read(signature.receiptStorageKey);
  if (hashPdf(value) !== signature.receiptPdfSha256) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_RECEIPT_HASH_MISMATCH');
  }
  const title = signature.version.agreement.title.replace(/[^a-zA-Z0-9._-]+/gu, '-');
  return {
    filename: `${title || 'agreement'}-v${signature.version.version}-receipt.pdf`,
    value,
    sha256: signature.receiptPdfSha256,
  };
}
