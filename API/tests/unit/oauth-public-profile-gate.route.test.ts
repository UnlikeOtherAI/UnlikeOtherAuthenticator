import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';

const envNames = [
  'SHARED_SECRET',
  'DATABASE_URL',
  'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK',
  'MCP_OAUTH_PUBLIC_PROFILE_ENABLED',
  'MCP_OAUTH_DOMAIN',
] as const;

const originalEnv = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]]),
) as Record<(typeof envNames)[number], string | undefined>;

function restoreEnv(): void {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  Object.assign(jwk, { kid: 'oauth-profile-gate-test', alg: 'RS256', use: 'sig' });
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(jwk);
  process.env.MCP_OAUTH_DOMAIN = 'oauth.test.example';
  Reflect.deleteProperty(process.env, 'MCP_OAUTH_PUBLIC_PROFILE_ENABLED');
  resetAccessTokenKeyCache();
});

afterAll(() => {
  restoreEnv();
  resetAccessTokenKeyCache();
});

describe('public OAuth profile gate', () => {
  it('publishes verification JWKS without opening public OAuth routes', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const jwks = await app.inject({ method: 'GET', url: '/oauth/jwks.json' });
      expect(jwks.statusCode).toBe(200);
      expect(jwks.json()).toMatchObject({
        keys: [{ kid: 'oauth-profile-gate-test', alg: 'RS256', use: 'sig' }],
      });

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' }),
        app.inject({
          method: 'POST',
          url: '/oauth/register',
          payload: { redirect_uris: ['https://client.example/callback'] },
        }),
        app.inject({
          method: 'GET',
          url:
            '/oauth/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback' +
            '&code_challenge=challenge&code_challenge_method=S256',
        }),
        app.inject({
          method: 'POST',
          url:
            '/oauth/login?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback' +
            '&code_challenge=challenge&code_challenge_method=S256',
          payload: { email: 'user@example.com', password: 'password' },
        }),
        app.inject({
          method: 'POST',
          url: '/oauth/token',
          payload: {
            code: 'code',
            redirect_uri: 'https://client.example/callback',
            client_id: 'client',
          },
        }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([
        404, 404, 404, 404, 404,
      ]);

      const repeatedRegistrationAttempts = await Promise.all(
        Array.from({ length: 21 }, () =>
          app.inject({
            method: 'POST',
            url: '/oauth/register',
            payload: { redirect_uris: ['https://client.example/callback'] },
          }),
        ),
      );
      expect(
        repeatedRegistrationAttempts.every((response) => response.statusCode === 404),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('exposes public OAuth metadata only after explicit enablement', async () => {
    process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'true';
    const app = await createApp();
    await app.ready();
    try {
      const metadata = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({
        registration_endpoint: expect.stringContaining('/oauth/register'),
        token_endpoint: expect.stringContaining('/oauth/token'),
      });
    } finally {
      await app.close();
      Reflect.deleteProperty(process.env, 'MCP_OAUTH_PUBLIC_PROFILE_ENABLED');
    }
  });
});
