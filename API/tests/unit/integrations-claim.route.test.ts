import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claimMocks = vi.hoisted(() => ({
  peekClaim: vi.fn(),
  consumeClaim: vi.fn(),
}));

const integrationRequestMocks = vi.hoisted(() => ({
  getIntegrationRequestById: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/integration-claim.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/integration-claim.service.js')>(
    '../../src/services/integration-claim.service.js',
  );
  return { ...actual, ...claimMocks };
});

vi.mock('../../src/services/integration-request.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/integration-request.service.js')>(
    '../../src/services/integration-request.service.js',
  );
  return { ...actual, ...integrationRequestMocks };
});

vi.mock('../../src/db/prisma.js', () => prismaMocks);

const sharedSecret = 'test-shared-secret-with-enough-length';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('/integrations/claim/:token', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalConfigJwksUrl = process.env.CONFIG_JWKS_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');

    claimMocks.peekClaim.mockReset();
    claimMocks.consumeClaim.mockReset();
    integrationRequestMocks.getIntegrationRequestById.mockReset();
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('CONFIG_JWKS_URL', originalConfigJwksUrl);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  it('GET renders the confirm page for a valid token', async () => {
    claimMocks.peekClaim.mockResolvedValue({
      state: 'valid',
      integrationId: 'req-1',
      expiresAt: new Date('2026-04-23T12:00:00Z'),
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/integrations/claim/abc.def' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('/integrations/claim/abc.def/confirm');
      expect(claimMocks.peekClaim).toHaveBeenCalledWith('abc.def');
    } finally {
      await app.close();
    }
  });

  it('GET renders the invalid page for a missing token', async () => {
    claimMocks.peekClaim.mockResolvedValue({ state: 'missing' });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/integrations/claim/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
      // The confirm URL should NOT be present on the invalid page.
      expect(res.body).not.toContain('/confirm');
    } finally {
      await app.close();
    }
  });

  it('POST /confirm renders the reveal page for a valid token and burns it', async () => {
    claimMocks.consumeClaim.mockResolvedValue({
      state: 'consumed',
      integrationId: 'req-1',
      clientSecret: 'real-plaintext-client-secret-12345678',
      usedAt: new Date('2026-04-22T12:00:00Z'),
    });
    integrationRequestMocks.getIntegrationRequestById.mockResolvedValue({
      id: 'req-1',
      domain: 'client.example.com',
      contactEmail: 'ops@client.example.com',
      status: 'ACCEPTED',
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/integrations/claim/raw-token-abc/confirm',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('real-plaintext-client-secret-12345678');
      expect(res.body).toContain('client.example.com');
      expect(claimMocks.consumeClaim).toHaveBeenCalledWith('raw-token-abc');
      expect(integrationRequestMocks.getIntegrationRequestById).toHaveBeenCalledWith('req-1');
    } finally {
      await app.close();
    }
  });

  it('POST /confirm returns the invalid page when the token is already used', async () => {
    claimMocks.consumeClaim.mockResolvedValue({ state: 'already_used' });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/integrations/claim/raw-token-abc/confirm',
      });
      expect(res.statusCode).toBe(404);
      expect(integrationRequestMocks.getIntegrationRequestById).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('POST /confirm returns the invalid page when the token is expired', async () => {
    claimMocks.consumeClaim.mockResolvedValue({ state: 'expired' });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/integrations/claim/raw-token-abc/confirm',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
