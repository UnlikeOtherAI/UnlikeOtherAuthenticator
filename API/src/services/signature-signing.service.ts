import type { PrismaClient } from '@prisma/client';

import { getEnv, getPublicBaseUrl, type Env } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  requireActiveSigningContinuation,
  type SignatureContinuationDeps,
} from './signature-continuation.service.js';
import { createSignatureEvidence } from './signature-evidence.service.js';
import { hashPdf } from './signature-pdf.service.js';
import { evaluateSignaturePolicy } from './signature-policy.service.js';
import {
  finalizeSignatureClaimIntent,
  markSignatureClaimEvidenceReady,
  reserveSignatureClaimIntent,
  signatureClaimManifest,
} from './signature-claim-intent.service.js';
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
  if (typeof (prisma as { $transaction?: unknown }).$transaction !== 'function') {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_SIGNING_REQUIRES_STANDALONE_DATABASE');
  }
  const claim = await reserveSignatureClaimIntent(params, { ...deps, prisma });
  if (claim.kind === 'rejected') return rejectSigning();
  if (claim.kind === 'signed') return claim.signature;

  let intent = claim.intent;
  if (intent.status === 'CLAIMED') {
    const storage = storageClient(deps);
    const sourcePdf = await storage.read(intent.sourceStorageKey);
    const manifest = signatureClaimManifest(intent);
    const evidence = await (deps?.createEvidence ?? createSignatureEvidence)({
      manifest,
      sourcePdf,
      verificationUrl: `${deps?.publicBaseUrl ?? getPublicBaseUrl(signingEnv(deps))}/signatures/verify/${intent.verificationReference}`,
      storage,
      env: signingEnv(deps),
    });
    intent = await markSignatureClaimEvidenceReady(intent.id, evidence, { ...deps, prisma });
  }

  const finalized = await finalizeSignatureClaimIntent(
    { signingToken: params.signingToken, intentId: intent.id },
    { ...deps, prisma },
  );
  if (finalized.kind !== 'signed') return rejectSigning();
  return finalized.signature;
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
