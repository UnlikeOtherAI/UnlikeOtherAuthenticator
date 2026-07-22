import { expect, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import { hashSigningContinuationToken } from '../../src/services/signature-continuation.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';

const SHARED_SECRET = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
export const NOW = new Date('2026-07-15T21:00:00.000Z');
const env = parseEnv({ NODE_ENV: 'test', SHARED_SECRET });
export const signingToken = 'opaque-signing-capability-token';
export const sourcePdf = Buffer.from('%PDF-source');

export const requirement = {
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

export function continuation(overrides: Record<string, unknown> = {}) {
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

export function version() {
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

export function signatureRow(overrides: Record<string, unknown> = {}) {
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

export function fakePrisma(params?: { existing?: ReturnType<typeof signatureRow> | null }) {
  let intent: Record<string, unknown> | null = null;
  let persistedSignature = params?.existing ?? null;
  let continuationRow = continuation();
  let transactionDepth = 0;
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    signingContinuation: {
      findUnique: vi.fn(async () => continuationRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    signatureClaimIntent: {
      findUnique: vi.fn(async () => intent),
      findFirst: vi.fn(async () => intent),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        intent = {
          evidenceManifestSha256: null,
          receiptPdfSha256: null,
          receiptStorageKey: null,
          evidenceKeyId: null,
          evidenceSignature: null,
          evidenceReadyAt: null,
          completedAt: null,
          invalidatedAt: null,
          invalidationReason: null,
          updatedAt: NOW,
          ...data,
        };
        return intent;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!intent) throw new Error('missing intent');
        intent = { ...intent, ...data, updatedAt: NOW };
        return intent;
      }),
    },
    agreementSignature: {
      findFirst: vi.fn(async () => persistedSignature),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(async () => persistedSignature),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        persistedSignature = signatureRow({ ...data, revocation: null });
        return persistedSignature;
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: 'person@example.com', name: 'Profile Name' }),
    },
    agreementVersion: {
      findFirst: vi.fn().mockResolvedValue(version()),
    },
    signatureAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    get transactionDepth() {
      return transactionDepth;
    },
    setContinuation(value: ReturnType<typeof continuation>) {
      continuationRow = value;
    },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
    transactionDepth += 1;
    try {
      return await callback(prisma);
    } finally {
      transactionDepth -= 1;
    }
  });
  return prisma;
}

export function policy(missing = [requirement]) {
  return {
    enabled: true,
    policyRevision: 4,
    complete: missing.length === 0,
    required: [requirement],
    missing,
  };
}

export function evidenceFor(
  manifest: { domain: string; signatureId: string },
  receipt = Buffer.from('%PDF-receipt'),
) {
  return {
    canonicalManifest: '{}',
    manifestSha256: 'a'.repeat(64),
    compactJws: 'compact-jws',
    keyId: 'evidence-key',
    receiptPdf: receipt,
    receiptPdfSha256: hashPdf(receipt),
    receiptStorageKey: `receipts/${manifest.domain}/${manifest.signatureId}/receipt.pdf`,
  };
}

export function dependencies(
  prisma: ReturnType<typeof fakePrisma>,
  receipt = Buffer.from('%PDF-receipt'),
) {
  return {
    env,
    prisma: prisma as never,
    sharedSecret: SHARED_SECRET,
    publicBaseUrl: 'https://auth.example.com',
    now: () => NOW,
    storage: {
      putImmutable: vi.fn(async () => {
        expect(prisma.transactionDepth).toBe(0);
      }),
      read: vi.fn(async (key: string) => {
        expect(prisma.transactionDepth).toBe(0);
        return key.startsWith('receipts/') ? receipt : sourcePdf;
      }),
      deleteDraft: vi.fn(),
    },
    createEvidence: vi.fn().mockImplementation(async ({ manifest, storage }) => {
      expect(prisma.transactionDepth).toBe(0);
      const evidence = evidenceFor(manifest, receipt);
      await storage.putImmutable(evidence.receiptStorageKey, receipt, 'application/pdf');
      return evidence;
    }),
  };
}
