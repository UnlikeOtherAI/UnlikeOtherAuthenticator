import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { AppError } from '../../src/utils/errors.js';

const organisationService = vi.hoisted(() => ({
  deleteOrganisation: vi.fn(),
}));

vi.mock('../../src/services/organisation.service.organisation.js', () => organisationService);

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

describe('DELETE /internal/admin/organisations/:orgId', () => {
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

  it('requires an admin superuser', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/organisations/org-1',
        headers: { authorization: `Bearer ${await accessToken('user')}` },
      });

      expect(response.statusCode).toBe(403);
      expect(organisationService.deleteOrganisation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('deletes in backend-actor mode with verified admin provenance', async () => {
    organisationService.deleteOrganisation.mockResolvedValue({ deleted: true });
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/organisations/org-1',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deleted: true });
      expect(organisationService.deleteOrganisation).toHaveBeenCalledWith({
        orgId: 'org-1',
        actor: {
          via: 'admin_superuser',
          userId: 'admin-user',
          email: 'admin@example.com',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('exposes the named protected-records refusal', async () => {
    organisationService.deleteOrganisation.mockRejectedValue(
      new AppError('BAD_REQUEST', 400, 'ORG_HAS_PROTECTED_RECORDS'),
    );
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/internal/admin/organisations/org-1',
        headers: { authorization: `Bearer ${await accessToken('superuser')}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Request failed',
        code: 'ORG_HAS_PROTECTED_RECORDS',
      });
    } finally {
      await app.close();
    }
  });
});
