import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

const serviceMocks = vi.hoisted(() => ({
  getSignatureAdminOverview: vi.fn(),
  updateSignatureSettings: vi.fn(),
  createAgreement: vi.fn(),
  updateAgreement: vi.fn(),
  uploadDraftAgreementVersion: vi.fn(),
  updateDraftAgreementVersion: vi.fn(),
  replaceDraftAgreementVersionPdf: vi.fn(),
  deleteDraftAgreementVersion: vi.fn(),
  readAgreementVersionSource: vi.fn(),
  publishAgreementVersion: vi.fn(),
  withdrawAgreementVersion: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/signature-admin.service.js', () => ({
  getSignatureAdminOverview: serviceMocks.getSignatureAdminOverview,
  updateSignatureSettings: serviceMocks.updateSignatureSettings,
  createAgreement: serviceMocks.createAgreement,
  updateAgreement: serviceMocks.updateAgreement,
}));
vi.mock('../../src/services/signature-agreement-lifecycle.service.js', () => ({
  uploadDraftAgreementVersion: serviceMocks.uploadDraftAgreementVersion,
  updateDraftAgreementVersion: serviceMocks.updateDraftAgreementVersion,
  replaceDraftAgreementVersionPdf: serviceMocks.replaceDraftAgreementVersionPdf,
  deleteDraftAgreementVersion: serviceMocks.deleteDraftAgreementVersion,
  readAgreementVersionSource: serviceMocks.readAgreementVersionSource,
}));
vi.mock('../../src/services/signature-agreement-publication.service.js', () => ({
  publishAgreementVersion: serviceMocks.publishAgreementVersion,
  withdrawAgreementVersion: serviceMocks.withdrawAgreementVersion,
}));
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
    .setSubject('user_123')
    .setIssuer(issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(adminSecret));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

function agreementRow() {
  return {
    id: 'agreement-1',
    domain: 'client.example.com',
    title: 'Terms',
    description: null,
    displayOrder: 2,
    requiredForAccess: true,
    createdAt: new Date('2026-07-15T10:00:00Z'),
    updatedAt: new Date('2026-07-15T10:00:00Z'),
  };
}

function versionRow() {
  return {
    id: 'version-1',
    agreementId: 'agreement-1',
    version: 1,
    title: 'Terms v1',
    originalFilename: 'terms.pdf',
    sourcePdfSha256: 'a'.repeat(64),
    signingMethod: 'TYPED_NAME',
    acceptanceStatement: 'I agree.',
    status: 'DRAFT',
    publishedAt: null,
    effectiveAt: null,
    publishedByEmail: null,
    createdAt: new Date('2026-07-15T10:00:00Z'),
  };
}

