import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildFacebookAuthorizationUrl,
  getFacebookProfileFromCode,
} from '../../src/services/social/facebook.service.js';

describe('facebook.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a Facebook authorization URL', () => {
    const url = buildFacebookAuthorizationUrl({
      clientId: 'facebook-client-id',
      redirectUri: 'https://auth.example.com/auth/callback/facebook',
      state: 'state.jwt.here',
    });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('facebook-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback/facebook');
    expect(u.searchParams.get('scope')).toContain('email');
    expect(u.searchParams.get('scope')).toContain('public_profile');
    expect(u.searchParams.get('state')).toBe('state.jwt.here');
  });

  it('exchanges code and returns a profile', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'fb-id',
          email: 'user@example.com',
          name: 'User Example',
          picture: { data: { url: 'https://example.com/avatar.png' } },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getFacebookProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/facebook',
    });

    expect(profile).toEqual({
      provider: 'facebook',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User Example',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('rejects when Facebook does not provide an email', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'fb-id', name: 'User Example' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getFacebookProfileFromCode({
        code: 'auth-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://auth.example.com/auth/callback/facebook',
      }),
    ).rejects.toThrow(/FACEBOOK_EMAIL_MISSING/);
  });
});

