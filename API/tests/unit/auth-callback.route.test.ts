import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JWTPayload } from 'jose';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const fetchConfigJwtFromUrlMock = vi.fn();
const verifyConfigJwtSignatureMock = vi.fn();
const validateConfigFieldsMock = vi.fn();
const assertConfigDomainMatchesConfigUrlMock = vi.fn();
const adminConfigUrlMock = vi.fn();
const readAdminConfigJwtMock = vi.fn();

const assertSocialProviderAllowedMock = vi.fn();
const getGoogleProfileFromCodeMock = vi.fn();
const verifySocialStateMock = vi.fn();
const loginWithSocialProfileMock = vi.fn();

const selectRedirectUrlMock = vi.fn();
const issueAuthorizationCodeMock = vi.fn();
const buildRedirectToUrlMock = vi.fn();

vi.mock('../../src/services/config.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/config.service.js')>(
    '../../src/services/config.service.js',
  );

  return {
    ...actual,
    fetchConfigJwtFromUrl: (...args: unknown[]) => fetchConfigJwtFromUrlMock(...args),
    verifyConfigJwtSignature: (...args: unknown[]) => verifyConfigJwtSignatureMock(...args),
    validateConfigFields: (...args: unknown[]) => validateConfigFieldsMock(...args),
    assertConfigDomainMatchesConfigUrl: (...args: unknown[]) =>
      assertConfigDomainMatchesConfigUrlMock(...args),
  };
});

vi.mock('../../src/services/admin-auth-config.service.js', () => {
  return {
    adminConfigUrl: (...args: unknown[]) => adminConfigUrlMock(...args),
    readAdminConfigJwt: (...args: unknown[]) => readAdminConfigJwtMock(...args),
  };
});

vi.mock('../../src/services/social/index.js', () => {
  return {
    assertSocialProviderAllowed: (...args: unknown[]) => assertSocialProviderAllowedMock(...args),
  };
});

vi.mock('../../src/services/social/google.service.js', () => {
  return {
    getGoogleProfileFromCode: (...args: unknown[]) => getGoogleProfileFromCodeMock(...args),
  };
});

vi.mock('../../src/services/social/social-state.service.js', () => {
  return {
    verifySocialState: (...args: unknown[]) => verifySocialStateMock(...args),
  };
});

vi.mock('../../src/services/social/social-login.service.js', () => {
  return {
    loginWithSocialProfile: (...args: unknown[]) => loginWithSocialProfileMock(...args),
  };
});

vi.mock('../../src/services/token.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/token.service.js')>(
    '../../src/services/token.service.js',
  );

  return {
    ...actual,
    selectRedirectUrl: (...args: unknown[]) => selectRedirectUrlMock(...args),
    issueAuthorizationCode: (...args: unknown[]) => issueAuthorizationCodeMock(...args),
    buildRedirectToUrl: (...args: unknown[]) => buildRedirectToUrlMock(...args),
  };
});

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['google'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  };
}

describe('GET /auth/callback/:provider', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    delete process.env.DATABASE_URL;

    fetchConfigJwtFromUrlMock.mockReset();
    verifyConfigJwtSignatureMock.mockReset();
    validateConfigFieldsMock.mockReset();
    assertConfigDomainMatchesConfigUrlMock.mockReset();
    adminConfigUrlMock.mockReset();
    readAdminConfigJwtMock.mockReset();
    assertSocialProviderAllowedMock.mockReset();
    getGoogleProfileFromCodeMock.mockReset();
    verifySocialStateMock.mockReset();
    loginWithSocialProfileMock.mockReset();
    selectRedirectUrlMock.mockReset();
    issueAuthorizationCodeMock.mockReset();
    buildRedirectToUrlMock.mockReset();

    fetchConfigJwtFromUrlMock.mockResolvedValue('config-jwt');
    verifyConfigJwtSignatureMock.mockResolvedValue({} as JWTPayload);
    adminConfigUrlMock.mockReturnValue('https://admin.example.com/internal/admin/config');
    readAdminConfigJwtMock.mockReturnValue('admin-config-jwt');
    validateConfigFieldsMock.mockReturnValue(
      baseConfig({
        allowed_registration_domains: ['company.com'],
      }),
    );
    verifySocialStateMock.mockResolvedValue({
      provider: 'google',
      config_url: 'https://client.example.com/auth-config',
      redirect_url: 'https://client.example.com/oauth/callback',
    });
    selectRedirectUrlMock.mockReturnValue('https://client.example.com/oauth/callback');
    getGoogleProfileFromCodeMock.mockResolvedValue({
      provider: 'google',
      email: 'user@gmail.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });
    loginWithSocialProfileMock.mockResolvedValue({ status: 'blocked' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects with generic auth_failed when social registration is blocked by domain policy', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback/google?code=provider-code&state=state-token',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.example.com/oauth/callback?error=auth_failed');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    expect(verifyConfigJwtSignatureMock).toHaveBeenCalledWith(
      'config-jwt',
      'https://auth.example.com/.well-known/jwks.json',
      'uoa-auth-service',
    );
    expect(loginWithSocialProfileMock).toHaveBeenCalledTimes(1);
    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('uses the exact first-party admin config URL locally during social callback', async () => {
    verifySocialStateMock.mockResolvedValue({
      provider: 'google',
      config_url: 'https://admin.example.com/internal/admin/config',
      redirect_url: 'https://admin.example.com/admin/auth/callback',
    });
    validateConfigFieldsMock.mockReturnValue(
      baseConfig({
        domain: 'admin.example.com',
        redirect_urls: ['https://admin.example.com/admin/auth/callback'],
        allowed_social_providers: ['google'],
        allow_registration: false,
      }),
    );
    selectRedirectUrlMock.mockReturnValue('https://admin.example.com/admin/auth/callback');

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback/google?code=provider-code&state=state-token',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://admin.example.com/admin/auth/callback?error=auth_failed');
    expect(fetchConfigJwtFromUrlMock).not.toHaveBeenCalled();
    expect(readAdminConfigJwtMock).toHaveBeenCalledTimes(1);
    expect(verifyConfigJwtSignatureMock).toHaveBeenCalledWith(
      'admin-config-jwt',
      'https://auth.example.com/.well-known/jwks.json',
      'uoa-auth-service',
    );

    await app.close();
  });
});
