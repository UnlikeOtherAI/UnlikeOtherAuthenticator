import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

// A relying party adding a second account sends `/auth?prompt=select_account`, and the Auth UI
// forwards it to the social route. Google must then show its account chooser instead of silently
// reusing whichever Google account the browser is already signed into.
describe('GET /auth/social/google (prompt=select_account)', () => {
  const configUrl = 'https://client.example.com/auth-config';
  const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const originalEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };

  beforeEach(async () => {
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({ enabled_auth_methods: ['email_password', 'google'] }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const start = async (extra: string) => {
    const app = await createApp();
    await app.ready();
    try {
      return await app.inject({
        method: 'GET',
        url:
          `/auth/social/google?config_url=${encodeURIComponent(configUrl)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256${extra}`,
      });
    } finally {
      await app.close();
    }
  };

  it('asks Google for its account chooser when the relying party requests it', async () => {
    const res = await start('&prompt=select_account');

    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('prompt')).toBe('select_account');
  });

  it('leaves the ordinary sign-in exactly as it was without a prompt', async () => {
    const res = await start('');

    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.searchParams.has('prompt')).toBe(false);
  });

  it('refuses a prompt value UOA does not forward', async () => {
    const res = await start('&prompt=login');

    expect(res.statusCode).toBe(400);
  });
});
