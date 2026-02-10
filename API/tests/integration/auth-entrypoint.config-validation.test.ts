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

