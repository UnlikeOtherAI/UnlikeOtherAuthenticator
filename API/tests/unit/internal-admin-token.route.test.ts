import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/jwt.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;
let currentConfigUrl = '';
const exchangeAuthorizationCodeForTokensMock = vi.fn();
const adminSecret = 'admin-token-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

vi.mock('../../src/middleware/config-verifier.js', () => {
  return {
    configVerifier: async (request: {
      query?: { config_url?: string };
      configUrl?: string;
      config?: ClientConfig;
    }): Promise<void> => {
      request.configUrl = request.query?.config_url ?? currentConfigUrl;
      request.config = currentConfig ?? undefined;
    },
  };
});

vi.mock('../../src/services/token.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/token.service.js')>(
    '../../src/services/token.service.js',
  );
  return {
    ...actual,
    exchangeAuthorizationCodeForTokens: (...args: unknown[]) =>
      exchangeAuthorizationCodeForTokensMock(...args),
  };
});

function adminConfig(domain = 'admin.example.com'): ClientConfig {
  return {
    domain,
    redirect_urls: ['https://admin.example.com/admin/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
  } as unknown as ClientConfig;
}

async function accessToken(role: 'superuser' | 'user'): Promise<string> {
  return await new SignJWT({
    email: 'admin@example.com',
    domain: adminDomain,
    client_id: `admin:${adminDomain}`,
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe('POST /internal/admin/token', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIdentifier = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAdminDomain = process.env.ADMIN_AUTH_DOMAIN;
  const originalAdminTokenSecret = process.env.ADMIN_ACCESS_TOKEN_SECRET;
  const originalConfigJwksUrl = process.env.CONFIG_JWKS_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    currentConfigUrl = 'https://admin.example.com/auth-config';
    currentConfig = adminConfig();
    exchangeAuthorizationCodeForTokensMock.mockImplementation(async () => ({
      accessToken: await accessToken('superuser'),
      expiresInSeconds: 900,
      refreshToken: 'refresh-token-that-must-not-leak',
      refreshTokenExpiresInSeconds: 3600,
    }));
  });

  afterEach(() => {
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    restoreEnv('AUTH_SERVICE_IDENTIFIER', originalIdentifier);
    restoreEnv('ADMIN_AUTH_DOMAIN', originalAdminDomain);
    restoreEnv('ADMIN_ACCESS_TOKEN_SECRET', originalAdminTokenSecret);
    restoreEnv('CONFIG_JWKS_URL', originalConfigJwksUrl);
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    currentConfig = null;
    currentConfigUrl = '';
    vi.clearAllMocks();
  });

  it('exchanges an admin-domain authorization code without domain-hash auth or refresh-token output', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/admin/token?config_url=${encodeURIComponent(currentConfigUrl)}`,
        payload: {
          code: 'auth-code',
          redirect_url: 'https://admin.example.com/admin/callback',
          code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        expires_in: 900,
        token_type: 'Bearer',
      });
      expect(typeof response.json().access_token).toBe('string');
      expect(exchangeAuthorizationCodeForTokensMock).toHaveBeenCalledWith({
        code: 'auth-code',
        config: currentConfig,
        configUrl: currentConfigUrl,
        redirectUrl: 'https://admin.example.com/admin/callback',
        codeVerifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects token exchange for non-admin config domains', async () => {
    currentConfig = adminConfig('customer.example.com');
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/admin/token?config_url=${encodeURIComponent(currentConfigUrl)}`,
        payload: {
          code: 'auth-code',
          redirect_url: 'https://admin.example.com/admin/callback',
          code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(exchangeAuthorizationCodeForTokensMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects exchanged admin-domain tokens when the user is not a superuser', async () => {
    exchangeAuthorizationCodeForTokensMock.mockImplementationOnce(async () => ({
      accessToken: await accessToken('user'),
      expiresInSeconds: 900,
      refreshToken: 'refresh-token-that-must-not-leak',
      refreshTokenExpiresInSeconds: 3600,
    }));
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/admin/token?config_url=${encodeURIComponent(currentConfigUrl)}`,
        payload: {
          code: 'auth-code',
          redirect_url: 'https://admin.example.com/admin/callback',
          code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
