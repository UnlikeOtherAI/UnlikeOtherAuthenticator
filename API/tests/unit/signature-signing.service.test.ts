import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import { hashSigningContinuationToken } from '../../src/services/signature-continuation.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';
import {
  readSigningAgreementSource,
  readSigningReceipt,
  readSigningSession,
  signAgreementVersion,
} from '../../src/services/signature-signing.service.js';
import { evaluateSignaturePolicy } from '../../src/services/signature-policy.service.js';

vi.mock('../../src/services/signature-policy.service.js', () => ({ evaluateSignaturePolicy: vi.fn() }));

const SHARED_SECRET = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
const NOW = new Date('2026-07-15T21:00:00.000Z');
const env = parseEnv({ NODE_ENV: 'test', SHARED_SECRET });
const signingToken = 'opaque-signing-capability-token';
const sourcePdf = Buffer.from('%PDF-source');

const requirement = {
  agreementId: 'agreement-1',
  agreementVersionId: 'version-2',
  version: 2,
  title: 'Service Terms July 2026',
  agreementTitle: 'Service Terms',
  description: 'Review the service terms.',
  originalFilename: 'service-terms.pdf',
  displayOrder: 0,
  signingMethod: 'TYPED_NAME' as const,
  acceptanceStatement: 'I agree to the Service Terms.',
  sourcePdfSha256: hashPdf(sourcePdf),
};

function continuation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'continuation-1',
    tokenHash: hashSigningContinuationToken(signingToken, SHARED_SECRET),
    userId: 'user-1',
    domain: 'client.example.com',
    authProfile: 'CONFIG_JWT',
    configUrl: 'https://client.example.com/config',
    redirectUrl: 'https://client.example.com/callback',
    oauthState: null,
    oauthClientId: null,
    oauthScope: null,
    resource: null,
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    rememberMe: true,
    requestAccess: false,
    orgId: null,
    teamId: null,
    authMethod: 'email_password',
    twoFaCompleted: true,
    policyRevision: 3,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    consumedAt: null,
    attemptCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function version() {
  return {
    id: requirement.agreementVersionId,
    agreementId: requirement.agreementId,
    version: requirement.version,
    title: requirement.title,
    originalFilename: requirement.originalFilename,
    sourceStorageKey: 'agreements/client.example.com/agreement-1/v2/source.pdf',
    sourcePdfSha256: requirement.sourcePdfSha256,
    signingMethod: requirement.signingMethod,
    acceptanceStatement: requirement.acceptanceStatement,
    status: 'PUBLISHED',
    publishedAt: NOW,
    effectiveAt: NOW,
    publishedByEmail: 'admin@example.com',
    createdAt: NOW,
    agreement: {
      id: requirement.agreementId,
      domain: 'client.example.com',
      title: requirement.agreementTitle,
    },
  };
}

function signatureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'signature-1',
    verificationReference: 'verification-reference-1234567890',
    userId: 'user-1',
    userEmail: 'person@example.com',
    signerName: 'Person Example',
    domain: 'client.example.com',
    agreementVersionId: requirement.agreementVersionId,
    signingContinuationId: 'continuation-1',
    signingMethod: 'TYPED_NAME',
    typedName: 'Person Example',
    acceptanceStatement: requirement.acceptanceStatement,
    sourcePdfSha256: requirement.sourcePdfSha256,
    authMethod: 'email_password',
    twoFaCompleted: true,
    ipAddress: '203.0.113.4',
    userAgent: 'Test browser',
    evidenceManifestSha256: 'a'.repeat(64),
    receiptPdfSha256: 'b'.repeat(64),
    receiptStorageKey: 'receipts/client.example.com/signature-1/receipt.pdf',
    evidenceKeyId: 'evidence-key',
    evidenceSignature: 'compact-jws',
    signedAt: NOW,
    version: version(),
    revocation: null,
    ...overrides,
  };
}

function fakePrisma(params?: { existing?: ReturnType<typeof signatureRow> | null }) {
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    signingContinuation: {
      findUnique: vi.fn().mockResolvedValue(continuation()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agreementSignature: {
      findFirst: vi.fn().mockResolvedValue(params?.existing ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async () => signatureRow()),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: 'person@example.com', name: 'Profile Name' }),
    },
    agreementVersion: {
      findFirst: vi.fn().mockResolvedValue(version()),
    },
    signatureAuditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return prisma;
}

function policy(missing = [requirement]) {
  return {
    enabled: true,
    policyRevision: 4,
    complete: missing.length === 0,
    required: [requirement],
    missing,
  };
}

