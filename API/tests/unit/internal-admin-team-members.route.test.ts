import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

const membershipService = vi.hoisted(() => ({
  addAdminUserToTeam: vi.fn(),
}));

vi.mock('../../src/services/internal-admin-team-members.service.js', () => membershipService);

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

describe('POST /internal/admin/users/:userId/teams', () => {
  beforeEach(() => {
    vi.stubEnv('SHARED_SECRET', sharedSecret);
    vi.stubEnv('AUTH_SERVICE_IDENTIFIER', issuer);
    vi.stubEnv('ADMIN_AUTH_DOMAIN', adminDomain);
    vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', adminSecret);
    vi.stubEnv('DATABASE_URL', undefined);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function call(role: 'superuser' | 'user' | null, payload: object) {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      return await app.inject({
        method: 'POST',
        url: '/internal/admin/users/user-1/teams',
        headers: role ? { authorization: `Bearer ${await accessToken(role)}` } : {},
        payload,
      });
    } finally {
      await app.close();
    }
  }
  const body = { orgId: 'org-1', teamId: 'team-1', teamRole: 'member' };
  it('requires an authenticated platform superuser', async () => {
    expect((await call(null, body)).statusCode).toBe(401);
    expect((await call('user', body)).statusCode).toBe(403);
    expect(membershipService.addAdminUserToTeam).not.toHaveBeenCalled();
  });
  it('validates input and refuses ownership and caller-supplied actor fields', async () => {
    for (const payload of [
      { ...body, teamRole: 'owner' },
      { ...body, actor: 'someone' },
      { ...body, teamId: '' },
    ]) {
      expect((await call('superuser', payload)).statusCode).toBe(400);
    }
    expect(membershipService.addAdminUserToTeam).not.toHaveBeenCalled();
  });
  it('uses only the verified admin provenance', async () => {
    membershipService.addAdminUserToTeam.mockResolvedValue({ ok: true, userId: 'user-1', ...body });
    const response = await call('superuser', body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, userId: 'user-1', ...body });
    expect(membershipService.addAdminUserToTeam).toHaveBeenCalledWith({
      ...body,
      userId: 'user-1',
      actor: { via: 'admin_superuser', userId: 'admin-user', email: 'admin@example.com' },
    });
  });
});
