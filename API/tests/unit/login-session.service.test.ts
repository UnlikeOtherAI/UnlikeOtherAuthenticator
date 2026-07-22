import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  assertLoginSessionContinuation,
  fingerprintClientConfig,
  signLoginSession,
  verifyLoginSession,
} from '../../src/services/login-session.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const SECRET = 'test-shared-secret-with-enough-length';
const AUDIENCE = 'uoa:login-session';
const CONFIG_URL = 'https://client.example.com/auth-config';
const REDIRECT_URL = 'https://client.example.com/oauth/callback';
const CHALLENGE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function config(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: [REDIRECT_URL],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    ...overrides,
  } as ClientConfig;
}

function continuation(overrides?: Record<string, unknown>) {
  return {
    userId: 'user-1',
    credentialEpoch: 0,
    authMethod: 'google',
    config: config(),
    configUrl: CONFIG_URL,
    redirectUrl: REDIRECT_URL,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256' as const,
    rememberMe: true,
    requestAccess: false,
    sharedSecret: SECRET,
    audience: AUDIENCE,
    ...overrides,
  };
}

describe('login-session.service', () => {
  it('round-trips the exact signed continuation', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({
      ...continuation(),
      now,
      ttlMs: 10 * 60 * 1000,
      jti: 'session-jti',
    });

    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    expect(session).toMatchObject({
      userId: 'user-1',
      credentialEpoch: 0,
      authMethod: 'google',
      domain: 'client.example.com',
      configUrl: CONFIG_URL,
      configFingerprint: fingerprintClientConfig(config()),
      redirectUrl: REDIRECT_URL,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      rememberMe: true,
      requestAccess: false,
      jti: 'session-jti',
    });
    expect(session.expiresAtEpochSeconds).toBe(Math.floor((now.getTime() + 600_000) / 1000));
  });

  it('rejects the same config URL when verified config semantics changed', async () => {
    const token = await signLoginSession(continuation());
    const changed = config({ redirect_urls: [REDIRECT_URL, 'https://client.example.com/other'] });

    await expect(
      verifyLoginSession({
        token,
        config: changed,
        configUrl: CONFIG_URL,
        sharedSecret: SECRET,
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a config URL or domain mismatch', async () => {
    const token = await signLoginSession(continuation());

    for (const changed of [
      { config: config(), configUrl: 'https://client.example.com/changed' },
      { config: config({ domain: 'other.example.com' }), configUrl: CONFIG_URL },
    ]) {
      await expect(
        verifyLoginSession({
          token,
          ...changed,
          sharedSecret: SECRET,
          audience: AUDIENCE,
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
    }
  });

  it('rejects an expired token', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation(), now, ttlMs: 1000 });

    await expect(
      verifyLoginSession({
        token,
        config: config(),
        configUrl: CONFIG_URL,
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now: new Date(now.getTime() + 5000),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects the wrong audience', async () => {
    const token = await signLoginSession(continuation());

    await expect(
      verifyLoginSession({
        token,
        config: config(),
        configUrl: CONFIG_URL,
        sharedSecret: SECRET,
        audience: 'uoa:access-token',
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects caller retargeting of every continuation field', async () => {
    const token = await signLoginSession(continuation());
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
    });
    const base = {
      redirectUrl: REDIRECT_URL,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256' as const,
      rememberMe: true,
      requestAccess: false,
    };

    for (const mutation of [
      { redirectUrl: 'https://client.example.com/other' },
      { codeChallenge: `${CHALLENGE}x` },
      { codeChallengeMethod: undefined },
      { rememberMe: false },
      { requestAccess: true },
    ]) {
      expect(() => assertLoginSessionContinuation(session, { ...base, ...mutation })).toThrow();
    }
  });

  it('rejects tokens minted for another purpose or issuer', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    for (const { typ, issuer } of [
      { typ: 'twofa_challenge', issuer: 'uoa:login-session' },
      { typ: 'login_session', issuer: 'uoa:twofa-challenge' },
    ]) {
      const foreignToken = await new SignJWT({ domain: 'client.example.com', typ })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setIssuedAt(Math.floor(now.getTime() / 1000))
        .setExpirationTime(Math.floor((now.getTime() + 60_000) / 1000))
        .sign(secretKey(SECRET));

      await expect(
        verifyLoginSession({
          token: foreignToken,
          config: config(),
          configUrl: CONFIG_URL,
          sharedSecret: SECRET,
          audience: AUDIENCE,
          now,
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
    }
  });
});
