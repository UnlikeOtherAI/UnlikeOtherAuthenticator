import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/utils/errors.js';

const continuationMocks = vi.hoisted(() => ({ completeSigningContinuation: vi.fn() }));
const signingMocks = vi.hoisted(() => ({
  readSigningAgreementSource: vi.fn(),
  readSigningReceipt: vi.fn(),
  readSigningSession: vi.fn(),
  signAgreementVersion: vi.fn(),
}));
const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/signature-continuation.service.js', () => continuationMocks);
vi.mock('../../src/services/signature-signing.service.js', () => signingMocks);
vi.mock('../../src/db/prisma.js', () => prismaMocks);

const sharedSecret = 'test-shared-secret-with-enough-length';
const token = 'opaque-signing-capability-token';
const NOW = new Date('2026-07-15T20:00:00.000Z');

function session() {
  return {
    domain: 'client.example.com',
    expiresAt: new Date('2026-07-15T20:10:00.000Z'),
    initialPolicyRevision: 3,
    policyRevision: 4,
    complete: false,
    agreements: [
      {
        agreementId: 'agreement-1',
        agreementVersionId: 'version-2',
        agreementTitle: 'Service Terms',
        title: 'Service Terms July 2026',
        description: 'Please review these terms.',
        version: 2,
        originalFilename: 'service-terms.pdf',
        signingMethod: 'TYPED_NAME',
        acceptanceStatement: 'I agree to the Service Terms.',
        sourcePdfSha256: 'a'.repeat(64),
      },
    ],
    receipts: [],
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('signing capability session routes', () => {
  const original = {
    SHARED_SECRET: process.env.SHARED_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    for (const mock of [...Object.values(continuationMocks), ...Object.values(signingMocks)]) {
      mock.mockReset();
    }
    signingMocks.readSigningSession.mockResolvedValue(session());
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) restoreEnv(key, value);
  });

  it('returns only current missing versions and no-store continuation state', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/signatures/session',
        payload: { signing_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        ok: true,
        domain: 'client.example.com',
        policy_revision: 4,
        complete: false,
        agreements: [
          {
            agreement_version_id: 'version-2',
            signing_method: 'typed_name',
            source_pdf_sha256: 'a'.repeat(64),
          },
        ],
      });
      expect(signingMocks.readSigningSession).toHaveBeenCalledWith(token);
    } finally {
      await app.close();
    }
  });

  it('serves only capability-scoped source and receipt PDFs with private integrity headers', async () => {
    signingMocks.readSigningAgreementSource.mockResolvedValue({
      filename: 'terms.pdf',
      value: Buffer.from('%PDF-source'),
      sha256: 'a'.repeat(64),
    });
    signingMocks.readSigningReceipt.mockResolvedValue({
      filename: 'terms-v2-receipt.pdf',
      value: Buffer.from('%PDF-receipt'),
      sha256: 'b'.repeat(64),
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const source = await app.inject({
        method: 'POST',
        url: '/signatures/session/source',
        payload: { signing_token: token, agreement_version_id: 'version-2' },
      });
      expect(source.statusCode).toBe(200);
      expect(source.headers['content-type']).toContain('application/pdf');
      expect(source.headers['content-disposition']).toContain('inline');
      expect(source.headers.etag).toBe(`"sha256-${'a'.repeat(64)}"`);

      const receipt = await app.inject({
        method: 'POST',
        url: '/signatures/session/receipt',
        payload: { signing_token: token, signature_id: 'signature-1' },
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.headers['content-disposition']).toContain('attachment');
      expect(receipt.headers['cache-control']).toBe('private, no-store');
      expect(signingMocks.readSigningReceipt).toHaveBeenCalledWith({
        signingToken: token,
        signatureId: 'signature-1',
      });
    } finally {
      await app.close();
    }
  });

  it('captures the explicit acceptance, asserted name, IP, and bounded user agent server-side', async () => {
    signingMocks.signAgreementVersion.mockResolvedValue({
      id: 'signature-1',
      verificationReference: 'verification-reference',
      receiptPdfSha256: 'b'.repeat(64),
      signedAt: NOW,
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/signatures/session/sign',
        headers: { 'user-agent': 'Test browser' },
        payload: {
          signing_token: token,
          agreement_version_id: 'version-2',
          accepted: true,
          typed_name: 'Person Example',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(signingMocks.signAgreementVersion).toHaveBeenCalledWith({
        signingToken: token,
        agreementVersionId: 'version-2',
        accepted: true,
        typedName: 'Person Example',
        ipAddress: '127.0.0.1',
        userAgent: 'Test browser',
      });
      expect(response.body).not.toContain('evidence_signature');
    } finally {
      await app.close();
    }
  });

  it('rejects cross-site browser signing mutations before the capability is used', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/signatures/session/sign',
        headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
        payload: {
          signing_token: token,
          agreement_version_id: 'version-2',
          accepted: true,
          typed_name: 'Person Example',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(signingMocks.signAgreementVersion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rechecks completion and returns only the exact server-preserved redirect', async () => {
    continuationMocks.completeSigningContinuation.mockResolvedValue({
      status: 'granted',
      code: 'authorization-code',
      redirectTo: 'https://client.example.com/callback?code=authorization-code',
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/signatures/session/complete',
        payload: { signing_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        complete: true,
        redirect_to: 'https://client.example.com/callback?code=authorization-code',
      });
    } finally {
      await app.close();
    }
  });

  it('returns one generic public error for invalid, expired, and consumed capabilities', async () => {
    signingMocks.readSigningSession.mockRejectedValue(
      new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'),
    );
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const responses = await Promise.all(
        ['invalid-capability-token-000', 'expired-capability-token-000', 'consumed-capability-token-0'].map(
          (signingToken) =>
            app.inject({
              method: 'POST',
              url: '/signatures/session',
              payload: { signing_token: signingToken },
            }),
        ),
      );
      expect(new Set(responses.map((response) => response.body)).size).toBe(1);
      expect(responses.every((response) => response.statusCode === 401)).toBe(true);
      expect(responses[0]?.body).not.toContain('AUTHENTICATION_FAILED');
    } finally {
      await app.close();
    }
  });
});
