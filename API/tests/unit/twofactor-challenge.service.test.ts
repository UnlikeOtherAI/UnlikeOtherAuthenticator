import { describe, expect, it } from 'vitest';

import {
  signTwoFaChallenge,
  verifyTwoFaChallenge,
} from '../../src/services/twofactor-challenge.service.js';

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
