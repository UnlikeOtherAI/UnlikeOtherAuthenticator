import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  Prisma,
  type AgreementSignature,
  type PrismaClient,
  type SignatureClaimIntent,
} from '@prisma/client';

import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  lockSignaturePolicyForDecision,
  recordSigningContinuationFailure,
  requireActiveSigningContinuation,
  type SignatureContinuationDeps,
} from './signature-continuation.service.js';
import type {
  CreatedSignatureEvidence,
  SignatureEvidenceManifest,
} from './signature-evidence.service.js';
import { hashPdf } from './signature-pdf.service.js';
import {
  evaluateSignaturePolicy,
  type RequiredAgreementVersion,
} from './signature-policy.service.js';
import { validateSignatureStorageKey } from './signature-storage.service.js';

type SignRequest = {
  signingToken: string;
  agreementVersionId: string;
  accepted: boolean;
  typedName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SignatureClaimOutcome =
  | { kind: 'intent'; intent: SignatureClaimIntent }
  | { kind: 'signed'; signature: AgreementSignature }
  | { kind: 'rejected' };

function currentTime(deps?: SignatureContinuationDeps): Date {
  return deps?.now?.() ?? new Date();
}

function normalizeTypedName(value?: string | null): string | null {
  return value?.trim() || null;
}

function isMatchingSubmission(intent: SignatureClaimIntent, params: SignRequest): boolean {
  return params.accepted && intent.typedName === normalizeTypedName(params.typedName);
}

function requirementMatchesVersion(
  requirement: RequiredAgreementVersion,
  version: {
    agreementId: string;
    version: number;
    sourcePdfSha256: string;
    signingMethod: 'CLICKWRAP' | 'TYPED_NAME';
    acceptanceStatement: string;
    agreement: { title: string };
  },
): boolean {
  return (
    version.agreementId === requirement.agreementId &&
    version.version === requirement.version &&
    version.sourcePdfSha256 === requirement.sourcePdfSha256 &&
    version.acceptanceStatement === requirement.acceptanceStatement &&
    version.signingMethod === requirement.signingMethod &&
    version.agreement.title === requirement.agreementTitle
  );
}

async function signatureStateSha256(
  prisma: PrismaClient,
  params: { userId: string; domain: string; agreementVersionId: string },
): Promise<string> {
  const rows = await prisma.agreementSignature.findMany({
    where: params,
    orderBy: { id: 'asc' },
    select: { id: true, revocation: { select: { id: true } } },
  });
  const canonical = rows.map((row) => `${row.id}\0${row.revocation?.id ?? ''}`).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function rejectAndCount(
  continuationId: string,
  deps: SignatureContinuationDeps & { prisma: PrismaClient },
): Promise<SignatureClaimOutcome> {
  await recordSigningContinuationFailure(continuationId, deps);
  return { kind: 'rejected' };
}

export async function reserveSignatureClaimIntent(
  params: SignRequest,
  deps: SignatureContinuationDeps & { prisma: PrismaClient },
): Promise<SignatureClaimOutcome> {
  return runInTransaction(deps.prisma, async (tx) => {
    const continuation = await requireActiveSigningContinuation(
      { signingToken: params.signingToken, lock: true },
      { ...deps, prisma: tx },
    );
    await lockSignaturePolicyForDecision(tx, continuation.domain);

    const existingSignature = await tx.agreementSignature.findFirst({
      where: {
        signingContinuationId: continuation.id,
        agreementVersionId: params.agreementVersionId,
      },
      include: { revocation: true },
    });
    if (existingSignature && !existingSignature.revocation) {
      return { kind: 'signed', signature: existingSignature };
    }
    if (existingSignature?.revocation) {
      return rejectAndCount(continuation.id, { ...deps, prisma: tx });
    }

    const existingIntent = await tx.signatureClaimIntent.findUnique({
      where: {
        signingContinuationId_agreementVersionId: {
          signingContinuationId: continuation.id,
          agreementVersionId: params.agreementVersionId,
        },
      },
    });
    if (existingIntent) {
      if (
        existingIntent.status === 'INVALIDATED' ||
        !isMatchingSubmission(existingIntent, params)
      ) {
        return rejectAndCount(continuation.id, { ...deps, prisma: tx });
      }
      if (existingIntent.status === 'COMPLETED') {
        const signature = await tx.agreementSignature.findUnique({
          where: { claimIntentId: existingIntent.id },
        });
        if (!signature) throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_CORRUPT');
        return { kind: 'signed', signature };
      }
      return { kind: 'intent', intent: existingIntent };
    }

    const policy = await evaluateSignaturePolicy(
      { domain: continuation.domain, userId: continuation.userId, now: currentTime(deps) },
      { prisma: tx },
    );
    const requirement = policy.missing.find(
      (item) => item.agreementVersionId === params.agreementVersionId,
    );
    const typedName = normalizeTypedName(params.typedName);
    const invalidInput =
      !requirement ||
      !params.accepted ||
      (requirement.signingMethod === 'TYPED_NAME' && (!typedName || typedName.length > 200)) ||
      (requirement.signingMethod === 'CLICKWRAP' && typedName !== null);
    if (!requirement || invalidInput) {
      return rejectAndCount(continuation.id, { ...deps, prisma: tx });
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
    if (!requirementMatchesVersion(requirement, version)) {
      throw new AppError('INTERNAL', 500, 'SIGNATURE_POLICY_CHANGED_DURING_CLAIM');
    }

    const signerName =
      requirement.signingMethod === 'TYPED_NAME'
        ? (typedName as string)
        : user.name?.trim() || user.email;
    if (signerName.length > 200) {
      throw new AppError('INTERNAL', 500, 'SIGNATURE_SIGNER_NAME_INVALID');
    }
    const signedAt = currentTime(deps);
    const intent = await tx.signatureClaimIntent.create({
      data: {
        id: randomUUID(),
        status: 'CLAIMED',
        signingContinuationId: continuation.id,
        userId: continuation.userId,
        userEmail: user.email,
        signerName,
        domain: continuation.domain,
        agreementId: requirement.agreementId,
        agreementVersionId: requirement.agreementVersionId,
        agreementVersion: requirement.version,
        agreementTitle: requirement.agreementTitle,
        sourceStorageKey: version.sourceStorageKey,
        sourcePdfSha256: requirement.sourcePdfSha256,
        signingMethod: requirement.signingMethod,
        typedName: requirement.signingMethod === 'TYPED_NAME' ? typedName : null,
        acceptanceStatement: requirement.acceptanceStatement,
        signedAt,
        authMethod: continuation.authMethod,
        twoFaCompleted: continuation.twoFaCompleted,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        policyRevision: policy.policyRevision,
        priorSignatureStateSha256: await signatureStateSha256(tx, {
          userId: continuation.userId,
          domain: continuation.domain,
          agreementVersionId: requirement.agreementVersionId,
        }),
        continuationExpiresAt: continuation.expiresAt,
        verificationReference: randomBytes(32).toString('base64url'),
        createdAt: signedAt,
      },
    });
    return { kind: 'intent', intent };
  });
}

export function signatureClaimManifest(intent: SignatureClaimIntent): SignatureEvidenceManifest {
  return {
    schemaVersion: 1,
    signatureId: intent.id,
    verificationReference: intent.verificationReference,
    userId: intent.userId,
    userEmail: intent.userEmail,
    signerName: intent.signerName,
    domain: intent.domain,
    agreementId: intent.agreementId,
    agreementVersionId: intent.agreementVersionId,
    agreementVersion: intent.agreementVersion,
    agreementTitle: intent.agreementTitle,
    sourcePdfSha256: intent.sourcePdfSha256,
    acceptanceStatement: intent.acceptanceStatement,
    signingMethod: intent.signingMethod,
    typedName: intent.typedName,
    signedAt: intent.signedAt.toISOString(),
    authMethod: intent.authMethod,
    twoFaCompleted: intent.twoFaCompleted,
    ipAddress: intent.ipAddress,
    userAgent: intent.userAgent,
    signingContinuationId: intent.signingContinuationId,
  };
}

async function lockClaimIntent(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`SELECT 1 FROM "signature_claim_intents" WHERE "id" = ${id} FOR UPDATE`,
  );
}

function requireReadyEvidence(
  intent: SignatureClaimIntent,
): asserts intent is SignatureClaimIntent & {
  evidenceManifestSha256: string;
  receiptPdfSha256: string;
  receiptStorageKey: string;
  evidenceKeyId: string;
  evidenceSignature: string;
  evidenceReadyAt: Date;
} {
  if (
    !intent.evidenceManifestSha256 ||
    !intent.receiptPdfSha256 ||
    !intent.receiptStorageKey ||
    !intent.evidenceKeyId ||
    !intent.evidenceSignature ||
    !intent.evidenceReadyAt
  ) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_EVIDENCE_MISSING');
  }
}

export async function markSignatureClaimEvidenceReady(
  intentId: string,
  evidence: CreatedSignatureEvidence,
  deps: SignatureContinuationDeps & { prisma: PrismaClient },
): Promise<SignatureClaimIntent> {
  if (evidence.receiptPdfSha256 !== hashPdf(evidence.receiptPdf)) {
    throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_EVIDENCE_INVALID');
  }
  return runInTransaction(deps.prisma, async (tx) => {
    await lockClaimIntent(tx, intentId);
    const current = await tx.signatureClaimIntent.findUnique({ where: { id: intentId } });
    if (!current || current.status === 'INVALIDATED') {
      throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    }
    const expectedKey = validateSignatureStorageKey(
      `receipts/${current.domain}/${current.id}/receipt.pdf`,
    );
    if (evidence.receiptStorageKey !== expectedKey) {
      throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_EVIDENCE_INVALID');
    }
    if (current.status !== 'CLAIMED') {
      requireReadyEvidence(current);
      if (
        current.evidenceManifestSha256 !== evidence.manifestSha256 ||
        current.receiptPdfSha256 !== evidence.receiptPdfSha256 ||
        current.receiptStorageKey !== evidence.receiptStorageKey
      ) {
        throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_EVIDENCE_CONFLICT');
      }
      return current;
    }
    return tx.signatureClaimIntent.update({
      where: { id: intentId },
      data: {
        status: 'EVIDENCE_READY',
        evidenceManifestSha256: evidence.manifestSha256,
        receiptPdfSha256: evidence.receiptPdfSha256,
        receiptStorageKey: evidence.receiptStorageKey,
        evidenceKeyId: evidence.keyId,
        evidenceSignature: evidence.compactJws,
        evidenceReadyAt: currentTime(deps),
      },
    });
  });
}

async function invalidateIntent(
  prisma: PrismaClient,
  intent: SignatureClaimIntent,
  reason: string,
  at: Date,
): Promise<SignatureClaimOutcome> {
  await prisma.signatureClaimIntent.update({
    where: { id: intent.id },
    data: { status: 'INVALIDATED', invalidatedAt: at, invalidationReason: reason },
  });
  return { kind: 'rejected' };
}

function continuationMatchesIntent(
  continuation: Awaited<ReturnType<typeof requireActiveSigningContinuation>>,
  intent: SignatureClaimIntent,
): boolean {
  return (
    continuation.id === intent.signingContinuationId &&
    continuation.userId === intent.userId &&
    continuation.domain === intent.domain &&
    continuation.authMethod === intent.authMethod &&
    continuation.twoFaCompleted === intent.twoFaCompleted &&
    continuation.expiresAt.getTime() === intent.continuationExpiresAt.getTime()
  );
}

export async function finalizeSignatureClaimIntent(
  params: { signingToken: string; intentId: string },
  deps: SignatureContinuationDeps & { prisma: PrismaClient },
): Promise<SignatureClaimOutcome> {
  return runInTransaction(deps.prisma, async (tx) => {
    const continuation = await requireActiveSigningContinuation(
      { signingToken: params.signingToken, lock: true },
      { ...deps, prisma: tx },
    );
    await lockSignaturePolicyForDecision(tx, continuation.domain);
    await lockClaimIntent(tx, params.intentId);
    const intent = await tx.signatureClaimIntent.findFirst({
      where: { id: params.intentId, signingContinuationId: continuation.id },
    });
    if (!intent || intent.status === 'INVALIDATED') return { kind: 'rejected' };
    if (intent.status === 'COMPLETED') {
      const signature = await tx.agreementSignature.findUnique({
        where: { claimIntentId: intent.id },
      });
      if (!signature) throw new AppError('INTERNAL', 500, 'SIGNATURE_CLAIM_CORRUPT');
      return { kind: 'signed', signature };
    }
    if (intent.status !== 'EVIDENCE_READY') return { kind: 'rejected' };
    requireReadyEvidence(intent);
    const decisionAt = currentTime(deps);
    if (!continuationMatchesIntent(continuation, intent)) {
      return invalidateIntent(tx, intent, 'CONTINUATION_CHANGED', decisionAt);
    }

    const policy = await evaluateSignaturePolicy(
      { domain: intent.domain, userId: intent.userId, now: decisionAt },
      { prisma: tx },
    );
    const requirement = policy.missing.find(
      (item) => item.agreementVersionId === intent.agreementVersionId,
    );
    if (!requirement || policy.policyRevision !== intent.policyRevision) {
      return invalidateIntent(tx, intent, 'POLICY_CHANGED', decisionAt);
    }
    const version = await tx.agreementVersion.findFirst({
      where: {
        id: intent.agreementVersionId,
        agreementId: intent.agreementId,
        status: 'PUBLISHED',
        agreement: { domain: intent.domain },
      },
      include: { agreement: true },
    });
    if (
      !version ||
      !requirementMatchesVersion(requirement, version) ||
      version.sourceStorageKey !== intent.sourceStorageKey ||
      requirement.agreementVersionId !== intent.agreementVersionId ||
      requirement.agreementTitle !== intent.agreementTitle
    ) {
      return invalidateIntent(tx, intent, 'VERSION_CHANGED', decisionAt);
    }
    const stateHash = await signatureStateSha256(tx, {
      userId: intent.userId,
      domain: intent.domain,
      agreementVersionId: intent.agreementVersionId,
    });
    if (stateHash !== intent.priorSignatureStateSha256) {
      return invalidateIntent(tx, intent, 'SIGNATURE_STATE_CHANGED', decisionAt);
    }
    const persistAt = currentTime(deps);
    if (continuation.expiresAt.getTime() <= persistAt.getTime()) {
      return invalidateIntent(tx, intent, 'CONTINUATION_EXPIRED', persistAt);
    }

    const signature = await tx.agreementSignature.create({
      data: {
        id: intent.id,
        verificationReference: intent.verificationReference,
        userId: intent.userId,
        userEmail: intent.userEmail,
        signerName: intent.signerName,
        domain: intent.domain,
        agreementVersionId: intent.agreementVersionId,
        signingContinuationId: intent.signingContinuationId,
        claimIntentId: intent.id,
        signingMethod: intent.signingMethod,
        typedName: intent.typedName,
        acceptanceStatement: intent.acceptanceStatement,
        sourcePdfSha256: intent.sourcePdfSha256,
        authMethod: intent.authMethod,
        twoFaCompleted: intent.twoFaCompleted,
        ipAddress: intent.ipAddress,
        userAgent: intent.userAgent,
        evidenceManifestSha256: intent.evidenceManifestSha256,
        receiptPdfSha256: intent.receiptPdfSha256,
        receiptStorageKey: intent.receiptStorageKey,
        evidenceKeyId: intent.evidenceKeyId,
        evidenceSignature: intent.evidenceSignature,
        signedAt: intent.signedAt,
      },
    });
    await tx.signatureAuditEvent.create({
      data: {
        domain: intent.domain,
        actorUserId: intent.userId,
        actorEmail: intent.userEmail,
        action: 'signature.signed',
        targetType: 'signature',
        targetId: signature.id,
        metadata: {
          agreement_id: intent.agreementId,
          agreement_version_id: intent.agreementVersionId,
          verification_reference: intent.verificationReference,
          source_pdf_sha256: intent.sourcePdfSha256,
          evidence_manifest_sha256: intent.evidenceManifestSha256,
          receipt_pdf_sha256: intent.receiptPdfSha256,
          claim_intent_id: intent.id,
        },
      },
    });
    await tx.signatureClaimIntent.update({
      where: { id: intent.id },
      data: { status: 'COMPLETED', completedAt: persistAt },
    });
    return { kind: 'signed', signature };
  });
}
