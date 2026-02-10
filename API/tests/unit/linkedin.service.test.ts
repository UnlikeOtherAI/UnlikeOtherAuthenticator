import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLinkedInAuthorizationUrl,
  getLinkedInProfileFromCode,
} from '../../src/services/social/linkedin.service.js';
import { AppError } from '../../src/utils/errors.js';

describe('linkedin.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a LinkedIn authorization URL', () => {
    const url = buildLinkedInAuthorizationUrl({
      clientId: 'linkedin-client-id',
      redirectUri: 'https://auth.example.com/auth/callback/linkedin',
      state: 'state.jwt.here',
    });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('linkedin-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback/linkedin');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('scope')).toContain('profile');
    expect(u.searchParams.get('scope')).toContain('email');
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

    const profile = await getLinkedInProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/linkedin',
    });

    expect(profile).toEqual({
      provider: 'linkedin',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User Example',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('rejects missing emails', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getLinkedInProfileFromCode({
        code: 'auth-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://auth.example.com/auth/callback/linkedin',
      }),
    ).rejects.toThrow(AppError);
  });
});

