import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, vi } from 'vitest';

import type { ClientConfig } from '../../../src/services/config.service.js';

/**
 * Shared across the `token.service.*.test.ts` siblings (CLAUDE.md 500-line split of the original
 * `token.service.test.ts`) — unchanged from the pre-split file, only their location moved.
 */
export function hashAuthorizationCode(code: string, sharedSecret: string): string {
  return createHmac('sha256', sharedSecret).update(code, 'utf8').digest('hex');
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

// PKCE is mandatory on both issuance and redemption; these tests exercise the
// secure path with a real challenge/verifier pair.
export const TEST_CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
export const TEST_CODE_CHALLENGE = pkceChallenge(TEST_CODE_VERIFIER);

export function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
  return {
    domain: 'client.example.com',
    org_features: {
      enabled: false,
      groups_enabled: false,
      user_needs_team: false,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      ...overrides,
    },
  } as unknown as ClientConfig;
}

/**
 * Registers the same env-var setup/teardown every `token.service.*.test.ts` file needs. Call once
 * inside each file's top-level `describe` — mirrors each original describe block's own
 * `beforeEach`/`afterEach` exactly, just callable from multiple sibling files.
 */
export function useTokenServiceTestEnv(): void {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAccessTokenTtl = process.env.ACCESS_TOKEN_TTL;
  const originalRefreshTokenTtlDays = process.env.REFRESH_TOKEN_TTL_DAYS;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/authenticator_test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '30m';
    process.env.REFRESH_TOKEN_TTL_DAYS = '30';
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
    process.env.ACCESS_TOKEN_TTL = originalAccessTokenTtl;
    process.env.REFRESH_TOKEN_TTL_DAYS = originalRefreshTokenTtlDays;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
}
