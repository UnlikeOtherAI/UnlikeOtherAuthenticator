import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

// Flag/kill-switch + apps-list services (the routes guarded by the combined key-or-JWT guard).
const appsService = vi.hoisted(() => ({
  getAdminApps: vi.fn(),
  createAdminApp: vi.fn(),
  createAdminFeatureFlag: vi.fn(),
  updateAdminFeatureFlag: vi.fn(),
  deleteAdminFeatureFlag: vi.fn(),
  createAdminKillSwitch: vi.fn(),
  updateAdminKillSwitch: vi.fn(),
  deleteAdminKillSwitch: vi.fn(),
}));

// Admin-API-key service: verify (auth path) + management routes.
const apiKeyService = vi.hoisted(() => ({
  verifyAdminApiKey: vi.fn(),
  createAdminApiKey: vi.fn(),
  listAdminApiKeys: vi.fn(),
  revokeAdminApiKey: vi.fn(),
}));

vi.mock('../../src/services/internal-admin.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/internal-admin.service.js')>(
    '../../src/services/internal-admin.service.js',
  );
  return { ...actual, ...appsService };
});

vi.mock('../../src/services/admin-api-key.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/admin-api-key.service.js')>(
    '../../src/services/admin-api-key.service.js',
  );
  return { ...actual, ...apiKeyService };
});

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
    tv: 0,
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

const VALID_KEY = 'uoa_ak_validkeymaterial';

describe('/internal/admin api-key auth', () => {
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
    apiKeyService.verifyAdminApiKey.mockResolvedValue({ id: 'key_1' });
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
  });

  async function withApp<T>(fn: (app: Awaited<ReturnType<typeof import('../../src/app.js')['createApp']>>) => Promise<T>): Promise<T> {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  }

  it('allows an API key to GET /internal/admin/apps via X-API-Key', async () => {
    appsService.getAdminApps.mockResolvedValue([{ id: 'app_1' }]);
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/apps',
        headers: { 'x-api-key': VALID_KEY },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ id: 'app_1' }]);
      expect(apiKeyService.verifyAdminApiKey).toHaveBeenCalledWith(VALID_KEY);
    });
  });

  it('allows an API key to POST a feature flag', async () => {
    appsService.createAdminFeatureFlag.mockResolvedValue({ id: 'app_1' });
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/apps/app_1/flags',
        headers: { 'x-api-key': VALID_KEY },
        payload: { key: 'beta', default_state: false },
      });
      expect(res.statusCode).toBe(200);
      expect(appsService.createAdminFeatureFlag).toHaveBeenCalled();
    });
  });

  it('allows an API key to PATCH a kill switch', async () => {
    appsService.updateAdminKillSwitch.mockResolvedValue({ id: 'app_1' });
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/internal/admin/apps/app_1/kill-switches/ks_1',
        headers: { 'x-api-key': VALID_KEY },
        payload: {
          platform: 'ios',
          type: 'soft',
          version_field: 'versionName',
          operator: 'lt',
          version_value: '1.0.0',
          version_scheme: 'semver',
          active: true,
          priority: 10,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(appsService.updateAdminKillSwitch).toHaveBeenCalled();
    });
  });

  it('accepts an API key via Authorization: Bearer uoa_ak_…', async () => {
    appsService.getAdminApps.mockResolvedValue([]);
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/apps',
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(apiKeyService.verifyAdminApiKey).toHaveBeenCalledWith(VALID_KEY);
    });
  });

  it('rejects an invalid API key with 401 and does NOT fall back to JWT', async () => {
    const { AppError } = await import('../../src/utils/errors.js');
    apiKeyService.verifyAdminApiKey.mockRejectedValue(new AppError('UNAUTHORIZED', 401));
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/apps',
        // A valid superuser JWT is ALSO present — must be ignored once a key credential exists.
        headers: { 'x-api-key': 'uoa_ak_revoked', authorization: `Bearer ${await accessToken('superuser')}` },
      });
      expect(res.statusCode).toBe(401);
      expect(appsService.getAdminApps).not.toHaveBeenCalled();
    });
  });

  it('rejects a duplicated X-API-Key header with 401', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/apps',
        headers: { 'x-api-key': ['uoa_ak_one', 'uoa_ak_two'] },
      });
      expect(res.statusCode).toBe(401);
      expect(apiKeyService.verifyAdminApiKey).not.toHaveBeenCalled();
    });
  });

  it('lets an API key NOT create apps (POST /internal/admin/apps stays superuser-only)', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/apps',
        headers: { 'x-api-key': VALID_KEY },
        payload: { name: 'x', identifier: 'x', platform: 'ios', domain: 'a.example.com', org_id: 'org_1' },
      });
      // No JWT, key credential ignored by superuser guard ⇒ missing access token ⇒ 401.
      expect(res.statusCode).toBe(401);
      expect(appsService.createAdminApp).not.toHaveBeenCalled();
    });
  });

  it('lets an API key NOT manage api-keys (POST /internal/admin/api-keys stays superuser-only)', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/api-keys',
        headers: { 'x-api-key': VALID_KEY },
        payload: { name: 'ci' },
      });
      expect(res.statusCode).toBe(401);
      expect(apiKeyService.createAdminApiKey).not.toHaveBeenCalled();
    });
  });

  it('still lets a superuser JWT use the flag route (regression)', async () => {
    appsService.createAdminFeatureFlag.mockResolvedValue({ id: 'app_1' });
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/apps/app_1/flags',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { key: 'beta', default_state: true },
      });
      expect(res.statusCode).toBe(200);
      expect(appsService.createAdminFeatureFlag).toHaveBeenCalled();
    });
  });

  it('mints a key via POST /internal/admin/api-keys (superuser) returning plaintext once', async () => {
    apiKeyService.createAdminApiKey.mockResolvedValue({
      record: {
        id: 'key_1',
        name: 'ci',
        keyPrefix: 'uoa_ak_AbC123',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdByEmail: 'admin@example.com',
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
      },
      plaintext: 'uoa_ak_fullsecret',
    });
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/admin/api-keys',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
        payload: { name: 'ci' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toBe('uoa_ak_fullsecret');
      expect(body.key_prefix).toBe('uoa_ak_AbC123');
      expect(body.id).toBe('key_1');
    });
  });

  it('forbids a non-superuser JWT from managing api-keys', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/admin/api-keys',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
