import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildXAuthorizationUrl, generateXCodeVerifier, getXProfileFromCode } from '../../src/services/social/x.service.js';

describe('x.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses confidential OAuth with S256 and the minimal profile/email scopes', () => {
    const verifier = generateXCodeVerifier();
    const url = new URL(buildXAuthorizationUrl({
      clientId: 'client-id',
      redirectUri: 'https://auth.example.com/auth/callback/x',
      state: 'browser-nonce',
      codeVerifier: verifier,
    }));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('tweet.read users.read users.email');
    expect(url.searchParams.get('state')).toBe('browser-nonce');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).not.toBe(verifier);
  });

  it('accepts only a confirmed email returned for the authenticated X account', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.x.com/2/oauth2/token') {
        expect(init?.method).toBe('POST');
        expect(String(init?.headers && (init.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
        expect(String(init?.body)).toContain('code_verifier=verifier');
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }
      if (url.startsWith('https://api.x.com/2/users/me')) {
        expect(url).toContain('confirmed_email');
        return new Response(JSON.stringify({ data: {
          id: '42', confirmed_email: 'User@Example.com', name: 'User Name',
          profile_image_url: 'https://example.com/avatar.jpg',
        } }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await getXProfileFromCode({ code: 'code', clientId: 'id', clientSecret: 'secret',
      redirectUri: 'https://auth.example.com/auth/callback/x', codeVerifier: 'verifier' })).toEqual({
      provider: 'x', email: 'user@example.com', emailVerified: true,
      name: 'User Name', avatarUrl: 'https://example.com/avatar.jpg',
    });
  });

  it('fails closed when X omits confirmed_email', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input) === 'https://api.x.com/2/oauth2/token'
        ? new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ data: { id: '42', email: 'unverified@example.com' } }), { status: 200 })));
    await expect(getXProfileFromCode({ code: 'code', clientId: 'id', clientSecret: 'secret',
      redirectUri: 'https://auth.example.com/auth/callback/x', codeVerifier: 'verifier' }))
      .rejects.toMatchObject({ statusCode: 401, message: 'X_EMAIL_MISSING' });
  });
});
