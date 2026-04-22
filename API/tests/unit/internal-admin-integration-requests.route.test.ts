import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';

const integrationRequestMocks = vi.hoisted(() => ({
  listIntegrationRequests: vi.fn(),
  getIntegrationRequestById: vi.fn(),
  declineIntegrationRequest: vi.fn(),
  deleteIntegrationRequest: vi.fn(),
}));

const auditLogMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/integration-request.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/integration-request.service.js')>(
    '../../src/services/integration-request.service.js',
  );
  return { ...actual, ...integrationRequestMocks };
});

vi.mock('../../src/services/audit-log.service.js', () => auditLogMocks);

vi.mock('../../src/db/prisma.js', () => prismaMocks);

const adminSecret = 'admin-token-secret-with-enough-length';
const sharedSecret = 'test-shared-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

async function accessToken(role: 'superuser' | 'user'): Promise<string> {
  return await new SignJWT({
    email: 'admin@example.com',
    domain: adminDomain,
    client_id: `admin:${adminDomain}`,
    role,
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
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    domain: 'client.example.com',
    status: 'PENDING',
    contactEmail: 'ops@client.example.com',
    publicJwk: { kty: 'RSA', kid: 'kid-1', n: 'nnn', e: 'AQAB' },
    jwkFingerprint: 'fp-hash',
    kid: 'kid-1',
    jwksUrl: 'https://client.example.com/.well-known/jwks.json',
    configUrl: 'https://client.example.com/config',
    configSummary: null,
    preValidationResult: null,
    declineReason: null,
    reviewedAt: null,
    reviewedByEmail: null,
    clientDomainId: null,
    submittedAt: new Date('2026-04-20T10:00:00Z'),
    lastSeenAt: new Date('2026-04-22T10:00:00Z'),
    ...overrides,
  };
}

describe('/internal/admin/integration-requests', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
  const originalConfigJwksUrl = process.env.CONFIG_JWKS_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');

    integrationRequestMocks.listIntegrationRequests.mockReset().mockResolvedValue([]);
    integrationRequestMocks.getIntegrationRequestById.mockReset().mockResolvedValue(null);
    integrationRequestMocks.declineIntegrationRequest.mockReset();
    integrationRequestMocks.deleteIntegrationRequest.mockReset();
    auditLogMocks.writeAuditLog.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('CONFIG_JWKS_URL', originalConfigJwksUrl);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  it('requires a superuser access token', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/integration-requests',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('lists requests filtered by status', async () => {
    integrationRequestMocks.listIntegrationRequests.mockResolvedValue([row({ status: 'PENDING' })]);

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/integration-requests?status=PENDING&limit=25',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(res.statusCode).toBe(200);
      expect(integrationRequestMocks.listIntegrationRequests).toHaveBeenCalledWith({
        status: 'PENDING',
        limit: 25,
      });
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'req-1',
        status: 'PENDING',
        domain: 'client.example.com',
        contact_email: 'ops@client.example.com',
      });
    } finally {
      await app.close();
    }
  });

  it('returns detail with the public JWK and config summary fields', async () => {
    integrationRequestMocks.getIntegrationRequestById.mockResolvedValue(
      row({ configSummary: { domain: 'client.example.com' } }),
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/integration-requests/req-1',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: 'req-1',
        public_jwk: { kid: 'kid-1' },
        config_summary: { domain: 'client.example.com' },
      });
    } finally {
      await app.close();
    }
  });

  it('declines a pending request and writes an audit log', async () => {
    integrationRequestMocks.declineIntegrationRequest.mockResolvedValue(
      row({
        status: 'DECLINED',
        declineReason: 'suspicious',
        reviewedAt: new Date('2026-04-22T12:00:00Z'),
        reviewedByEmail: 'admin@example.com',
      }),
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/decline',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { reason: 'suspicious' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'DECLINED',
        decline_reason: 'suspicious',
        reviewed_by_email: 'admin@example.com',
      });
      expect(integrationRequestMocks.declineIntegrationRequest).toHaveBeenCalledWith({
        id: 'req-1',
        reason: 'suspicious',
        reviewerEmail: 'admin@example.com',
      });
      expect(auditLogMocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: 'admin@example.com',
          action: 'integration.declined',
          targetDomain: 'client.example.com',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects decline with an empty reason', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/decline',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { reason: '' },
      });

      expect(res.statusCode).toBe(400);
      expect(integrationRequestMocks.declineIntegrationRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('deletes a declined request and writes an audit log', async () => {
    integrationRequestMocks.deleteIntegrationRequest.mockResolvedValue(
      row({ status: 'DECLINED' }),
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/integration-requests/req-1',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(auditLogMocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'integration.deleted',
          targetDomain: 'client.example.com',
          metadata: expect.objectContaining({ integrationRequestId: 'req-1', priorStatus: 'DECLINED' }),
        }),
      );
    } finally {
      await app.close();
    }
  });
});
