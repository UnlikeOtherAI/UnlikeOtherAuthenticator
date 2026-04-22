import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';

const clientJwkMocks = vi.hoisted(() => ({
  listJwksForDomain: vi.fn(),
  addJwkForDomain: vi.fn(),
  deactivateJwk: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

vi.mock('../../src/services/client-jwk.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/client-jwk.service.js')>(
    '../../src/services/client-jwk.service.js',
  );
  return { ...actual, ...clientJwkMocks };
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

function jwkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'jwk-1',
    domainId: 'dom-1',
    kid: 'kid-1',
    jwk: { kty: 'RSA', kid: 'kid-1', n: 'nnn', e: 'AQAB' },
    fingerprint: 'fp-hash',
    active: true,
    createdAt: new Date('2026-04-20T10:00:00Z'),
    deactivatedAt: null,
    createdByEmail: 'admin@example.com',
    ...overrides,
  };
}

describe('/internal/admin/domains/:domain/jwks', () => {
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

    clientJwkMocks.listJwksForDomain.mockReset().mockResolvedValue([]);
    clientJwkMocks.addJwkForDomain.mockReset();
    clientJwkMocks.deactivateJwk.mockReset();
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
        url: '/internal/admin/domains/client.example.com/jwks',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('lists JWKs for a normalized domain', async () => {
    clientJwkMocks.listJwksForDomain.mockResolvedValue([jwkRow()]);

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/domains/Client.Example.COM/jwks',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(clientJwkMocks.listJwksForDomain).toHaveBeenCalledWith('client.example.com');
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ kid: 'kid-1', fingerprint: 'uoa_fp_fp-hash', active: true });
    } finally {
      await app.close();
    }
  });

  it('adds a JWK with the actor email', async () => {
    clientJwkMocks.addJwkForDomain.mockResolvedValue(jwkRow({ kid: 'kid-new' }));

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/domains/client.example.com/jwks',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: {
          jwk: { kty: 'RSA', kid: 'kid-new', n: 'nnn', e: 'AQAB' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(clientJwkMocks.addJwkForDomain).toHaveBeenCalledWith({
        domain: 'client.example.com',
        jwk: { kty: 'RSA', kid: 'kid-new', n: 'nnn', e: 'AQAB' },
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });

  it('deactivates a JWK with the actor email', async () => {
    clientJwkMocks.deactivateJwk.mockResolvedValue(
      jwkRow({ active: false, deactivatedAt: new Date('2026-04-22T13:00:00Z') }),
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/domains/client.example.com/jwks/kid-1',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ kid: 'kid-1', active: false });
      expect(clientJwkMocks.deactivateJwk).toHaveBeenCalledWith({
        domain: 'client.example.com',
        kid: 'kid-1',
        actorEmail: 'admin@example.com',
      });
    } finally {
      await app.close();
    }
  });
});
