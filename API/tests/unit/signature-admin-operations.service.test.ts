import { describe, expect, it, vi } from 'vitest';

import {
  readAdminSignatureReceipt,
  revokeAgreementSignature,
  searchAgreementSignatures,
} from '../../src/services/signature-admin-operations.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';

const NOW = new Date('2026-07-15T16:00:00.000Z');

function signatureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'signature-1',
    verificationReference: 'verify-reference-1234567890',
    userId: 'user-1',
    userEmail: 'person@example.com',
    signerName: 'Person Example',
    domain: 'example.com',
    agreementVersionId: 'version-1',
    signingContinuationId: 'continuation-1',
    signingMethod: 'CLICKWRAP',
    typedName: null,
    acceptanceStatement: 'I agree.',
    sourcePdfSha256: 'a'.repeat(64),
    authMethod: 'password',
    twoFaCompleted: true,
    ipAddress: '203.0.113.2',
    userAgent: 'Test browser',
    evidenceManifestSha256: 'b'.repeat(64),
    receiptPdfSha256: 'c'.repeat(64),
    receiptStorageKey: 'receipts/example.com/signature-1/receipt.pdf',
    evidenceKeyId: 'evidence-2026',
    evidenceSignature: 'jws',
    signedAt: NOW,
    version: {
      id: 'version-1',
      agreementId: 'agreement-1',
      version: 2,
      agreement: { id: 'agreement-1', title: 'Universal Terms' },
    },
    revocation: null,
    ...overrides,
  };
}

function fakePrisma() {
  const prisma = {
    agreementSignature: { findFirst: vi.fn(), findMany: vi.fn() },
    signatureRevocation: { create: vi.fn() },
    signatureAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  return prisma;
}

describe('admin signature search', () => {
  it('scopes every filter and cursor to the normalized domain with bounded pagination', async () => {
    const prisma = fakePrisma();
    prisma.agreementSignature.findFirst.mockResolvedValue({ id: 'cursor-1' });
    prisma.agreementSignature.findMany.mockResolvedValue([
      signatureRow({ id: 'signature-2' }),
      signatureRow({ id: 'signature-1' }),
    ]);
    const result = await searchAgreementSignatures(
      {
        domain: 'Example.COM',
        query: 'person',
        agreementId: 'agreement-1',
        from: new Date('2026-07-01T00:00:00Z'),
        to: new Date('2026-07-31T23:59:59Z'),
        cursor: 'cursor-1',
        limit: 2,
      },
      { prisma: prisma as never },
    );
    expect(prisma.agreementSignature.findFirst).toHaveBeenCalledWith({
      where: { id: 'cursor-1', domain: 'example.com' },
      select: { id: true },
    });
    expect(prisma.agreementSignature.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ domain: 'example.com', version: { agreementId: 'agreement-1' } }),
        cursor: { id: 'cursor-1' },
        skip: 1,
        take: 2,
      }),
    );
    expect(result.nextCursor).toBe('signature-1');
  });

  it('rejects cross-domain/unknown cursors and inverted date ranges', async () => {
    const prisma = fakePrisma();
    prisma.agreementSignature.findFirst.mockResolvedValue(null);
    await expect(
      searchAgreementSignatures(
        { domain: 'example.com', cursor: 'other-domain-signature', limit: 50 },
        { prisma: prisma as never },
      ),
    ).rejects.toThrowError('INVALID_SIGNATURE_CURSOR');
    await expect(
      searchAgreementSignatures(
        {
          domain: 'example.com',
          from: new Date('2026-08-01T00:00:00Z'),
          to: new Date('2026-07-01T00:00:00Z'),
          limit: 50,
        },
        { prisma: prisma as never },
      ),
    ).rejects.toThrowError('INVALID_SIGNATURE_DATE_RANGE');
  });
});

describe('admin receipt access and revocation', () => {
  it('verifies receipt bytes before writing an access audit event', async () => {
    const prisma = fakePrisma();
    const receipt = Buffer.from('%PDF-receipt');
    prisma.agreementSignature.findFirst.mockResolvedValue(
      signatureRow({ receiptPdfSha256: hashPdf(receipt) }),
    );
    const result = await readAdminSignatureReceipt(
      { domain: 'example.com', signatureId: 'signature-1', actorEmail: 'admin@example.com' },
      {
        prisma: prisma as never,
        storage: {
          putImmutable: vi.fn(),
          read: vi.fn().mockResolvedValue(receipt),
          deleteDraft: vi.fn(),
        },
      },
    );
    expect(result).toMatchObject({ filename: 'Universal-Terms-v2-receipt.pdf', value: receipt });
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'signature.receipt_accessed' }),
    });
  });

  it('does not audit or return a receipt whose immutable hash changed', async () => {
    const prisma = fakePrisma();
    prisma.agreementSignature.findFirst.mockResolvedValue(signatureRow());
    await expect(
      readAdminSignatureReceipt(
        { domain: 'example.com', signatureId: 'signature-1', actorEmail: 'admin@example.com' },
        {
          prisma: prisma as never,
          storage: {
            putImmutable: vi.fn(),
            read: vi.fn().mockResolvedValue(Buffer.from('tampered')),
            deleteDraft: vi.fn(),
          },
        },
      ),
    ).rejects.toThrowError('SIGNATURE_RECEIPT_HASH_MISMATCH');
    expect(prisma.signatureAuditEvent.create).not.toHaveBeenCalled();
  });

  it('creates one append-only revocation and returns the existing record on retry', async () => {
    const prisma = fakePrisma();
    const revocation = {
      id: 'revocation-1',
      signatureId: 'signature-1',
      actorEmail: 'admin@example.com',
      reason: 'Customer instruction',
      revokedAt: NOW,
    };
    prisma.agreementSignature.findFirst.mockResolvedValue(signatureRow());
    prisma.signatureRevocation.create.mockResolvedValue(revocation);
    await expect(
      revokeAgreementSignature(
        {
          domain: 'example.com',
          signatureId: 'signature-1',
          reason: 'Customer instruction',
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never },
      ),
    ).resolves.toEqual(revocation);
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'signature.revoked' }),
    });

    prisma.agreementSignature.findFirst.mockResolvedValue(
      signatureRow({ revocation }),
    );
    await expect(
      revokeAgreementSignature(
        {
          domain: 'example.com',
          signatureId: 'signature-1',
          reason: 'Ignored retry text',
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never },
      ),
    ).resolves.toEqual(revocation);
    expect(prisma.signatureRevocation.create).toHaveBeenCalledOnce();
  });

  it('recovers from a concurrent duplicate revocation without writing duplicate audit evidence', async () => {
    const prisma = fakePrisma();
    const revocation = {
      id: 'revocation-1',
      signatureId: 'signature-1',
      actorEmail: 'other-admin@example.com',
      reason: 'Concurrent instruction',
      revokedAt: NOW,
    };
    prisma.agreementSignature.findFirst
      .mockResolvedValueOnce(signatureRow())
      .mockResolvedValueOnce(signatureRow({ revocation }));
    prisma.signatureRevocation.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      revokeAgreementSignature(
        {
          domain: 'example.com',
          signatureId: 'signature-1',
          reason: 'Customer instruction',
          actorEmail: 'admin@example.com',
        },
        { prisma: prisma as never },
      ),
    ).resolves.toEqual(revocation);
    expect(prisma.signatureAuditEvent.create).not.toHaveBeenCalled();
  });
});
