import { describe, expect, it } from 'vitest';

import { buildUserIdentity } from '../../src/services/user-scope.service.js';

describe('buildUserIdentity', () => {
  it('builds a global user identity keyed only by email', () => {
    const id = buildUserIdentity({
      userScope: 'global',
      email: ' Alice@Example.com ',
      domain: 'ignored.example.com',
    });

    expect(id).toEqual({
      email: 'alice@example.com',
      domain: null,
      userKey: 'alice@example.com',
    });
  });

  it('builds a per-domain user identity keyed by domain + email', () => {
    const id = buildUserIdentity({
      userScope: 'per_domain',
      email: ' Alice@Example.com ',
      domain: 'Client.Example.Com.',
    });

    expect(id).toEqual({
      email: 'alice@example.com',
      domain: 'client.example.com',
      userKey: 'client.example.com|alice@example.com',
    });
  });

  it('treats same email on different domains as different identities', () => {
    const a = buildUserIdentity({
      userScope: 'per_domain',
      email: 'user@example.com',
      domain: 'a.example.com',
    });
    const b = buildUserIdentity({
      userScope: 'per_domain',
      email: 'user@example.com',
      domain: 'b.example.com',
    });

    expect(a.userKey).not.toEqual(b.userKey);
  });

  it('rejects per-domain identity when domain is missing', () => {
    expect(() =>
      buildUserIdentity({
        userScope: 'per_domain',
        email: 'user@example.com',
      }),
    ).toThrow();
  });
});

