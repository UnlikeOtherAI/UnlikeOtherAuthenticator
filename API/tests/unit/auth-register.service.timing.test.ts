import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { requestRegistrationInstructions } from '../../src/services/auth-register.service.js';
import { testUiTheme } from '../helpers/test-config.js';

// Focused regression coverage for the inline_sign_in + existing-user branch's timing
// budget. auth-register.service.test.ts owns the broad service coverage (its helper
// types/baseConfig/testEnv are copied here unchanged); this file only pins down that
// every exit from requestRegistrationInstructions consumes the same timing shape.
type PrismaStub = {
  user: {
    findUnique: () => Promise<{ id: string; tokenVersion: number } | null>;
  };
  verificationToken: {
    create: () => Promise<{ id: string }>;
  };
};

function testEnv(overrides?: Partial<Env>): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info',
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled',
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    ...overrides,
  };
}

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  };
}

describe('requestRegistrationInstructions: timing budget', () => {
  it('consumes the account-flow timing budget exactly once on the inline_sign_in existing-user exit', async () => {
    const findUnique = vi
      .fn<PrismaStub['user']['findUnique']>()
      .mockResolvedValue({ id: 'u1', tokenVersion: 7 });
    const createToken = vi
      .fn<PrismaStub['verificationToken']['create']>()
      .mockResolvedValue({ id: 't1' });
    const prisma: PrismaStub = {
      user: { findUnique },
      verificationToken: { create: createToken },
    };

    const consumeAccountFlowTimingBudget = vi.fn<() => Promise<void>>(async () => undefined);
    const isPrincipalBannedForRegistration = vi.fn(async () => false);

    const result = await requestRegistrationInstructions(
      {
        email: 'existing@example.com',
        config: baseConfig({ existing_user_registration_behavior: 'inline_sign_in' }),
        configUrl: 'https://client.example.com/auth-config',
      },
      {
        env: testEnv(),
        prisma,
        sharedSecret: 'pepper',
        now: () => new Date('2026-02-10T00:00:00.000Z'),
        generateEmailToken: () => 'token123',
        hashEmailToken: () => 'hash123',
        consumeAccountFlowTimingBudget,
        isPrincipalBannedForRegistration,
      },
    );

    expect(result).toEqual({ status: 'existing_user' });
    expect(consumeAccountFlowTimingBudget).toHaveBeenCalledTimes(1);
    expect(createToken).not.toHaveBeenCalled();
  });
});
