import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';

const integrationRequestMocks = vi.hoisted(() => ({
  listIntegrationRequests: vi.fn(),
  getIntegrationRequestById: vi.fn(),
  declineIntegrationRequest: vi.fn(),
  deleteIntegrationRequest: vi.fn(),
}));

const integrationAcceptMocks = vi.hoisted(() => ({
  acceptIntegrationRequest: vi.fn(),
  resendIntegrationClaim: vi.fn(),
}));

const emailMocks = vi.hoisted(() => ({
  sendIntegrationApprovedEmail: vi.fn(async () => {}),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/integration-request.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/integration-request.service.js')>(
    '../../src/services/integration-request.service.js',
  );
  return { ...actual, ...integrationRequestMocks };
});

vi.mock('../../src/services/integration-accept.service.js', () => integrationAcceptMocks);

vi.mock('../../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/email.service.js')>(
    '../../src/services/email.service.js',
  );
  return { ...actual, ...emailMocks };
});

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
    integrationAcceptMocks.acceptIntegrationRequest.mockReset();
    integrationAcceptMocks.resendIntegrationClaim.mockReset();
    emailMocks.sendIntegrationApprovedEmail.mockReset().mockResolvedValue(undefined);
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

  it('declines a pending request', async () => {
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

  it('accepts a pending request and emails the claim link', async () => {
    integrationAcceptMocks.acceptIntegrationRequest.mockResolvedValue({
      integration: row({
        status: 'ACCEPTED',
        reviewedAt: new Date('2026-04-22T12:00:00Z'),
        reviewedByEmail: 'admin@example.com',
        clientDomainId: 'cd-1',
      }),
      clientDomainId: 'cd-1',
      clientHash: 'abcd'.repeat(16),
      hashPrefix: 'abcdabcdabcd',
      rawClientSecret: 'raw-secret-long-enough-to-pass-min',
      claim: {
        rawToken: 'raw-claim-token-abc',
        tokenHash: 'hash-abc',
        expiresAt: new Date('2026-04-23T12:00:00Z'),
      },
    });
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com';

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/accept',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { label: 'Client Inc' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ACCEPTED',
        reviewed_by_email: 'admin@example.com',
        client_domain_id: 'cd-1',
      });
      expect(integrationAcceptMocks.acceptIntegrationRequest).toHaveBeenCalledWith({
        id: 'req-1',
        reviewerEmail: 'admin@example.com',
        label: 'Client Inc',
        clientSecret: undefined,
      });
      // Email dispatch is fire-and-forget; let microtasks flush.
      await new Promise((r) => setImmediate(r));
      expect(emailMocks.sendIntegrationApprovedEmail).toHaveBeenCalledWith({
        to: 'ops@client.example.com',
        link: 'https://auth.example.com/integrations/claim/raw-claim-token-abc',
        domain: 'client.example.com',
      });
    } finally {
      await app.close();
      Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    }
  });

  it('accepts with deliveryMode=reveal and returns credentials without sending email', async () => {
    integrationAcceptMocks.acceptIntegrationRequest.mockResolvedValue({
      integration: row({
        status: 'ACCEPTED',
        reviewedAt: new Date('2026-04-22T12:00:00Z'),
        reviewedByEmail: 'admin@example.com',
        clientDomainId: 'cd-1',
      }),
      clientDomainId: 'cd-1',
      clientHash: 'abcd'.repeat(16),
      hashPrefix: 'abcdabcdabcd',
      rawClientSecret: 'raw-secret-long-enough-to-pass-min',
      claim: {
        rawToken: 'raw-claim-token-abc',
        tokenHash: 'hash-abc',
        expiresAt: new Date('2026-04-23T12:00:00Z'),
      },
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/accept',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { deliveryMode: 'reveal' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ACCEPTED',
        delivery_mode: 'reveal',
        email_dispatched: false,
        credentials: {
          domain: 'client.example.com',
          client_secret: 'raw-secret-long-enough-to-pass-min',
          client_hash: 'abcd'.repeat(16),
          hash_prefix: 'abcdabcdabcd',
        },
      });
      await new Promise((r) => setImmediate(r));
      expect(emailMocks.sendIntegrationApprovedEmail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects accept with a client secret shorter than 32 chars', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/accept',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { clientSecret: 'too-short' },
      });

      expect(res.statusCode).toBe(400);
      expect(integrationAcceptMocks.acceptIntegrationRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resends a claim link', async () => {
    integrationAcceptMocks.resendIntegrationClaim.mockResolvedValue({
      integration: row({
        status: 'ACCEPTED',
        reviewedByEmail: 'admin@example.com',
        clientDomainId: 'cd-1',
      }),
      claim: {
        rawToken: 'fresh-claim-token',
        tokenHash: 'hash-fresh',
        expiresAt: new Date('2026-04-23T12:00:00Z'),
      },
      clientHash: 'aaaa'.repeat(16),
      hashPrefix: 'aaaaaaaaaaaa',
      rawClientSecret: 'resent-secret-long-enough-to-pass-min',
    });
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com/';

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/resend-claim',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(res.statusCode).toBe(200);
      expect(integrationAcceptMocks.resendIntegrationClaim).toHaveBeenCalledWith({
        id: 'req-1',
        actorEmail: 'admin@example.com',
      });
      await new Promise((r) => setImmediate(r));
      expect(emailMocks.sendIntegrationApprovedEmail).toHaveBeenCalledWith({
        to: 'ops@client.example.com',
        link: 'https://auth.example.com/integrations/claim/fresh-claim-token',
        domain: 'client.example.com',
      });
    } finally {
      await app.close();
      Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    }
  });

  it('resends with deliveryMode=reveal and returns credentials without sending email', async () => {
    integrationAcceptMocks.resendIntegrationClaim.mockResolvedValue({
      integration: row({
        status: 'ACCEPTED',
        reviewedByEmail: 'admin@example.com',
        clientDomainId: 'cd-1',
      }),
      claim: {
        rawToken: 'fresh-claim-token',
        tokenHash: 'hash-fresh',
        expiresAt: new Date('2026-04-23T12:00:00Z'),
      },
      clientHash: 'beef'.repeat(16),
      hashPrefix: 'beefbeefbeef',
      rawClientSecret: 'resent-secret-long-enough-to-pass-min',
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/integration-requests/req-1/resend-claim',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { deliveryMode: 'reveal' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ACCEPTED',
        delivery_mode: 'reveal',
        email_dispatched: false,
        credentials: {
          domain: 'client.example.com',
          client_secret: 'resent-secret-long-enough-to-pass-min',
          client_hash: 'beef'.repeat(16),
          hash_prefix: 'beefbeefbeef',
        },
      });
      await new Promise((r) => setImmediate(r));
      expect(emailMocks.sendIntegrationApprovedEmail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('deletes a declined request', async () => {
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
      expect(integrationRequestMocks.deleteIntegrationRequest).toHaveBeenCalledWith({
        id: 'req-1',
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });
});
