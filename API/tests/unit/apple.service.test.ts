import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from 'jose';

import { buildAppleAuthorizationUrl, getAppleProfileFromCode } from '../../src/services/social/apple.service.js';

describe('apple.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds an Apple authorization URL', () => {
    const url = buildAppleAuthorizationUrl({
      clientId: 'com.example.web',
      redirectUri: 'https://auth.example.com/auth/callback/apple',
      state: 'state.jwt.here',
    });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('com.example.web');
    expect(u.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback/apple');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('scope')).toContain('email');
    expect(u.searchParams.get('state')).toBe('state.jwt.here');
    expect(u.searchParams.get('response_mode')).toBe('query');
  });

  it('exchanges code and returns a verified email profile', async () => {
    // Apple client secret uses ES256 (private .p8). Token id_token uses RS256 (Apple JWKS).
    const { privateKey: clientSecretPriv } = await generateKeyPair('ES256');
    const clientSecretPem = await exportPKCS8(clientSecretPriv);

    const { publicKey: idTokenPub, privateKey: idTokenPriv } = await generateKeyPair('RS256');
    const jwk = await exportJWK(idTokenPub);
    const kid = 'test-kid';

    const idToken = await new SignJWT({
      email: 'user@example.com',
      email_verified: 'true',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer('https://appleid.apple.com')
      .setAudience('com.example.web')
      .setSubject('apple-user-sub')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(idTokenPriv);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === 'string'
              ? input.url
              : String(input);
      if (url === 'https://appleid.apple.com/auth/token') {
        return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      }
      if (url === 'https://appleid.apple.com/auth/keys') {
        return new Response(
          JSON.stringify({
            keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getAppleProfileFromCode({
      code: 'auth-code',
      clientId: 'com.example.web',
      teamId: 'TEAMID123',
      keyId: 'KEYID123',
      privateKeyPem: clientSecretPem,
      redirectUri: 'https://auth.example.com/auth/callback/apple',
    });

    expect(profile).toEqual({
      provider: 'apple',
      email: 'user@example.com',
      emailVerified: true,
      name: null,
      avatarUrl: null,
    });
  });
});
