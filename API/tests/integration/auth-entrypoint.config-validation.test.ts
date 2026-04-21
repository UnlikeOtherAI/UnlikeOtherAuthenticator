import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { expectJsonError } from '../helpers/error-response.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

describe('GET /auth (config validation)', () => {
  const originalDebugEnabled = process.env.DEBUG_ENABLED;

  afterEach(() => {
    if (originalDebugEnabled === undefined) {
      delete process.env.DEBUG_ENABLED;
    } else {
      process.env.DEBUG_ENABLED = originalDebugEnabled;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [
      'domain',
      {
        redirect_urls: ['https://client.example.com/oauth/callback'],
        enabled_auth_methods: ['email_password'],
        ui_theme: baseClientConfigPayload().ui_theme,
        language_config: 'en',
      },
    ],
    [
      'redirect_urls',
      {
        domain: 'client.example.com',
        enabled_auth_methods: ['email_password'],
        ui_theme: baseClientConfigPayload().ui_theme,
        language_config: 'en',
      },
    ],
    [
      'enabled_auth_methods',
      {
        domain: 'client.example.com',
        redirect_urls: ['https://client.example.com/oauth/callback'],
        ui_theme: baseClientConfigPayload().ui_theme,
        language_config: 'en',
      },
    ],
    [
      'ui_theme',
      {
        domain: 'client.example.com',
        redirect_urls: ['https://client.example.com/oauth/callback'],
        enabled_auth_methods: ['email_password'],
        language_config: 'en',
      },
    ],
    [
      'language_config',
      {
        domain: 'client.example.com',
        redirect_urls: ['https://client.example.com/oauth/callback'],
        enabled_auth_methods: ['email_password'],
        ui_theme: baseClientConfigPayload().ui_theme,
      },
    ],
  ])('returns generic 400 when required config field is missing: %s', async (_field, payload) => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await signTestConfigJwt(payload);

    const fetchMock = vi.fn(await createTestConfigFetchHandler(jwt));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json());

    await app.close();
  });

  it('renders a sanitized debug page for HTML auth requests when config schema validation fails', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.DEBUG_ENABLED = 'true';

    const jwt = await signTestConfigJwt({
      ...baseClientConfigPayload(),
      ui_theme: {
        typography: {
          font_family: 'sans-serif',
          base_text_size: 'md',
        },
        logo: {
          url: 'https://client.example.com/logo.svg',
          alt: 'Client logo',
          text: 'Client',
        },
      },
    });

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config?token=should-not-render';
    const redirectUrl = 'https://client.example.com/auth/callback?code=secret';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}&redirect_url=${encodeURIComponent(redirectUrl)}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Auth configuration error');
    expect(res.body).toContain('CONFIG_SCHEMA_INVALID');
    expect(res.body).toContain('https://client.example.com/auth-config');
    expect(res.body).toContain('https://client.example.com/auth/callback');
    expect(res.body).toContain('ui_theme.colors');
    expect(res.body).toContain('Full config example');
    expect(res.body).toContain('&quot;ui_theme&quot;');
    expect(res.body).toContain('&quot;colors&quot;');
    expect(res.body).not.toContain('token=should-not-render');
    expect(res.body).not.toContain('code=secret');
    expect(res.body).not.toContain(process.env.SHARED_SECRET);

    await app.close();
  });

  it('renders redirect mismatch details for HTML social auth requests when redirect_url is not allowlisted', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.DEBUG_ENABLED = 'true';

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        redirect_urls: ['https://client.example.com/auth/callback'],
        enabled_auth_methods: ['google'],
      }),
    );

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/auth/callback?mode=signin&next=%2F';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/social/google?config_url=${encodeURIComponent(configUrl)}&redirect_url=${encodeURIComponent(redirectUrl)}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('REDIRECT_URL_NOT_ALLOWED');
    expect(res.body).toContain('config_url was fetched successfully and the config JWT passed signature, schema, and domain checks.');
    expect(res.body).toContain('The requested redirect_url does not exactly match any value in config.redirect_urls.');
    expect(res.body).toContain('https://client.example.com/auth/callback?mode=');
    expect(res.body).toContain('Requested redirect_url includes query keys: mode, next.');
    expect(res.body).toContain('Allowlisted redirect_urls: https://client.example.com/auth/callback.');
    expect(res.body).toContain('redirect_url matching is exact.');
    expect(res.body).not.toContain('next=%2F');

    await app.close();
  });

  it('renders provider gating details for HTML social auth requests when enabled_auth_methods omits the clicked provider', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.DEBUG_ENABLED = 'true';

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        enabled_auth_methods: ['email_password'],
      }),
    );

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/social/google?config_url=${encodeURIComponent(configUrl)}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('SOCIAL_PROVIDER_DISABLED');
    expect(res.body).toContain('The requested social provider is not enabled for this client config.');
    expect(res.body).toContain('config_url was fetched successfully and the config JWT passed signature, schema, and domain checks.');
    expect(res.body).toContain('The auth UI requested a social provider that is not listed in config.enabled_auth_methods.');
    expect(res.body).toContain('Add the provider to enabled_auth_methods in the signed config.');

    await app.close();
  });

  it('accepts a social auth request when enabled_auth_methods includes the provider', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';

    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        enabled_auth_methods: ['email_password', 'google'],
      }),
    );

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    try {
      const configUrl = 'https://client.example.com/auth-config';
      const res = await app.inject({
        method: 'GET',
        url: `/auth/social/google?config_url=${encodeURIComponent(configUrl)}&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(res.headers.location).toContain('client_id=google-client-id');
    } finally {
      if (originalGoogleClientId === undefined) {
        delete process.env.GOOGLE_CLIENT_ID;
      } else {
        process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
      }
      if (originalGoogleClientSecret === undefined) {
        delete process.env.GOOGLE_CLIENT_SECRET;
      } else {
        process.env.GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
      }
      await app.close();
    }
  });

  it('accepts config JWTs without an aud claim', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';

    const jwt = await signTestConfigJwt(baseClientConfigPayload(), { audience: null });

    const fetchMock = vi.fn(await createTestConfigFetchHandler(jwt));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');

    await app.close();
  });

  it('ignores config JWT aud because domain and signature are authoritative', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';

    const jwt = await signTestConfigJwt(baseClientConfigPayload(), {
      audience: 'some-other-auth-service',
    });

    const fetchMock = vi.fn(await createTestConfigFetchHandler(jwt));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');

    await app.close();
  });
});
