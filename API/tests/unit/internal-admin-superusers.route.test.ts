import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';

const service = vi.hoisted(() => ({
  listAdminSuperusers: vi.fn(),
  searchNonSuperusers: vi.fn(),
  grantAdminSuperuser: vi.fn(),
  revokeAdminSuperuser: vi.fn(),
}));

vi.mock('../../src/services/admin-superusers.service.js', () => service);

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
    .setSubject('admin-user')
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

describe('/internal/admin/superusers', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  it('requires admin superuser access', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/superusers',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('lists superusers', async () => {
    service.listAdminSuperusers.mockResolvedValue([{ userId: 'user_1', email: 'a@example.com' }]);
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/superusers',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ userId: 'user_1', email: 'a@example.com' }]);
    } finally {
      await app.close();
    }
  });

  it('grants and revokes superusers', async () => {
    service.grantAdminSuperuser.mockResolvedValue({ userId: 'user_2', email: 'b@example.com' });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const grant = await app.inject({
        method: 'POST',
        url: '/internal/admin/superusers',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { userId: 'user_2' },
      });
      expect(grant.statusCode).toBe(201);
      expect(service.grantAdminSuperuser).toHaveBeenCalledWith('user_2');

      const revoke = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/superusers/user_2',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(revoke.statusCode).toBe(204);
      expect(service.revokeAdminSuperuser).toHaveBeenCalledWith({
        userId: 'user_2',
        actorUserId: 'admin-user',
      });
    } finally {
      await app.close();
    }
  });
});
