import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
  // Minimal payload satisfying required config fields (Task 2.4).
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload())
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function readAuthDistIndexHtml(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../../');
  return await readFile(path.join(repoRoot, 'Auth', 'dist', 'index.html'), 'utf8');
}

function extractFirstMatch(re: RegExp, text: string): string {
  const m = text.match(re);
  if (!m?.[1]) throw new Error(`failed to match: ${re}`);
  return m[1];
}

describe('GET /auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches config JWT from config_url and renders the auth UI HTML', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);

    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
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
    expect(res.body).toMatch(/<div\s+id=(["'])root\1[^>]*>/i);
    // SSR should inject initial markup into #root (the client then hydrates).
    expect(res.body).toMatch(/<div\s+id=(["'])root\1[^>]*>\s*<div/i);
    expect(res.body).toContain('window.__UOA_CLIENT_CONFIG__');
    expect(res.body).toContain('client.example.com');
    // Brief 8: single language config should not show a selector.
    expect(res.body).not.toContain('data-testid="language-selector"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(configUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
      }),
    );

    await app.close();
  });

  it('re-fetches and re-verifies config on every /auth initiation (no caching)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const okJwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    const mismatchedDomainJwt = await new SignJWT(baseClientConfigPayload({
      domain: 'attacker.example.com',
    }))
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(process.env.AUTH_SERVICE_IDENTIFIER)
      .sign(new TextEncoder().encode(process.env.SHARED_SECRET));

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => new Response(okJwt, { status: 200 }))
      .mockImplementationOnce(async () => new Response(mismatchedDomainJwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const url = `/auth?config_url=${encodeURIComponent(configUrl)}`;

    const okRes = await app.inject({ method: 'GET', url });
    expect(okRes.statusCode).toBe(200);

    const badRes = await app.inject({ method: 'GET', url });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json()).toEqual({ error: 'Request failed' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(configUrl);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(configUrl);

    await app.close();
  });

  it('renders the language selector when multiple languages are provided', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT(baseClientConfigPayload({
      language_config: ['en', 'es'],
      language: 'es',
    }))
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

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="language-selector"');
    // Brief 8 / Phase 10.4: default to the language selected on the client website.
    expect(res.body).toContain('Iniciar sesion');

    await app.close();
  });

  it('renders UI HTML when optional config fields are present', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await new SignJWT(baseClientConfigPayload({
      user_scope: 'per_domain',
      '2fa_enabled': true,
      debug_enabled: true,
      allowed_social_providers: ['google', 'github'],
    }))
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

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toMatch(/<div\s+id=(["'])root\1[^>]*>/i);
    expect(res.body).toMatch(/<div\s+id=(["'])root\1[^>]*>\s*<div/i);
    expect(res.body).toContain('window.__UOA_CLIENT_CONFIG__');
    expect(res.body).toContain('allowed_social_providers');

    await app.close();
  });

  it('strips unknown config claims before bootstrapping the Auth UI', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT({
      ...baseClientConfigPayload(),
      extra_claim: 'should_not_render',
    })
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

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('extra_claim');
    expect(res.body).not.toContain('should_not_render');

    await app.close();
  });

  it('serves built Auth assets from /assets/*', async () => {
    const app = await createApp();
    await app.ready();

    const html = await readAuthDistIndexHtml();
    const jsPath = extractFirstMatch(/src="(\/assets\/[^"]+)"/, html);
    const cssPath = extractFirstMatch(/href="(\/assets\/[^"]+)"/, html);

    const jsRes = await app.inject({ method: 'GET', url: jsPath });
    expect(jsRes.statusCode).toBe(200);
    expect(jsRes.headers['content-type']).toContain('application/javascript');

    const cssRes = await app.inject({ method: 'GET', url: cssPath });
    expect(cssRes.statusCode).toBe(200);
    expect(cssRes.headers['content-type']).toContain('text/css');

    await app.close();
  });

  it('returns generic 400 when config_url contains the shared secret', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = `https://client.example.com/auth-config?leak=${encodeURIComponent(process.env.SHARED_SECRET)}`;
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });
    expect(res.body).not.toContain(process.env.SHARED_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns generic 400 when config JWT signature is invalid', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt('different-secret');

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

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns generic 400 when config payload contains the shared secret', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT({
      ...baseClientConfigPayload(),
      leak: process.env.SHARED_SECRET,
    })
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
    expect(res.body).not.toContain(process.env.SHARED_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns generic 400 when config JWT is unsigned (alg=none)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const header = base64UrlEncodeJson({ alg: 'none', typ: 'JWT' });
    const payload = base64UrlEncodeJson({
      ...baseClientConfigPayload(),
      aud: process.env.AUTH_SERVICE_IDENTIFIER,
    });
    const unsignedJwt = `${header}.${payload}.`;

    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(unsignedJwt, { status: 200 }));
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
      .mockImplementation(async () => new Response(tamperedJwt, { status: 200 }));
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

  it('returns generic 400 when domain claim does not match config_url host', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await new SignJWT(baseClientConfigPayload({
      domain: 'attacker.example.com',
    }))
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
});
