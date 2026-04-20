import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import {
  signTwoFaChallenge,
  verifyTwoFaChallenge,
} from '../../src/services/twofactor-challenge.service.js';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe('twofactor-challenge.service', () => {
  it('signs and verifies a 2FA challenge token', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const token = await signTwoFaChallenge({
      userId: 'u1',
      domain: 'client.example.com',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      authMethod: 'email_password',
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
      ttlMs: 5 * 60 * 1000,
    });

    const decoded = await verifyTwoFaChallenge({
      token,
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
    });

    expect(decoded).toEqual({
      userId: 'u1',
      domain: 'client.example.com',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      authMethod: 'email_password',
      rememberMe: false,
      requestAccess: false,
    });
  });

  it('round-trips PKCE challenge metadata', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const token = await signTwoFaChallenge({
      userId: 'u1',
      domain: 'client.example.com',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      authMethod: 'email_password',
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
      ttlMs: 5 * 60 * 1000,
    });

    const decoded = await verifyTwoFaChallenge({
      token,
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
    });

    expect(decoded).toMatchObject({
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
    });
  });

  it('rejects verification when the audience is wrong', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const token = await signTwoFaChallenge({
      userId: 'u1',
      domain: 'client.example.com',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      authMethod: 'email_password',
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
      ttlMs: 5 * 60 * 1000,
    });

    await expect(
      verifyTwoFaChallenge({
        token,
        sharedSecret: 'test-shared-secret',
        audience: 'different-aud',
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects verification when the issuer is missing', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const token = await new SignJWT({
      config_url: 'https://client.example.com/auth-config',
      redirect_url: 'https://client.example.com/oauth/callback',
      domain: 'client.example.com',
      auth_method: 'email_password',
      remember_me: false,
      request_access: false,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setAudience('uoa-auth-service')
      .setSubject('u1')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor((now.getTime() + 5 * 60 * 1000) / 1000))
      .sign(secretKey('test-shared-secret'));

    await expect(
      verifyTwoFaChallenge({
        token,
        sharedSecret: 'test-shared-secret',
        audience: 'uoa-auth-service',
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects verification when token is expired', async () => {
    const now = new Date('2026-02-10T00:00:00.000Z');
    const token = await signTwoFaChallenge({
      userId: 'u1',
      domain: 'client.example.com',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      authMethod: 'email_password',
      sharedSecret: 'test-shared-secret',
      audience: 'uoa-auth-service',
      now,
      ttlMs: 1000,
    });

    await expect(
      verifyTwoFaChallenge({
        token,
        sharedSecret: 'test-shared-secret',
        audience: 'uoa-auth-service',
        now: new Date(now.getTime() + 5000),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
