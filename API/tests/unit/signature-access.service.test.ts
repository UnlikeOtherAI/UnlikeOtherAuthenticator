import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import {
  getCurrentSignatureStatus,
  readSignerReceipt,
  verifyPublicSignatureReference,
} from '../../src/services/signature-access.service.js';
import {
  signEvidenceManifest,
  type SignatureEvidenceManifest,
} from '../../src/services/signature-evidence.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';

const sharedSecret = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
let privateJwkJson: string;
let publicJwksJson: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  Object.assign(privateJwk, { alg: 'RS256', use: 'sig', kid: 'evidence-access-test' });
  Object.assign(publicJwk, { alg: 'RS256', use: 'sig', kid: 'evidence-access-test' });
  privateJwkJson = JSON.stringify(privateJwk);
  publicJwksJson = JSON.stringify({ keys: [publicJwk] });
});

function policyAgreement() {
  return {
    id: 'agreement-1',
    title: 'Service Terms',
    description: 'Please review.',
    displayOrder: 1,
    versions: [
      {
        id: 'version-1',
        version: 1,
        title: 'Service Terms 2026',
        originalFilename: 'terms.pdf',
        signingMethod: 'CLICKWRAP',
        acceptanceStatement: 'I accept.',
        sourcePdfSha256: 'a'.repeat(64),
      },
    ],
  };
}

function statusPrisma(params: { revoked?: boolean; signed?: boolean; enabled?: boolean }) {
  const policySignature = params.signed
    ? { agreementVersionId: 'version-1', revocation: params.revoked ? { id: 'rev-1' } : null }
    : null;
  const fullSignature = params.signed
    ? {
        id: 'signature-1',
        agreementVersionId: 'version-1',
        verificationReference: 'reference_1234567890123456789012',
        receiptPdfSha256: 'b'.repeat(64),
        signedAt: new Date('2026-07-15T20:00:00.000Z'),
        revocation: params.revoked ? { id: 'rev-1' } : null,
      }
    : null;
  const agreementSignature = {
    findMany: vi
      .fn()
      .mockResolvedValueOnce(policySignature ? [policySignature] : [])
      .mockResolvedValueOnce(fullSignature ? [fullSignature] : []),
  };
  return {
    domainSignatureSettings: {
      findUnique: vi.fn().mockResolvedValue({
        enabled: params.enabled ?? true,
        policyRevision: 7,
        retentionDays: 365,
      }),
    },
    agreement: { findMany: vi.fn().mockResolvedValue([policyAgreement()]) },
    agreementSignature,
  } as unknown as PrismaClient;
}

