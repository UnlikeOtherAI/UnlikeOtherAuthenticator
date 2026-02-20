import { describe, expect, it, vi } from 'vitest';
import type { DomainRole } from '@prisma/client';

import { loginWithSocialProfile } from '../../src/services/social/social-login.service.js';
import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

describe('social-login.service', () => {
  it('rejects unverified provider emails', async () => {
    const config: ClientConfig = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: true,
      '2fa_enabled': false,
      debug_enabled: false,
      allowed_social_providers: ['google'],
    };

    await expect(
      loginWithSocialProfile({
        profile: {
          provider: 'google',
          email: 'user@example.com',
          emailVerified: false,
          name: 'User',
          avatarUrl: null,
        },
        config,
      }),
    ).rejects.toThrow(/SOCIAL_EMAIL_NOT_VERIFIED/);
  });

  it('creates a new user and overwrites avatar on subsequent logins', async () => {
    type StoredUser = {
      id: string;
      email: string;
      userKey: string;
      domain: string | null;
      name: string | null;
      avatarUrl: string | null;
      passwordHash: string | null;
      twoFaEnabled?: boolean;
    };

    const users = new Map<
      string,
      StoredUser
    >();

    const prisma = {
      user: {
        async findUnique(args: {
          where: { userKey: string };
          select: { id: true };
        }): Promise<{ id: string } | null> {
          const row = users.get(args.where.userKey);
          if (!row) return null;
          return { id: row.id };
        },
        async create(args: {
          data: Omit<StoredUser, 'id'>;
          select: { id: true; twoFaEnabled: true };
        }): Promise<{ id: string; twoFaEnabled: boolean }> {
          const id = `user_${users.size + 1}`;
          users.set(args.data.userKey, { id, ...args.data, twoFaEnabled: false });
          return { id, twoFaEnabled: false };
        },
        async update(args: {
          where: { userKey: string };
          data: Pick<StoredUser, 'email' | 'domain' | 'name' | 'avatarUrl'>;
          select: { id: true; twoFaEnabled: true };
        }): Promise<{ id: string; twoFaEnabled: boolean }> {
          const row = users.get(args.where.userKey);
          if (!row) throw new Error('missing');
          const next: StoredUser = { ...row, ...args.data };
          users.set(args.where.userKey, next);
          return { id: next.id, twoFaEnabled: Boolean(next.twoFaEnabled) };
        },
      },
    };

    const ensureDomainRoleForUser = vi.fn(async () => {
      return {
        domain: 'client.example.com',
        userId: 'user_1',
        role: 'USER',
        createdAt: new Date(),
      } as DomainRole;
    });

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: true,
      '2fa_enabled': false,
      debug_enabled: false,
      allowed_social_providers: ['google'],
    };

    const first = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'user@example.com',
          emailVerified: true,
          name: 'User',
          avatarUrl: 'https://example.com/a.png',
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser },
    );

    expect(first).toEqual({
      status: 'authenticated',
      userId: 'user_1',
      twoFaEnabled: false,
    });
    expect(ensureDomainRoleForUser).toHaveBeenCalledTimes(1);

    const second = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'user@example.com',
          emailVerified: true,
          name: 'User',
          avatarUrl: 'https://example.com/b.png',
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser },
    );

    expect(second).toEqual({
      status: 'authenticated',
      userId: 'user_1',
      twoFaEnabled: false,
    });
    const stored = users.get('user@example.com');
    expect(stored?.avatarUrl).toBe('https://example.com/b.png');
  });

  it('blocks new social users whose email domain is not allowed', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          return { id: 'user_1', twoFaEnabled: false };
        }),
        update: vi.fn(),
      },
    };

    const ensureDomainRoleForUser = vi.fn();

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: true,
      allowed_registration_domains: ['company.com'],
      '2fa_enabled': false,
      debug_enabled: false,
      allowed_social_providers: ['google'],
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'user@gmail.com',
          emailVerified: true,
          name: 'User',
          avatarUrl: null,
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser },
    );

    expect(result).toEqual({ status: 'blocked' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(ensureDomainRoleForUser).not.toHaveBeenCalled();
  });

  it('allows existing social users even when their email domain is not allowed for new registration', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn(async () => ({ id: 'user_1' })),
        create: vi.fn(),
        update: vi.fn(async () => {
          return { id: 'user_1', twoFaEnabled: false };
        }),
      },
    };

    const ensureDomainRoleForUser = vi.fn(async () => {
      return {
        domain: 'client.example.com',
        userId: 'user_1',
        role: 'USER',
        createdAt: new Date(),
      } as DomainRole;
    });

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: true,
      allowed_registration_domains: ['company.com'],
      '2fa_enabled': false,
      debug_enabled: false,
      allowed_social_providers: ['google'],
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'user@gmail.com',
          emailVerified: true,
          name: 'User',
          avatarUrl: 'https://example.com/b.png',
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser },
    );

    expect(result).toEqual({
      status: 'authenticated',
      userId: 'user_1',
      twoFaEnabled: false,
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(ensureDomainRoleForUser).toHaveBeenCalledTimes(1);
  });
});
