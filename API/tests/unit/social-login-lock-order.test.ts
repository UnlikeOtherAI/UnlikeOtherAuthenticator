import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { loginWithSocialProfile } from '../../src/services/social/social-login.service.js';
import { testUiTheme } from '../helpers/test-config.js';

describe('social login credential lock order', () => {
  it('takes the callback user lock before updating an existing profile and returns its epoch', async () => {
    let enterLock!: () => void;
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      enterLock = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const update = vi.fn().mockResolvedValue({
      id: 'user-1',
      tokenVersion: 7,
      twoFaEnabled: true,
    });
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }),
        create: vi.fn(),
        update,
      },
      domainRole: { findFirst: vi.fn() },
    };
    const config = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
    } as ClientConfig;

    const login = loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'user@example.com',
          emailVerified: true,
          name: 'User',
          avatarUrl: null,
        },
        config,
      },
      {
        env: parseEnv({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://example.invalid/uoa',
          SHARED_SECRET: 'test-shared-secret-with-enough-length',
        }),
        prisma,
        beforeExistingUserUpdate: async (userId) => {
          expect(userId).toBe('user-1');
          enterLock();
          await lockRelease;
        },
        ensureDomainRoleForUser: vi.fn().mockResolvedValue({ role: 'USER' }),
      },
    );

    await lockEntered;
    expect(update).not.toHaveBeenCalled();
    releaseLock();
    await expect(login).resolves.toEqual({
      status: 'authenticated',
      userId: 'user-1',
      twoFaEnabled: true,
      credentialEpoch: 7,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
