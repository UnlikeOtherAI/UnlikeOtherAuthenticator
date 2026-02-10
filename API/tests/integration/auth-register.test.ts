import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';

async function createSignedConfigJwt(sharedSecret: string): Promise<string> {
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

describe('POST /auth/register', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('always responds with the same success message (no enumeration)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);

    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(jwt, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const url = `/auth/register?config_url=${encodeURIComponent(configUrl)}`;

    const res1 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'existing@example.com' },
    });
    const res2 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'newuser@example.com' },
    });
    const res3 = await app.inject({
      method: 'POST',
      url,
      payload: { email: 'not-an-email' },
    });
    const res4 = await app.inject({
      method: 'POST',
      url,
      payload: {},
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(200);
    expect(res4.statusCode).toBe(200);

    const expected = { message: 'We sent instructions to your email' };
    expect(res1.json()).toEqual(expected);
    expect(res2.json()).toEqual(expected);
    expect(res3.json()).toEqual(expected);
    expect(res4.json()).toEqual(expected);

    await app.close();
  });
});
