import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

type RouteCase = {
  name: string;
  method: 'GET' | 'POST';
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
};

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function createSignedConfigJwt(params: {
  sharedSecret: string;
  audience: string;
}): Promise<string> {
  return await new SignJWT(baseClientConfigPayload())
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(params.audience)
    .sign(new TextEncoder().encode(params.sharedSecret));
}

function createUnsignedConfigJwt(params: { audience: string }): string {
  const header = base64UrlEncodeJson({ alg: 'none', typ: 'JWT' });
  const payload = base64UrlEncodeJson({
    ...baseClientConfigPayload(),
    aud: params.audience,
  });
  return `${header}.${payload}.`;
}

async function createTamperedConfigJwt(params: {
  sharedSecret: string;
  audience: string;
}): Promise<string> {
  const jwt = await createSignedConfigJwt(params);
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('expected signed JWT with 3 parts');

  const decodedPayload = JSON.parse(
    Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  decodedPayload.domain = 'attacker.example.com';
  parts[1] = base64UrlEncodeJson(decodedPayload);

  return parts.join('.');
}

describe('Config JWT integrity is enforced across all config-verifier routes', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  const sharedSecret = 'test-shared-secret';
  const audience = 'uoa-auth-service';
  const configUrl = 'https://client.example.com/auth-config';
  const q = `config_url=${encodeURIComponent(configUrl)}`;

  const routes: RouteCase[] = [
    { name: 'auth entrypoint', method: 'GET', url: `/auth?${q}` },
    {
      name: 'email login',
      method: 'POST',
      url: `/auth/login?${q}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    },
    {
      name: 'register',
      method: 'POST',
      url: `/auth/register?${q}`,
      payload: { email: 'user@example.com' },
    },
    {
      name: 'reset-password request',
      method: 'POST',
      url: `/auth/reset-password/request?${q}`,
      payload: { email: 'user@example.com' },
    },
    {
      name: 'reset-password',
      method: 'POST',
      url: `/auth/reset-password?${q}`,
      payload: { token: 'test-token', password: 'Abcdef1!' },
    },
    {
      name: 'verify-email',
      method: 'POST',
      url: `/auth/verify-email?${q}`,
      payload: { token: 'test-token', password: 'Abcdef1!' },
    },
    {
      name: 'email reset-password landing',
      method: 'GET',
      url: `/auth/email/reset-password?${q}&token=test-token`,
    },
    {
      name: 'email registration-link landing',
      method: 'GET',
      url: `/auth/email/link?${q}&token=test-token`,
    },
    {
      name: 'email 2fa-reset landing',
      method: 'GET',
      url: `/auth/email/twofa-reset?${q}&token=test-token`,
    },
    {
      name: 'social auth init',
      method: 'GET',
      url: `/auth/social/google?${q}`,
    },
    {
      name: 'token exchange',
      method: 'POST',
      url: `/auth/token?${q}`,
      payload: { code: 'test-code' },
    },
    {
      name: '2fa reset request',
      method: 'POST',
      url: `/2fa/reset/request?${q}`,
      payload: { email: 'user@example.com' },
    },
    {
      name: '2fa reset',
      method: 'POST',
      url: `/2fa/reset?${q}`,
      payload: { token: 'test-token' },
    },
    {
      name: '2fa verify',
      method: 'POST',
      url: `/2fa/verify?${q}`,
      payload: { twofa_token: 'test-twofa-token', code: '123456' },
    },
  ];

  beforeEach(() => {
    process.env.SHARED_SECRET = sharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = audience;
  });

  afterEach(() => {
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [
      'unsigned (alg=none)',
      async () => createUnsignedConfigJwt({ audience }),
    ],
    [
      'tampered',
      async () => createTamperedConfigJwt({ sharedSecret, audience }),
    ],
  ])('returns generic 400 for %s config JWTs on all routes', async (_name, makeJwt) => {
    const jwt = await makeJwt();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    for (const route of routes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
        headers: route.headers,
      });

      expect(
        res.statusCode,
        `expected 400 for route "${route.name}" (${route.method} ${route.url})`,
      ).toBe(400);
      expect(res.json()).toEqual({ error: 'Request failed' });
    }

    expect(fetchMock).toHaveBeenCalledTimes(routes.length);
    await app.close();
  });
});

