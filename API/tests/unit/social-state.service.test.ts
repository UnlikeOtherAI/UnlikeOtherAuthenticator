import { describe, expect, it } from 'vitest';

import { signSocialState, verifySocialState } from '../../src/services/social/social-state.service.js';

const SOCIAL_STATE_ISSUER = 'https://auth.example.com/social-state';

describe('social-state.service', () => {
  it('signs and verifies a social state JWT', async () => {
    const jwt = await signSocialState({
      provider: 'google',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      baseUrlForIssuer: 'https://auth.example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
      ttlMs: 60_000,
    });

    const state = await verifySocialState({
      stateJwt: jwt,
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      issuer: SOCIAL_STATE_ISSUER,
      now: new Date('2026-01-01T00:00:30.000Z'),
    });

    expect(state).toEqual({
      provider: 'google',
      config_url: 'https://client.example.com/auth-config',
      redirect_url: 'https://client.example.com/oauth/callback',
      request_access: false,
    });
  });

  it('round-trips PKCE challenge metadata', async () => {
    const jwt = await signSocialState({
      provider: 'google',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      requestAccess: true,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      baseUrlForIssuer: 'https://auth.example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
      ttlMs: 60_000,
    });

    const state = await verifySocialState({
      stateJwt: jwt,
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      issuer: SOCIAL_STATE_ISSUER,
      now: new Date('2026-01-01T00:00:30.000Z'),
    });

    expect(state).toMatchObject({
      request_access: true,
      code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      code_challenge_method: 'S256',
    });
  });

  it('rejects expired social state JWTs', async () => {
    const jwt = await signSocialState({
      provider: 'google',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      baseUrlForIssuer: 'https://auth.example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
      ttlMs: 1_000,
    });

    await expect(
      verifySocialState({
        stateJwt: jwt,
        sharedSecret: 'test-shared-secret-with-enough-length',
        audience: 'uoa-auth-service',
        issuer: SOCIAL_STATE_ISSUER,
        now: new Date('2026-01-01T00:00:02.000Z'),
      }),
    ).rejects.toThrow();
  });

  it('rejects social state JWTs from a different issuer', async () => {
    const jwt = await signSocialState({
      provider: 'google',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      baseUrlForIssuer: 'https://other-auth.example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
      ttlMs: 60_000,
    });

    await expect(
      verifySocialState({
        stateJwt: jwt,
        sharedSecret: 'test-shared-secret-with-enough-length',
        audience: 'uoa-auth-service',
        issuer: SOCIAL_STATE_ISSUER,
        now: new Date('2026-01-01T00:00:30.000Z'),
      }),
    ).rejects.toThrow();
  });

  it('rejects tampered social state JWTs', async () => {
    const jwt = await signSocialState({
      provider: 'google',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      sharedSecret: 'test-shared-secret-with-enough-length',
      audience: 'uoa-auth-service',
      baseUrlForIssuer: 'https://auth.example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
      ttlMs: 60_000,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    // Flip a bit in payload.
    const payload = Buffer.from(parts[1] ?? '', 'base64url');
    payload[0] = payload[0] ^ 0xff;
    parts[1] = payload.toString('base64url');
    const tampered = parts.join('.');

    await expect(
      verifySocialState({
        stateJwt: tampered,
        sharedSecret: 'test-shared-secret-with-enough-length',
        audience: 'uoa-auth-service',
        issuer: SOCIAL_STATE_ISSUER,
      }),
    ).rejects.toThrow();
  });
});
