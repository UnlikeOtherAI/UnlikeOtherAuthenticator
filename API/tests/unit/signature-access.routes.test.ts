import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accessMocks = vi.hoisted(() => ({
  getCurrentSignatureStatus: vi.fn(),
  readSignerReceipt: vi.fn(),
  verifyPublicSignatureReference: vi.fn(),
}));
const verifyAccessTokenMock = vi.hoisted(() => vi.fn());
const prisma = vi.hoisted(() => ({
  domainRole: { findUnique: vi.fn() },
}));

vi.mock('../../src/services/signature-access.service.js', () => accessMocks);
vi.mock('../../src/services/access-token.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/access-token.service.js')
  >('../../src/services/access-token.service.js');
  return { ...actual, verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args) };
});
vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    config?: { domain: string };
    configUrl?: string;
  }) => {
    request.config = { domain: 'client.example.com' };
    request.configUrl = 'https://client.example.com/auth-config';
  },
}));
vi.mock('../../src/middleware/domain-hash-auth.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/middleware/domain-hash-auth.js')
  >('../../src/middleware/domain-hash-auth.js');
  return {
    ...actual,
    requireDomainHashAuth: async (request: { domainAuthClientId?: string }) => {
      request.domainAuthClientId = 'domain-client-1';
    },
  };
});
vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(() => prisma),
  getAdminPrisma: vi.fn(() => prisma),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

function status() {
  return {
    enabled: true,
    complete: true,
    policyRevision: 4,
    requirements: [
      {
        agreementId: 'agreement-1',
        agreementVersionId: 'version-1',
        agreementTitle: 'Terms',
        title: 'Terms 2026',
        version: 1,
        signingMethod: 'CLICKWRAP',
        sourcePdfSha256: 'a'.repeat(64),
        satisfied: true,
        signatureId: 'signature-1',
        signedAt: new Date('2026-07-15T20:00:00.000Z'),
        verificationReference: 'reference_1234567890123456789012',
        receiptPdfSha256: 'b'.repeat(64),
      },
    ],
  };
}

describe('signer, domain, and public signature routes', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://signature-routes.invalid/db';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    for (const mock of [...Object.values(accessMocks), verifyAccessTokenMock, prisma.domainRole.findUnique]) {
      mock.mockReset();
    }
    verifyAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      email: 'person@example.com',
      domain: 'client.example.com',
      clientId: 'client-1',
      role: 'user',
      tokenVersion: 0,
    });
    accessMocks.getCurrentSignatureStatus.mockResolvedValue(status());
    prisma.domainRole.findUnique.mockResolvedValue({ userId: 'user-1' });
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
    else process.env.SHARED_SECRET = originalSharedSecret;
  });

  it('restricts signer status to the access-token subject and domain', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const missing = await app.inject({ method: 'GET', url: '/signatures/me/status' });
      expect(missing.statusCode).toBe(401);

      const response = await app.inject({
        method: 'GET',
        url: '/signatures/me/status',
        headers: { 'x-uoa-access-token': 'Bearer access-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(accessMocks.getCurrentSignatureStatus).toHaveBeenCalledWith(
        { domain: 'client.example.com', userId: 'user-1' },
        { prisma },
      );
      expect(response.json()).toMatchObject({
        complete: true,
        requirements: [{ signature_id: 'signature-1', satisfied: true }],
      });
    } finally {
      await app.close();
    }
  });

  it('streams only a subject-scoped receipt with private integrity headers', async () => {
    accessMocks.readSignerReceipt.mockResolvedValue({
      filename: 'terms-v1-receipt.pdf',
      value: Buffer.from('%PDF-receipt'),
      sha256: 'c'.repeat(64),
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/signatures/me/receipts/signature-1',
        headers: { 'x-uoa-access-token': 'access-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.etag).toBe(`"sha256-${'c'.repeat(64)}"`);
      expect(accessMocks.readSignerReceipt).toHaveBeenCalledWith(
        { domain: 'client.example.com', userId: 'user-1', signatureId: 'signature-1' },
        { prisma },
      );
    } finally {
      await app.close();
    }
  });

  it('allows an authenticated domain backend to read status only for a domain user', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/domain/signatures/status?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
        payload: { user_id: 'user-1' },
      });
      expect(response.statusCode).toBe(200);
      expect(prisma.domainRole.findUnique).toHaveBeenCalledWith({
        where: { domain_userId: { domain: 'client.example.com', userId: 'user-1' } },
        select: { userId: true },
      });
      expect(response.json()).toMatchObject({ user_id: 'user-1', complete: true });
    } finally {
      await app.close();
    }
  });

  it('returns only the PII-minimised integrity result for a public reference', async () => {
    accessMocks.verifyPublicSignatureReference.mockResolvedValue({
      state: 'valid',
      integrityVerified: true,
      verificationReference: 'reference_1234567890123456789012',
      agreementId: 'agreement-1',
      agreementVersionId: 'version-1',
      agreementVersion: 1,
      sourcePdfSha256: 'a'.repeat(64),
      receiptPdfSha256: 'b'.repeat(64),
      signedAt: new Date('2026-07-15T20:00:00.000Z'),
      evidenceKeyId: 'evidence-2026',
      revokedAt: null,
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/signatures/verify/reference_1234567890123456789012',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: 'valid', integrity_verified: true });
      for (const forbidden of ['user_id', 'email', 'signer_name', 'ip_address', 'user_agent']) {
        expect(response.body).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });
});
