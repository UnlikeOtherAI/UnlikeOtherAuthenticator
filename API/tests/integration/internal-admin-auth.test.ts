import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';
import { baseClientConfigPayload, signTestConfigJwt } from '../helpers/test-config.js';

const sharedSecret = 'test-shared-secret-with-enough-length';
const adminSecret = 'test-admin-token-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

let app: Awaited<ReturnType<typeof createApp>> | null = null;
let originalSharedSecret: string | undefined;
let originalIdentifier: string | undefined;
let originalAdminDomain: string | undefined;
let originalAdminTokenSecret: string | undefined;
let originalAdminConfigJwt: string | undefined;
let originalConfigJwksUrl: string | undefined;
let originalDatabaseUrl: string | undefined;
let originalPublicBaseUrl: string | undefined;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function accessToken(role: 'superuser' | 'user', domain = adminDomain): Promise<string> {
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
    .sign(new TextEncoder().encode(adminSecret));
}

describe('internal admin auth', () => {
  beforeEach(async () => {
    originalSharedSecret = process.env.SHARED_SECRET;
    originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
    originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
    originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
    originalAdminConfigJwt = process.env.ADMIN_CONFIG_JWT;
    originalConfigJwksUrl = process.env.CONFIG_JWKS_URL;
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.PUBLIC_BASE_URL = `https://${adminDomain}`;
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');

    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('ADMIN_CONFIG_JWT', originalAdminConfigJwt);
    restoreEnv('CONFIG_JWKS_URL', originalConfigJwksUrl);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('PUBLIC_BASE_URL', originalPublicBaseUrl);
  });

  it('accepts superuser tokens for the configured admin domain', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/internal/admin/session',
      headers: { authorization: `Bearer ${await accessToken('superuser')}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      adminUser: { email: 'admin@example.com', domain: adminDomain, role: 'superuser' },
    });
  });

  it('rejects superuser tokens from customer domains', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/internal/admin/session',
      headers: { authorization: `Bearer ${await accessToken('superuser', 'customer.example.com')}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects non-superuser tokens', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/internal/admin/session',
      headers: { authorization: `Bearer ${await accessToken('user')}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it('serves the signed Google-only admin config JWT', async () => {
    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        domain: adminDomain,
        redirect_urls: [`https://${adminDomain}/admin/auth/callback`],
        enabled_auth_methods: ['google'],
        allowed_social_providers: ['google'],
        allow_registration: false,
      }),
      { audience: issuer },
    );
    process.env.ADMIN_CONFIG_JWT = configJwt;

    const response = await app!.inject({
      method: 'GET',
      url: '/internal/admin/config',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe(configJwt);
  });
});
