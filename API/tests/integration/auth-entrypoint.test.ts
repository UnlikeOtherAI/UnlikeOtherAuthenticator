import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  // Minimal payload satisfying required config fields (Task 2.4).
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT({
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: {},
    language_config: 'en',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('GET /auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches config JWT from config_url and returns ok', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(configUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
      }),
    );

    await app.close();
  });

  it('returns ok when optional config fields are present', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await new SignJWT({
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: {},
      language_config: 'en',
      user_scope: 'per_domain',
      '2fa_enabled': true,
      debug_enabled: true,
      allowed_social_providers: ['google', 'github'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(process.env.AUTH_SERVICE_IDENTIFIER)
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('returns generic 400 when config JWT signature is invalid', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt('different-secret');

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
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

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns generic 400 when config JWT is unsigned (alg=none)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const header = base64UrlEncodeJson({ alg: 'none', typ: 'JWT' });
    const payload = base64UrlEncodeJson({
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: {},
      language_config: 'en',
      aud: process.env.AUTH_SERVICE_IDENTIFIER,
    });
    const unsignedJwt = `${header}.${payload}.`;

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(unsignedJwt, { status: 200 }));
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

  it('returns generic 400 when config JWT is tampered', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const decodedPayload = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    decodedPayload.domain = 'attacker.example.com';
    parts[1] = base64UrlEncodeJson(decodedPayload);
    const tamperedJwt = parts.join('.');

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(tamperedJwt, { status: 200 }));
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

  it('returns generic 400 when config_url is missing', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/auth' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it.each([
    [
      'domain',
      {
        redirect_urls: ['https://client.example.com/oauth/callback'],
        enabled_auth_methods: ['email_password'],
        ui_theme: {},
        language_config: 'en',
      },
    ],
    [
      'redirect_urls',
      {
        domain: 'client.example.com',
        enabled_auth_methods: ['email_password'],
        ui_theme: {},
        language_config: 'en',
      },
    ],
    [
      'enabled_auth_methods',
      {
        domain: 'client.example.com',
        redirect_urls: ['https://client.example.com/oauth/callback'],
        ui_theme: {},
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
        ui_theme: {},
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

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
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

    const jwt = await new SignJWT({
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: {},
      language_config: 'en',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
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

    const jwt = await new SignJWT({
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: {},
      language_config: 'en',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('some-other-auth-service')
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi.fn().mockResolvedValue(new Response(jwt, { status: 200 }));
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
