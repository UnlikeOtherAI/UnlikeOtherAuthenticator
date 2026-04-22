import { SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../config/jwt.js';
import { requireAdminSuperuser } from '../admin-superuser.js';

const domainRoleFindUnique = vi.hoisted(() => vi.fn());

vi.mock('../../db/prisma.js', () => ({
  getAdminPrisma: () => ({
    domainRole: {
      findUnique: domainRoleFindUnique,
    },
  }),
}));

const sharedSecret = 'test-shared-secret-with-enough-length';
const adminSecret = 'test-admin-token-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

async function accessToken(
  role: 'superuser' | 'user',
  domain = adminDomain,
  secret = adminSecret,
): Promise<string> {
  return await new SignJWT({
    email: 'admin@example.com',
    domain,
    client_id: 'client-id',
    role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user_123')
    .setIssuer(issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(secret));
}

async function accessTokenWithoutSubject(secret = adminSecret): Promise<string> {
  return await new SignJWT({
    email: 'admin@example.com',
    domain: adminDomain,
    client_id: 'client-id',
    role: 'superuser',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(secret));
}

function requestWithToken(token: string | null): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

describe('admin superuser middleware', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    domainRoleFindUnique.mockReset();
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  it('accepts superuser UOA access tokens', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const request = requestWithToken(await accessToken('superuser'));

    await expect(requireAdminSuperuser(request, {} as never)).resolves.toBeUndefined();
    expect(request.adminAccessTokenClaims?.role).toBe('superuser');
  });

  it('defaults the admin domain to the auth service identifier', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    Reflect.deleteProperty(process.env, 'ADMIN_AUTH_DOMAIN');
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const request = requestWithToken(await accessToken('superuser', issuer));

    await expect(requireAdminSuperuser(request, {} as never)).resolves.toBeUndefined();
    expect(request.adminAccessTokenClaims?.domain).toBe(issuer);
  });

  it('requires a DB-backed admin-domain SUPERUSER role when the database is enabled', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    domainRoleFindUnique.mockResolvedValue({ role: 'SUPERUSER' });
    const request = requestWithToken(await accessToken('superuser'));

    await expect(requireAdminSuperuser(request, {} as never)).resolves.toBeUndefined();
    expect(domainRoleFindUnique).toHaveBeenCalledWith({
      where: { domain_userId: { domain: adminDomain, userId: 'user_123' } },
      select: { role: true },
    });
  });

  it('uses a dedicated admin access token secret when configured', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const request = requestWithToken(await accessToken('superuser', adminDomain, adminSecret));

    await expect(requireAdminSuperuser(request, {} as never)).resolves.toBeUndefined();
    await expect(
      requireAdminSuperuser(
        requestWithToken(await accessToken('superuser', adminDomain, sharedSecret)),
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('normalizes the admin domain before checking the DB role row', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = 'Admin.Example.Com.';
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    domainRoleFindUnique.mockResolvedValue({ role: 'SUPERUSER' });
    const request = requestWithToken(await accessToken('superuser', 'ADMIN.EXAMPLE.COM'));

    await expect(requireAdminSuperuser(request, {} as never)).resolves.toBeUndefined();
    expect(domainRoleFindUnique).toHaveBeenCalledWith({
      where: { domain_userId: { domain: adminDomain, userId: 'user_123' } },
      select: { role: true },
    });
  });

  it('rejects DB-backed admin access without a SUPERUSER role row', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    domainRoleFindUnique.mockResolvedValue({ role: 'USER' });
    const request = requestWithToken(await accessToken('superuser'));

    await expect(requireAdminSuperuser(request, {} as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ADMIN_ROLE_NOT_GRANTED',
    });
  });

  it('rejects otherwise valid admin tokens that do not identify a user', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    const request = requestWithToken(await accessTokenWithoutSubject());

    await expect(requireAdminSuperuser(request, {} as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
    expect(domainRoleFindUnique).not.toHaveBeenCalled();
  });

  it('rejects non-superuser access tokens', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const request = requestWithToken(await accessToken('user'));

    await expect(requireAdminSuperuser(request, {} as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('rejects superusers for non-admin domains', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    const request = requestWithToken(await accessToken('superuser', 'customer.example.com'));

    await expect(requireAdminSuperuser(request, {} as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ADMIN_DOMAIN_MISMATCH',
    });
  });

  it('rejects missing bearer tokens', async () => {
    await expect(requireAdminSuperuser(requestWithToken(null), {} as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });
});
