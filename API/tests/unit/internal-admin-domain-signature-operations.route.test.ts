import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

const operationMocks = vi.hoisted(() => ({
  searchAgreementSignatures: vi.fn(),
  readAdminSignatureReceipt: vi.fn(),
  revokeAgreementSignature: vi.fn(),
}));
const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/signature-admin-operations.service.js', () => operationMocks);
vi.mock('../../src/db/prisma.js', () => prismaMocks);

const adminSecret = 'admin-token-secret-with-enough-length';
const sharedSecret = 'test-shared-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

async function accessToken(role: 'superuser' | 'user'): Promise<string> {
  return new SignJWT({
    email: 'admin@example.com',
    domain: adminDomain,
    client_id: `admin:${adminDomain}`,
    role,
    tv: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(adminSecret));
}

function signatureRow() {
  return {
    id: 'signature-1',
    verificationReference: 'verify-reference-1234567890',
    userId: 'user-1',
    userEmail: 'person@example.com',
    signerName: 'Person Example',
    domain: 'client.example.com',
    agreementVersionId: 'version-1',
    signingMethod: 'TYPED_NAME',
    typedName: 'Person Example',
    acceptanceStatement: 'I agree.',
    sourcePdfSha256: 'a'.repeat(64),
    authMethod: 'password',
    twoFaCompleted: true,
    ipAddress: '203.0.113.2',
    userAgent: 'Test browser',
    evidenceManifestSha256: 'b'.repeat(64),
    receiptPdfSha256: 'c'.repeat(64),
    evidenceKeyId: 'evidence-2026',
    signedAt: new Date('2026-07-15T16:00:00Z'),
    version: {
      agreementId: 'agreement-1',
      version: 2,
      agreement: { id: 'agreement-1', title: 'Terms' },
    },
    revocation: null,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('internal Admin signature records', () => {
  const original = {
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
    CONFIG_JWKS_URL: process.env.CONFIG_JWKS_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    for (const mock of Object.values(operationMocks)) mock.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) restoreEnv(key, value);
  });

  it('requires a platform superuser for record search', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/client.example.com/signatures/records',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(response.statusCode).toBe(403);
      expect(operationMocks.searchAgreementSignatures).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('normalizes and passes bounded search filters without returning the raw evidence JWS', async () => {
    operationMocks.searchAgreementSignatures.mockResolvedValue({
      data: [signatureRow()],
      nextCursor: 'signature-1',
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/Client.Example.COM/signatures/records?q=person&agreement_id=agreement-1&limit=25',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(response.statusCode).toBe(200);
      expect(operationMocks.searchAgreementSignatures).toHaveBeenCalledWith({
        domain: 'client.example.com',
        query: 'person',
        agreementId: 'agreement-1',
        agreementVersionId: undefined,
        from: undefined,
        to: undefined,
        cursor: undefined,
        limit: 25,
      });
      expect(response.json()).toMatchObject({
        data: [{ id: 'signature-1', evidence_key_id: 'evidence-2026' }],
        next_cursor: 'signature-1',
      });
      expect(response.body).not.toContain('evidence_signature');
    } finally {
      await app.close();
    }
  });

  it('audits receipt access through the service and returns private no-store PDF bytes', async () => {
    operationMocks.readAdminSignatureReceipt.mockResolvedValue({
      filename: 'terms-v2-receipt.pdf',
      value: Buffer.from('%PDF-receipt'),
      sha256: 'd'.repeat(64),
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/client.example.com/signatures/records/signature-1/receipt',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(operationMocks.readAdminSignatureReceipt).toHaveBeenCalledWith({
        domain: 'client.example.com',
        signatureId: 'signature-1',
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });

  it('requires a reason and attributes revocation to the operator', async () => {
    operationMocks.revokeAgreementSignature.mockResolvedValue({
      id: 'revocation-1',
      signatureId: 'signature-1',
      actorEmail: 'admin@example.com',
      reason: 'Customer instruction',
      revokedAt: new Date('2026-07-15T17:00:00Z'),
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const authorization = `Bearer ${await accessToken('superuser')}`;
      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/signatures/records/signature-1/revoke',
        headers: { authorization },
        payload: { reason: '' },
      });
      expect(invalid.statusCode).toBe(400);

      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/signatures/records/signature-1/revoke',
        headers: { authorization },
        payload: { reason: 'Customer instruction' },
      });
      expect(response.statusCode).toBe(200);
      expect(operationMocks.revokeAgreementSignature).toHaveBeenCalledWith({
        domain: 'client.example.com',
        signatureId: 'signature-1',
        reason: 'Customer instruction',
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });
});