function multipartPayload(fields: Record<string, string>, file: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----uoa-signature-test-boundary';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="terms.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('/internal/admin/domains/:domain/signatures', () => {
  const original = {
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
    CONFIG_JWKS_URL: process.env.CONFIG_JWKS_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    SIGNATURE_MAX_PDF_BYTES: process.env.SIGNATURE_MAX_PDF_BYTES,
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'SIGNATURE_MAX_PDF_BYTES');
    for (const mock of Object.values(serviceMocks)) mock.mockReset();
    serviceMocks.getSignatureAdminOverview.mockResolvedValue({
      settings: {
        domain: 'client.example.com',
        enabled: false,
        policyRevision: 0,
        retentionDays: null,
        createdAt: null,
        updatedAt: null,
      },
      agreements: [],
      auditEvents: [],
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) restoreEnv(key, value);
  });

  it('requires a platform superuser', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/client.example.com/signatures',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(response.statusCode).toBe(403);
      expect(serviceMocks.getSignatureAdminOverview).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns normalized-domain settings and agreement summaries', async () => {
    serviceMocks.getSignatureAdminOverview.mockResolvedValue({
      settings: {
        domain: 'client.example.com',
        enabled: true,
        policyRevision: 4,
        retentionDays: 365,
        createdAt: new Date('2026-07-15T09:00:00Z'),
        updatedAt: new Date('2026-07-15T10:00:00Z'),
      },
      agreements: [{ ...agreementRow(), versions: [{ ...versionRow(), _count: { signatures: 2 } }] }],
      auditEvents: [],
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/Client.Example.COM/signatures',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(response.statusCode).toBe(200);
      expect(serviceMocks.getSignatureAdminOverview).toHaveBeenCalledWith('client.example.com');
      expect(response.json()).toMatchObject({
        settings: { enabled: true, policy_revision: 4, retention_days: 365 },
        agreements: [{ id: 'agreement-1', versions: [{ signature_count: 2 }] }],
      });
    } finally {
      await app.close();
    }
  });

  it('passes the actor identity through settings and agreement mutations', async () => {
    serviceMocks.updateSignatureSettings.mockResolvedValue({
      enabled: true,
      policyRevision: 1,
      retentionDays: 365,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    serviceMocks.createAgreement.mockResolvedValue(agreementRow());
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const authorization = `Bearer ${await accessToken('superuser')}`;
      const settings = await app.inject({
        method: 'PUT',
        url: '/internal/admin/domains/client.example.com/signatures/settings',
        headers: { authorization },
        payload: { enabled: true, retention_days: 365 },
      });
      expect(settings.statusCode).toBe(200);
      expect(serviceMocks.updateSignatureSettings).toHaveBeenCalledWith({
        domain: 'client.example.com',
        enabled: true,
        retentionDays: 365,
        actorEmail: 'admin@example.com',
      });

      const agreement = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/signatures/agreements',
        headers: { authorization },
        payload: { title: 'Terms', display_order: 2, required_for_access: true },
      });
      expect(agreement.statusCode).toBe(201);
      expect(serviceMocks.createAgreement).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'client.example.com', actorEmail: 'admin@example.com' }),
      );
    } finally {
      await app.close();
    }
  });

  it('accepts one bounded PDF multipart upload with exact signing metadata', async () => {
    serviceMocks.uploadDraftAgreementVersion.mockResolvedValue(versionRow());
    const upload = multipartPayload(
      {
        title: 'Terms v1',
        signing_method: 'typed_name',
        acceptance_statement: 'I agree.',
      },
      Buffer.from('%PDF-1.7\n%%EOF'),
    );
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/signatures/agreements/agreement-1/versions',
        headers: {
          authorization: `Bearer ${await accessToken('superuser')}`,
          'content-type': upload.contentType,
        },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      expect(serviceMocks.uploadDraftAgreementVersion).toHaveBeenCalledWith({
        domain: 'client.example.com',
        agreementId: 'agreement-1',
        title: 'Terms v1',
        originalFilename: 'terms.pdf',
        signingMethod: 'TYPED_NAME',
        acceptanceStatement: 'I agree.',
        sourcePdf: Buffer.from('%PDF-1.7\n%%EOF'),
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });

  it('streams a private no-store source PDF and scopes all identifiers through the service', async () => {
    serviceMocks.readAgreementVersionSource.mockResolvedValue({
      filename: 'terms.pdf',
      value: Buffer.from('%PDF-source'),
      sha256: 'a'.repeat(64),
    });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/client.example.com/signatures/agreements/agreement-1/versions/version-1/source',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(serviceMocks.readAgreementVersionSource).toHaveBeenCalledWith({
        domain: 'client.example.com',
        agreementId: 'agreement-1',
        versionId: 'version-1',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects an oversized multipart PDF before the lifecycle service sees it', async () => {
    process.env.SIGNATURE_MAX_PDF_BYTES = '1024';
    const upload = multipartPayload(
      {
        title: 'Terms v1',
        signing_method: 'clickwrap',
        acceptance_statement: 'I agree.',
      },
      Buffer.alloc(2048, 65),
    );
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/signatures/agreements/agreement-1/versions',
        headers: {
          authorization: `Bearer ${await accessToken('superuser')}`,
          'content-type': upload.contentType,
        },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(413);
      expect(serviceMocks.uploadDraftAgreementVersion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('applies a dedicated per-operator/domain upload rate limit', async () => {
    serviceMocks.uploadDraftAgreementVersion.mockResolvedValue(versionRow());
    const upload = multipartPayload(
      {
        title: 'Terms v1',
        signing_method: 'clickwrap',
        acceptance_statement: 'I agree.',
      },
      Buffer.from('%PDF-1.7\n%%EOF'),
    );
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const authorization = `Bearer ${await accessToken('superuser')}`;
      for (let index = 0; index < 20; index += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/internal/admin/domains/rate.example.com/signatures/agreements/agreement-1/versions',
          headers: { authorization, 'content-type': upload.contentType },
          payload: upload.body,
        });
        expect(response.statusCode).toBe(201);
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/rate.example.com/signatures/agreements/agreement-1/versions',
        headers: { authorization, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(limited.statusCode).toBe(429);
      expect(serviceMocks.uploadDraftAgreementVersion).toHaveBeenCalledTimes(20);
    } finally {
      await app.close();
    }
  });
});
