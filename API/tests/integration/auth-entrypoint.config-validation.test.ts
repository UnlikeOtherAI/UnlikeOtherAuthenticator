import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

describe('GET /auth (config validation)', () => {
  afterEach(() => {
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
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(process.env.AUTH_SERVICE_IDENTIFIER)
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('renders a sanitized debug page for HTML auth requests when config schema validation fails', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT({
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
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(process.env.AUTH_SERVICE_IDENTIFIER)
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })));

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

  it('returns generic 400 when config JWT aud is missing', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT(baseClientConfigPayload())
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns generic 400 when config JWT aud does not match', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT(baseClientConfigPayload())
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('some-other-auth-service')
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
