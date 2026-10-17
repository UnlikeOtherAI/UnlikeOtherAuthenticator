import { describe, expect, it, vi } from 'vitest';
import type { DomainRole } from '@prisma/client';

import { loginWithSocialProfile } from '../../src/services/social/social-login.service.js';
import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

describe('social-login admin bootstrap', () => {
  it('bootstraps the first superuser on the admin domain even when registration is disabled', async () => {
    const prisma = {
      externalIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
      organisationEmailDomain: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          return { id: 'user_1', twoFaEnabled: false };
        }),
        update: vi.fn(),
      },
      domainRole: {
        // No SUPERUSER exists yet for the admin domain → this login bootstraps it.
        findFirst: vi.fn(async () => null),
      },
    };

    const ensureDomainRoleForUser = vi.fn(async () => {
      return {
        domain: 'auth.example.com',
        userId: 'user_1',
        role: 'SUPERUSER',
        createdAt: new Date(),
      } as DomainRole;
    });
    const placeUserInConfiguredOrganisation = vi.fn(async () => {
      return { status: 'skipped', reason: 'mapping_not_found' } as const;
    });

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      ADMIN_AUTH_DOMAIN: 'auth.example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test-shared-secret-with-enough-length',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'auth.example.com',
      redirect_urls: ['https://auth.example.com/admin/auth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: false,
      '2fa_enabled': false,
      debug_enabled: false,
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'founder@example.com',
          emailVerified: true,
          name: 'Founder',
          avatarUrl: null,
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser, placeUserInConfiguredOrganisation },
    );

    expect(result).toEqual({
      status: 'authenticated',
      userId: 'user_1',
      twoFaEnabled: false,
    });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.domainRole.findFirst).toHaveBeenCalledTimes(1);
    expect(ensureDomainRoleForUser).toHaveBeenCalledTimes(1);
  });

  it('bootstraps the first admin superuser when the email is on the optional allowlist', async () => {
    const prisma = {
      externalIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
      organisationEmailDomain: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          return { id: 'user_1', twoFaEnabled: false };
        }),
        update: vi.fn(),
      },
      domainRole: {
        findFirst: vi.fn(async () => null),
      },
    };

    const ensureDomainRoleForUser = vi.fn(async () => {
      return {
        domain: 'auth.example.com',
        userId: 'user_1',
        role: 'SUPERUSER',
        createdAt: new Date(),
      } as DomainRole;
    });
    const placeUserInConfiguredOrganisation = vi.fn(async () => {
      return { status: 'skipped', reason: 'mapping_not_found' } as const;
    });

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      ADMIN_AUTH_DOMAIN: 'auth.example.com',
      ADMIN_BOOTSTRAP_EMAILS: 'Founder@Example.com, ops@example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test-shared-secret-with-enough-length',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'auth.example.com',
      redirect_urls: ['https://auth.example.com/admin/auth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: false,
      '2fa_enabled': false,
      debug_enabled: false,
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'founder@example.com',
          emailVerified: true,
          name: 'Founder',
          avatarUrl: null,
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser, placeUserInConfiguredOrganisation },
    );

    expect(result).toEqual({ status: 'authenticated', userId: 'user_1', twoFaEnabled: false });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('blocks the first admin-domain login when its email is not on the optional allowlist', async () => {
    const prisma = {
      externalIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
      organisationEmailDomain: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(),
      },
      domainRole: {
        // No superuser yet, but the allowlist excludes this email, so the
        // bootstrap exception does not apply and registration stays disabled.
        findFirst: vi.fn(async () => null),
      },
    };

    const ensureDomainRoleForUser = vi.fn();
    const placeUserInConfiguredOrganisation = vi.fn();

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      ADMIN_AUTH_DOMAIN: 'auth.example.com',
      ADMIN_BOOTSTRAP_EMAILS: 'founder@example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test-shared-secret-with-enough-length',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'auth.example.com',
      redirect_urls: ['https://auth.example.com/admin/auth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: false,
      '2fa_enabled': false,
      debug_enabled: false,
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'intruder@example.com',
          emailVerified: true,
          name: 'Intruder',
          avatarUrl: null,
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser, placeUserInConfiguredOrganisation },
    );

    expect(result).toEqual({ status: 'blocked' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(ensureDomainRoleForUser).not.toHaveBeenCalled();
  });

  it('blocks new admin-domain users once a superuser already exists, with registration disabled', async () => {
    const prisma = {
      externalIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
      organisationEmailDomain: { findFirst: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(),
      },
      domainRole: {
        // A SUPERUSER already exists → bootstrap exception no longer applies.
        findFirst: vi.fn(async () => ({ userId: 'existing-superuser' })),
      },
    };

    const ensureDomainRoleForUser = vi.fn();
    const placeUserInConfiguredOrganisation = vi.fn();

    const env: Env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      ADMIN_AUTH_DOMAIN: 'auth.example.com',
      LOG_LEVEL: 'info',
      SHARED_SECRET: 'test-shared-secret-with-enough-length',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      DATABASE_URL: 'postgres://example.invalid/db',
      ACCESS_TOKEN_TTL: '30m',
      LOG_RETENTION_DAYS: 90,
    };

    const config: ClientConfig = {
      domain: 'auth.example.com',
      redirect_urls: ['https://auth.example.com/admin/auth/callback'],
      enabled_auth_methods: ['google'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      allow_registration: false,
      '2fa_enabled': false,
      debug_enabled: false,
    };

    const result = await loginWithSocialProfile(
      {
        profile: {
          provider: 'google',
          email: 'latecomer@example.com',
          emailVerified: true,
          name: 'Latecomer',
          avatarUrl: null,
        },
        config,
      },
      { env, prisma, ensureDomainRoleForUser, placeUserInConfiguredOrganisation },
    );

    expect(result).toEqual({ status: 'blocked' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(ensureDomainRoleForUser).not.toHaveBeenCalled();
    expect(placeUserInConfiguredOrganisation).not.toHaveBeenCalled();
  });
});
