import { describe, expect, it } from 'vitest';

import { signTwoFaSetupToken, verifyTwoFaSetupToken } from '../twofactor-setup-token.service.js';

describe('twofactor setup token', () => {
  const sharedSecret = 'test-shared-secret-with-enough-length';
  const audience = 'auth.example.com';
  const now = new Date('2026-06-10T12:00:00.000Z');

  it('round-trips the encrypted setup secret and finalization context', async () => {
    const token = await signTwoFaSetupToken({
      userId: 'user_1',
      encryptedSecret: 'v1:iv:cipher:tag',
      configUrl: 'https://app.example.com/config.jwt',
      domain: 'app.example.com',
      authMethod: 'email_password',
      redirectUrl: 'https://app.example.com/callback',
      rememberMe: true,
      requestAccess: true,
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      orgId: 'org_1',
      teamId: 'team_1',
      sharedSecret,
      audience,
      now,
    });

    await expect(verifyTwoFaSetupToken({ token, sharedSecret, audience, now })).resolves.toEqual({
      userId: 'user_1',
      encryptedSecret: 'v1:iv:cipher:tag',
      configUrl: 'https://app.example.com/config.jwt',
      domain: 'app.example.com',
      authMethod: 'email_password',
      redirectUrl: 'https://app.example.com/callback',
      rememberMe: true,
      requestAccess: true,
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      orgId: 'org_1',
      teamId: 'team_1',
    });
  });

  it('rejects expired setup tokens generically', async () => {
    const token = await signTwoFaSetupToken({
      userId: 'user_1',
      encryptedSecret: 'v1:iv:cipher:tag',
      configUrl: 'https://app.example.com/config.jwt',
      domain: 'app.example.com',
      sharedSecret,
      audience,
      now,
      ttlMs: 1000,
    });

    await expect(
      verifyTwoFaSetupToken({
        token,
        sharedSecret,
        audience,
        now: new Date(now.getTime() + 2000),
      }),
    ).rejects.toThrow('AUTHENTICATION_FAILED');
  });
});
