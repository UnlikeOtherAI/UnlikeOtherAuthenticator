import { afterEach, describe, expect, it } from 'vitest';

import {
  adminAvatarImageUrl,
  adminTeamAvatarImageUrl,
  avatarImageBaseUrl,
  domainAvatarImageUrl,
  domainTeamAvatarImageUrl,
  publicTeamAvatarImageUrl,
} from '../../src/utils/avatar-url.js';

// Docs/Auth/avatars.md §9: every identity payload carries a URL that resolves to an image and is
// fetchable with the same credential class the caller already used.
describe('avatar image URL builders', () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalPublicBaseUrl === undefined) Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  it('builds an absolute domain-hash URL from the configured base', () => {
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com',
        domain: 'client.example.com',
        userId: 'user_1',
      }),
    ).toBe('https://auth.example.com/domain/users/user_1/avatar?domain=client.example.com');
  });

  it('builds an absolute admin URL from the configured base', () => {
    expect(adminAvatarImageUrl({ baseUrl: 'https://auth.example.com', userId: 'user_1' })).toBe(
      'https://auth.example.com/internal/admin/users/user_1/avatar',
    );
  });

  it('strips trailing slashes from the base so paths never double up', () => {
    expect(adminAvatarImageUrl({ baseUrl: 'https://auth.example.com///', userId: 'user_1' })).toBe(
      'https://auth.example.com/internal/admin/users/user_1/avatar',
    );
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com/',
        domain: 'client.example.com',
        userId: 'user_1',
      }),
    ).toBe('https://auth.example.com/domain/users/user_1/avatar?domain=client.example.com');
  });

  it('falls back to a root-relative path when no base URL is configured', () => {
    expect(
      domainAvatarImageUrl({ baseUrl: undefined, domain: 'client.example.com', userId: 'user_1' }),
    ).toBe('/domain/users/user_1/avatar?domain=client.example.com');
    expect(adminAvatarImageUrl({ baseUrl: '', userId: 'user_1' })).toBe(
      '/internal/admin/users/user_1/avatar',
    );
    expect(adminAvatarImageUrl({ baseUrl: null, userId: 'user_1' })).toBe(
      '/internal/admin/users/user_1/avatar',
    );
  });

  it('URL-encodes every interpolated segment and parameter', () => {
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com',
        domain: 'client.example.com/evil?x=1',
        userId: 'a/b?c=d#e',
      }),
    ).toBe(
      'https://auth.example.com/domain/users/a%2Fb%3Fc%3Dd%23e/avatar' +
        '?domain=client.example.com%2Fevil%3Fx%3D1',
    );
    expect(adminAvatarImageUrl({ baseUrl: '', userId: '../../secret' })).toBe(
      '/internal/admin/users/..%2F..%2Fsecret/avatar',
    );
  });

  // Docs/Auth/avatars.md §11: team records carry the same thing for the team itself.
  it('builds the two team forms, mirroring the user builders', () => {
    expect(
      domainTeamAvatarImageUrl({
        baseUrl: 'https://auth.example.com',
        domain: 'client.example.com',
        teamId: 'team_1',
      }),
    ).toBe('https://auth.example.com/domain/teams/team_1/avatar?domain=client.example.com');

    expect(adminTeamAvatarImageUrl({ baseUrl: 'https://auth.example.com', teamId: 'team_1' })).toBe(
      'https://auth.example.com/internal/admin/teams/team_1/avatar',
    );
  });

  it('applies the same base normalisation and encoding rules to the team forms', () => {
    expect(
      domainTeamAvatarImageUrl({ baseUrl: undefined, domain: 'client.example.com', teamId: 't1' }),
    ).toBe('/domain/teams/t1/avatar?domain=client.example.com');
    expect(adminTeamAvatarImageUrl({ baseUrl: null, teamId: 't1' })).toBe(
      '/internal/admin/teams/t1/avatar',
    );
    expect(
      domainTeamAvatarImageUrl({
        baseUrl: 'https://auth.example.com//',
        domain: 'client.example.com/evil?x=1',
        teamId: 'a/b?c=d#e',
      }),
    ).toBe(
      'https://auth.example.com/domain/teams/a%2Fb%3Fc%3Dd%23e/avatar' +
        '?domain=client.example.com%2Fevil%3Fx%3D1',
    );
    expect(adminTeamAvatarImageUrl({ baseUrl: '', teamId: '../../secret' })).toBe(
      '/internal/admin/teams/..%2F..%2Fsecret/avatar',
    );
  });

  it('reads PUBLIC_BASE_URL for the base and never throws when it is unset', () => {
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com/';
    expect(avatarImageBaseUrl()).toBe('https://auth.example.com');

    // Unset in dev/test: an empty base yields relative URLs rather than an error or a bogus
    // HOST:PORT origin.
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    expect(avatarImageBaseUrl()).toBe('');
  });

  it('versions the public team URL by the team row updatedAt (§11.4)', () => {
    const updatedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(
      publicTeamAvatarImageUrl({ baseUrl: 'https://auth.example.com/', teamId: 'team 1', updatedAt }),
    ).toBe('https://auth.example.com/teams/team%201/avatar?v=muorpc00');
    expect(
      publicTeamAvatarImageUrl({
        baseUrl: null,
        teamId: 'team_1',
        updatedAt: new Date(updatedAt.getTime() + 1),
      }),
    ).toBe('/teams/team_1/avatar?v=muorpc01');
  });
});
