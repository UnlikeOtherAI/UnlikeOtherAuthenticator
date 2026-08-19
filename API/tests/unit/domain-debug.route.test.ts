import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessTokenClaims } from '../../src/services/access-token.service.js';

// The raw 64-hex domain-hash bearer exactly as presented in Authorization — the value
// verifyDomainAuthToken returns as clientId. The response must never echo it.
const LIVE_DOMAIN_HASH_BEARER = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const claims: AccessTokenClaims = {
  userId: 'user-1',
  tokenVersion: 0,
  email: 'super@example.com',
  domain: 'client.example.com',
  clientId: LIVE_DOMAIN_HASH_BEARER,
  role: 'superuser',
};

vi.mock('../../src/middleware/domain-hash-auth.js', () => ({
  requireDomainHashAuthForDomainQuery: async (request: {
    domainAuthClientId?: string;
    domainAuthClientDomainId?: string;
  }): Promise<void> => {
    request.domainAuthClientId = LIVE_DOMAIN_HASH_BEARER;
    request.domainAuthClientDomainId = 'cd_row123';
  },
}));

vi.mock('../../src/middleware/superuser-access-token.js', () => ({
  requireSuperuserAccessTokenForDomainQuery: async (request: {
    accessTokenClaims?: AccessTokenClaims;
  }): Promise<void> => {
    request.accessTokenClaims = claims;
  },
}));

vi.mock('../../src/utils/avatar-url.js', () => ({
  avatarImageBaseUrl: () => 'https://auth.example.com',
  domainAvatarImageUrl: () => 'https://auth.example.com/domain/client.example.com/users/user-1/avatar',
}));

async function getDomainDebug() {
  const { registerDomainDebugRoute } = await import('../../src/routes/domain/debug.js');
  const app = fastify();
  registerDomainDebugRoute(app);
  await app.ready();
  try {
    return await app.inject({
      method: 'GET',
      url: '/domain/debug?domain=client.example.com',
      headers: { 'x-uoa-access-token': 'Bearer access-token' },
    });
  } finally {
    await app.close();
  }
}

describe('GET /domain/debug credential handling', () => {
  it('names the calling backend by its client-domain row id, never by the bearer', async () => {
    const response = await getDomainDebug();

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.client_id).toBe('cd_row123');
    expect(JSON.stringify(body)).not.toContain(LIVE_DOMAIN_HASH_BEARER);
  });

  it('marks the credential-bearing reply non-cacheable like /internal/admin/token', async () => {
    const response = await getDomainDebug();

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['pragma']).toBe('no-cache');
  });
});
