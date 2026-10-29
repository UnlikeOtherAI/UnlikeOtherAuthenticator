import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from '../helpers/test-config.js';

describe('X social authorization', () => {
  const configUrl = 'https://client.example.com/auth-config';
  const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const originalEnv = {
    X_CLIENT_ID: process.env.X_CLIENT_ID,
    X_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
  };

  beforeEach(async () => {
    process.env.SHARED_SECRET ??= 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER ??= 'uoa-auth-service';
    process.env.X_CLIENT_ID = 'x-client-id';
    process.env.X_CLIENT_SECRET = 'x-client-secret';
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({ enabled_auth_methods: ['email_password', 'x'] }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it('sends only a short nonce to X and binds UOA state and PKCE to signed browser cookies', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/auth/social/x?config_url=${encodeURIComponent(configUrl)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      expect(response.statusCode).toBe(302);
      const redirect = new URL(String(response.headers.location));
      expect(redirect.origin + redirect.pathname).toBe('https://x.com/i/oauth2/authorize');
      expect(redirect.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
      const cookieNames = response.cookies.map((cookie) => cookie.name);
      expect(cookieNames).toContain('uoa_social_state');
      expect(cookieNames).toContain('uoa_x_social_context');
      for (const cookie of response.cookies) {
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.secure).toBe(true);
        expect(cookie.sameSite).toBe('Lax');
      }
    } finally {
      await app.close();
    }
  });
});