function dependencies(prisma: ReturnType<typeof fakePrisma>, receipt = Buffer.from('%PDF-receipt')) {
  return {
    env,
    prisma: prisma as never,
    sharedSecret: SHARED_SECRET,
    publicBaseUrl: 'https://auth.example.com',
    now: () => NOW,
    storage: {
      putImmutable: vi.fn(),
      read: vi.fn(async (key: string) => (key.startsWith('receipts/') ? receipt : sourcePdf)),
      deleteDraft: vi.fn(),
    },
    createEvidence: vi.fn().mockResolvedValue({
      canonicalManifest: '{}',
      manifestSha256: 'a'.repeat(64),
      compactJws: 'compact-jws',
      keyId: 'evidence-key',
      receiptPdf: receipt,
      receiptPdfSha256: hashPdf(receipt),
      receiptStorageKey: 'receipts/client.example.com/generated/receipt.pdf',
    }),
  };
}

describe('capability-scoped signing evidence', () => {
  beforeEach(() => vi.mocked(evaluateSignaturePolicy).mockReset());

  it('captures the exact current version, asserted typed name, auth context, hashes, and audit event', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());

    await expect(
      signAgreementVersion(
        {
          signingToken,
          agreementVersionId: requirement.agreementVersionId,
          accepted: true,
          typedName: '  Person Example  ',
          ipAddress: '203.0.113.4',
          userAgent: 'Test browser',
        },
        deps,
      ),
    ).resolves.toMatchObject({ id: 'signature-1' });

    expect(deps.createEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePdf,
        verificationUrl: expect.stringMatching(/^https:\/\/auth\.example\.com\/signatures\/verify\//),
        manifest: expect.objectContaining({
          userId: 'user-1',
          userEmail: 'person@example.com',
          signerName: 'Person Example',
          typedName: 'Person Example',
          agreementVersionId: 'version-2',
          sourcePdfSha256: requirement.sourcePdfSha256,
          acceptanceStatement: requirement.acceptanceStatement,
          authMethod: 'email_password',
          twoFaCompleted: true,
          ipAddress: '203.0.113.4',
          userAgent: 'Test browser',
        }),
      }),
    );
    expect(prisma.agreementSignature.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        signerName: 'Person Example',
        typedName: 'Person Example',
        evidenceManifestSha256: 'a'.repeat(64),
        evidenceSignature: 'compact-jws',
      }),
      include: expect.any(Object),
    });
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'signature.signed', actorUserId: 'user-1' }),
    });
  });

  it('returns the existing immutable record on retry without creating duplicate evidence', async () => {
    const existing = signatureRow();
    const prisma = fakePrisma({ existing });
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy([]));
    await expect(
      signAgreementVersion(
        {
          signingToken,
          agreementVersionId: requirement.agreementVersionId,
          accepted: true,
          typedName: 'Person Example',
        },
        deps,
      ),
    ).resolves.toBe(existing);
    expect(deps.createEvidence).not.toHaveBeenCalled();
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
  });

  it('counts rejected method/version submissions and exposes only a generic failure', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    await expect(
      signAgreementVersion(
        {
          signingToken,
          agreementVersionId: requirement.agreementVersionId,
          accepted: true,
          typedName: null,
        },
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'AUTHENTICATION_FAILED' });
    expect(prisma.signingContinuation.updateMany).toHaveBeenCalledWith({
      where: { id: 'continuation-1', consumedAt: null },
      data: { attemptCount: { increment: 1 } },
    });
    expect(deps.createEvidence).not.toHaveBeenCalled();
  });

  it('re-evaluates current requirements for the session and scopes source access to them', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    const session = await readSigningSession(signingToken, deps);
    expect(session).toMatchObject({
      domain: 'client.example.com',
      policyRevision: 4,
      agreements: [{ agreementVersionId: 'version-2' }],
    });
    await expect(
      readSigningAgreementSource(
        { signingToken, agreementVersionId: requirement.agreementVersionId },
        deps,
      ),
    ).resolves.toEqual({
      filename: 'service-terms.pdf',
      value: sourcePdf,
      sha256: requirement.sourcePdfSha256,
    });

    await expect(
      readSigningAgreementSource(
        { signingToken, agreementVersionId: 'other-domain-version' },
        deps,
      ),
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
  });

  it('verifies receipt bytes and rejects cross-continuation or tampered downloads', async () => {
    const receipt = Buffer.from('%PDF-receipt');
    const valid = signatureRow({ receiptPdfSha256: hashPdf(receipt) });
    const prisma = fakePrisma({ existing: valid });
    const deps = dependencies(prisma, receipt);
    await expect(
      readSigningReceipt({ signingToken, signatureId: valid.id }, deps),
    ).resolves.toMatchObject({ value: receipt, sha256: hashPdf(receipt) });

    prisma.agreementSignature.findFirst.mockResolvedValueOnce(null);
    await expect(
      readSigningReceipt({ signingToken, signatureId: 'other-signature' }, deps),
    ).rejects.toThrowError('AUTHENTICATION_FAILED');

    prisma.agreementSignature.findFirst.mockResolvedValueOnce(valid);
    deps.storage.read.mockResolvedValueOnce(Buffer.from('tampered'));
    await expect(
      readSigningReceipt({ signingToken, signatureId: valid.id }, deps),
    ).rejects.toThrowError('SIGNATURE_RECEIPT_HASH_MISMATCH');
  });
});
