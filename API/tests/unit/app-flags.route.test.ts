import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const flagService = vi.hoisted(() => ({
  getResolvedAppFeatureFlags: vi.fn(),
}));
const domainSecretService = vi.hoisted(() => ({
  verifyDomainAuthToken: vi.fn(),
}));

vi.mock('../../src/services/feature-flag-resolution.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/feature-flag-resolution.service.js')
  >('../../src/services/feature-flag-resolution.service.js');
  return { ...actual, ...flagService };
});
vi.mock('../../src/services/domain-secret.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/domain-secret.service.js')
  >('../../src/services/domain-secret.service.js');
  return { ...actual, ...domainSecretService };
});

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalSharedSecret === undefined) {
    Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  } else {
    process.env.SHARED_SECRET = originalSharedSecret;
  }
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  domainSecretService.verifyDomainAuthToken.mockResolvedValue({
    clientId: 'a'.repeat(64),
    clientDomainId: 'client_domain_water',
    domain: 'app.deepwater.example',
    hashPrefix: 'a'.repeat(12),
  });
  flagService.getResolvedAppFeatureFlags.mockResolvedValue({
    can_be_private: true,
    show_beta: false,
  });
});

describe('backend app feature flags route', () => {
  it('uses the domain-hash credential and forwards exact app/user/team context', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url:
          '/apps/app_water/flags?' +
          new URLSearchParams({
            domain: 'app.deepwater.example',
            userId: 'user_1',
            teamId: 'team_1',
          }),
        headers: {
          authorization: `Bearer ${'a'.repeat(64)}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({
        can_be_private: true,
        show_beta: false,
      });
      expect(domainSecretService.verifyDomainAuthToken).toHaveBeenCalledWith({
        domain: 'app.deepwater.example',
        token: 'a'.repeat(64),
      });
      expect(flagService.getResolvedAppFeatureFlags.mock.calls[0]?.[0]).toEqual({
        appId: 'app_water',
        domain: 'app.deepwater.example',
        userId: 'user_1',
        teamId: 'team_1',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects requests without the backend domain-hash credential', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url:
          '/apps/app_water/flags?' +
          new URLSearchParams({
            domain: 'app.deepwater.example',
            userId: 'user_1',
            teamId: 'team_1',
          }),
      });

      expect(response.statusCode).toBe(401);
      expect(flagService.getResolvedAppFeatureFlags).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