describe('protected signature status and receipts', () => {
  it('reports the current valid signature without exposing superseded evidence', async () => {
    const result = await getCurrentSignatureStatus(
      { domain: 'client.example.com', userId: 'user-1' },
      { prisma: statusPrisma({ signed: true }) },
    );

    expect(result).toMatchObject({ enabled: true, complete: true, policyRevision: 7 });
    expect(result.requirements).toEqual([
      expect.objectContaining({
        agreementVersionId: 'version-1',
        satisfied: true,
        signatureId: 'signature-1',
      }),
    ]);
  });

  it('reports a revoked signature as unsatisfied', async () => {
    const result = await getCurrentSignatureStatus(
      { domain: 'client.example.com', userId: 'user-1' },
      { prisma: statusPrisma({ signed: true, revoked: true }) },
    );

    expect(result.complete).toBe(false);
    expect(result.requirements[0]).toMatchObject({ satisfied: false, signatureId: null });
  });

  it('scopes receipt access by both domain and access-token subject and verifies bytes', async () => {
    const value = Buffer.from('%PDF-receipt');
    const prisma = {
      agreementSignature: {
        findFirst: vi.fn().mockResolvedValue({
          receiptStorageKey: 'receipts/client/signature-1/receipt.pdf',
          receiptPdfSha256: hashPdf(value),
          version: { version: 1, agreement: { title: 'Terms' } },
        }),
      },
    } as unknown as PrismaClient;
    const storage = { read: vi.fn().mockResolvedValue(value) } as never;
    await expect(
      readSignerReceipt(
        { domain: 'client.example.com', userId: 'user-1', signatureId: 'signature-1' },
        { prisma, storage },
      ),
    ).resolves.toMatchObject({ filename: 'Terms-v1-receipt.pdf', sha256: hashPdf(value) });
    expect(prisma.agreementSignature.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'signature-1',
        domain: 'client.example.com',
        userId: 'user-1',
      },
      include: { version: { include: { agreement: true } } },
    });

    prisma.agreementSignature.findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      readSignerReceipt(
        { domain: 'other.example.com', userId: 'user-2', signatureId: 'signature-1' },
        { prisma, storage },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

function evidenceManifest(sourcePdfSha256: string): SignatureEvidenceManifest {
  return {
    schemaVersion: 1,
    signatureId: 'signature-1',
    verificationReference: 'reference_1234567890123456789012',
    userId: 'user-1',
    userEmail: 'person@example.com',
    signerName: 'Person Example',
    domain: 'client.example.com',
    agreementId: 'agreement-1',
    agreementVersionId: 'version-1',
    agreementVersion: 1,
    agreementTitle: 'Terms',
    sourcePdfSha256,
    acceptanceStatement: 'I accept.',
    signingMethod: 'CLICKWRAP',
    typedName: null,
    signedAt: '2026-07-15T20:00:00.000Z',
    authMethod: 'email_password',
    twoFaCompleted: true,
    ipAddress: '203.0.113.1',
    userAgent: 'Test browser',
    signingContinuationId: 'continuation-1',
  };
}

async function publicFixture(params?: { tamperReceipt?: boolean; revoked?: boolean }) {
  const source = Buffer.from('%PDF-source');
  const receipt = Buffer.from('%PDF-receipt');
  const manifest = evidenceManifest(hashPdf(source));
  const signed = await signEvidenceManifest(manifest, privateJwkJson);
  const row = {
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
    evidenceManifestSha256: signed.manifestSha256,
    receiptPdfSha256: hashPdf(receipt),
    receiptStorageKey: 'receipts/client/signature-1/receipt.pdf',
    evidenceKeyId: signed.keyId,
    evidenceSignature: signed.compactJws,
    signedAt: new Date(manifest.signedAt),
    revocation: params?.revoked
      ? { id: 'revocation-1', revokedAt: new Date('2026-07-16T10:00:00.000Z') }
      : null,
    version: {
      agreementId: manifest.agreementId,
      version: manifest.agreementVersion,
      sourcePdfSha256: manifest.sourcePdfSha256,
      sourceStorageKey: 'sources/client/version-1/source.pdf',
      agreement: { title: manifest.agreementTitle },
    },
  };
  const prisma = {
    agreementSignature: { findUnique: vi.fn().mockResolvedValue(row) },
  } as unknown as PrismaClient;
  const storage = {
    read: vi.fn(async (key: string) => {
      if (key === row.version.sourceStorageKey) return source;
      return params?.tamperReceipt ? Buffer.from('%PDF-tampered') : receipt;
    }),
  } as never;
  const env = parseEnv({
    NODE_ENV: 'test',
    SHARED_SECRET: sharedSecret,
    SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: publicJwksJson,
  });
  return { env, prisma, storage, manifest };
}

describe('public signature verification', () => {
  it('verifies the JWS, manifest hash, exact source, receipt, and revocation state without PII', async () => {
    const fixture = await publicFixture({ revoked: true });
    const result = await verifyPublicSignatureReference(fixture.manifest.verificationReference, fixture);

    expect(result).toMatchObject({
      state: 'revoked',
      integrityVerified: true,
      evidenceKeyId: 'evidence-access-test',
      sourcePdfSha256: fixture.manifest.sourcePdfSha256,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('Person Example');
    expect(serialized).not.toContain('203.0.113.1');
    expect(serialized).not.toContain('user-1');
  });

  it('fails closed when stored receipt bytes no longer match the immutable hash', async () => {
    const fixture = await publicFixture({ tamperReceipt: true });
    await expect(
      verifyPublicSignatureReference(fixture.manifest.verificationReference, fixture),
    ).rejects.toThrowError('SIGNATURE_EVIDENCE_INTEGRITY_FAILED');
  });
});
