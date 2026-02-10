import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGitHubAuthorizationUrl,
  getGitHubProfileFromCode,
} from '../../src/services/social/github.service.js';

describe('github.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a GitHub authorization URL', () => {
    const url = buildGitHubAuthorizationUrl({
      clientId: 'github-client-id',
      redirectUri: 'https://auth.example.com/auth/callback/github',
      state: 'state.jwt.here',
    });

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('github-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('https://auth.example.com/auth/callback/github');
    expect(u.searchParams.get('scope')).toContain('user:email');
    expect(u.searchParams.get('state')).toBe('state.jwt.here');
  });

  it('exchanges code and returns a verified email profile', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === 'string'
              ? input.url
              : String(input);

      if (url === 'https://github.com/login/oauth/access_token') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(
          JSON.stringify({
            login: 'userlogin',
            name: 'User Example',
            avatar_url: 'https://example.com/avatar.png',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([
            { email: 'alt@example.com', primary: false, verified: true },
            { email: 'user@example.com', primary: true, verified: true },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await getGitHubProfileFromCode({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://auth.example.com/auth/callback/github',
    });

    expect(profile).toEqual({
      provider: 'github',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User Example',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('rejects when GitHub does not provide a verified email', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === 'string'
              ? input.url
              : String(input);

      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ login: 'userlogin' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([{ email: 'user@example.com', primary: true, verified: false }]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubProfileFromCode({
        code: 'auth-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://auth.example.com/auth/callback/github',
      }),
    ).rejects.toThrow(/GITHUB_EMAIL_NOT_VERIFIED/);
  });
});
