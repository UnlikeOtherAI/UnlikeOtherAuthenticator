import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSigningAgreementSource,
  readSigningReceipt,
  readSigningSession,
  signAgreementVersion,
} from '../../src/services/signature-signing.service.js';
import { evaluateSignaturePolicy } from '../../src/services/signature-policy.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';
import {
  NOW,
  continuation,
  dependencies,
  evidenceFor,
  fakePrisma,
  policy,
  requirement,
  signatureRow,
  signingToken,
  sourcePdf,
  version,
} from './signature-signing.test-fixture.js';

vi.mock('../../src/services/signature-policy.service.js', () => ({
  evaluateSignaturePolicy: vi.fn(),
}));

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
    ).resolves.toMatchObject({
      userId: 'user-1',
      agreementVersionId: 'version-2',
      claimIntentId: expect.any(String),
    });

    expect(deps.createEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePdf,
        verificationUrl: expect.stringMatching(
          /^https:\/\/auth\.example\.com\/signatures\/verify\//,
        ),
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
        claimIntentId: expect.any(String),
      }),
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

  it('converges a lost response on the one committed signature and audit record', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    const input = {
      signingToken,
      agreementVersionId: requirement.agreementVersionId,
      accepted: true,
      typedName: 'Person Example',
    };
    const first = await signAgreementVersion(input, deps);
    const replay = await signAgreementVersion(input, deps);
    expect(replay.id).toBe(first.id);
    expect(deps.createEvidence).toHaveBeenCalledTimes(1);
    expect(prisma.agreementSignature.create).toHaveBeenCalledTimes(1);
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent duplicate submissions while evidence creation is in flight', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    let releaseFirst: (() => void) | undefined;
    const firstEvidenceMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let evidenceCalls = 0;
    deps.createEvidence.mockImplementation(async ({ manifest }) => {
      evidenceCalls += 1;
      if (evidenceCalls === 1) await firstEvidenceMayFinish;
      return evidenceFor(manifest);
    });
    const input = {
      signingToken,
      agreementVersionId: requirement.agreementVersionId,
      accepted: true,
      typedName: 'Person Example',
    };
    const first = signAgreementVersion(input, deps);
    await vi.waitFor(() => expect(evidenceCalls).toBe(1));
    const secondResult = await signAgreementVersion(input, deps);
    releaseFirst?.();
    const firstResult = await first;
    expect(firstResult.id).toBe(secondResult.id);
    expect(prisma.agreementSignature.create).toHaveBeenCalledTimes(1);
    expect(prisma.signatureAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('invalidates prepared evidence when the locked policy revision changes', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy)
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce({ ...policy(), policyRevision: 5 });
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
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
    expect(prisma.signatureClaimIntent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({
        status: 'INVALIDATED',
        invalidationReason: 'POLICY_CHANGED',
      }),
    });
  });

  it('invalidates prepared evidence when the exact published version changes', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    prisma.agreementVersion.findFirst
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce({ ...version(), sourceStorageKey: 'agreements/drifted/source.pdf' });
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
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
    expect(prisma.signatureClaimIntent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({
        status: 'INVALIDATED',
        invalidationReason: 'VERSION_CHANGED',
      }),
    });
  });

  it('invalidates prepared evidence when signature or revocation history changes', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    prisma.agreementSignature.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'historical-signature', revocation: { id: 'new-revocation' } },
      ]);
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
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
    expect(prisma.signatureClaimIntent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({
        status: 'INVALIDATED',
        invalidationReason: 'SIGNATURE_STATE_CHANGED',
      }),
    });
  });

  it('fails closed if the continuation expires while evidence is created', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    deps.createEvidence.mockImplementationOnce(async ({ manifest }) => {
      prisma.setContinuation(continuation({ expiresAt: NOW }));
      return evidenceFor(manifest);
    });
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
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
    expect(prisma.signatureAuditEvent.create).not.toHaveBeenCalled();
  });

  it('rechecks expiry immediately before the atomic signature persist', async () => {
    const prisma = fakePrisma();
    const deps = dependencies(prisma);
    const expiresAt = new Date(NOW.getTime() + 10 * 60_000);
    let clock = NOW;
    deps.now = () => clock;
    vi.mocked(evaluateSignaturePolicy).mockResolvedValue(policy());
    prisma.agreementSignature.findMany
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        clock = expiresAt;
        return [];
      });
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
    ).rejects.toThrowError('AUTHENTICATION_FAILED');
    expect(prisma.agreementSignature.create).not.toHaveBeenCalled();
    expect(prisma.signatureClaimIntent.update).toHaveBeenLastCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({
        status: 'INVALIDATED',
        invalidationReason: 'CONTINUATION_EXPIRED',
      }),
    });
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
