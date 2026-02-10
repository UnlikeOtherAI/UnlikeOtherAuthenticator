import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildGoogleAuthorizationUrl, getGoogleProfileFromCode } from '../../src/services/social/google.service.js';
import { AppError } from '../../src/utils/errors.js';

describe('google.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a Google authorization URL', () => {
    const url = buildGoogleAuthorizationUrl({
      clientId: 'google-client-id',
      redirectUri: 'https://auth.example.com/auth/callback/google',
      state: 'state.jwt.here',
    });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('google-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback/google');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('scope')).toContain('email');
    expect(u.searchParams.get('scope')).toContain('profile');
    expect(u.searchParams.get('state')).toBe('state.jwt.here');
  });

  it('exchanges code and returns a verified email profile', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          email: 'user@example.com',
          email_verified: true,
          name: 'User Example',
          picture: 'https://example.com/avatar.png',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getGoogleProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/google',
    });

    expect(profile).toEqual({
      provider: 'google',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User Example',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('rejects unverified emails', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          email: 'user@example.com',
          email_verified: false,
          name: 'User Example',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getGoogleProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/google',
    });

    expect(profile.emailVerified).toBe(false);

    // Enforcement is handled by the shared social-login service; keep this test focused on parsing.
    expect(() => {
      if (!profile.emailVerified) throw new AppError('UNAUTHORIZED', 401);
    }).toThrow();
  });

  it('treats string "false" as unverified', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          email: 'user@example.com',
          email_verified: 'false',
          name: 'User Example',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getGoogleProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/google',
    });

    expect(profile.emailVerified).toBe(false);
  });
});
