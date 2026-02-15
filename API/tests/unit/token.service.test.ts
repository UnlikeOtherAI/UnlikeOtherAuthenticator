import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClientId } from '../../src/utils/hash.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { exchangeAuthorizationCodeForAccessToken } from '../../src/services/token.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';

function hashAuthorizationCode(code: string, sharedSecret: string): string {
  return createHash('sha256').update(`${code}.${sharedSecret}`, 'utf8').digest('hex');
}

function makeConfig(overrides?: Partial<ClientConfig['org_features']>): ClientConfig {
  return {
    domain: 'client.example.com',
    org_features: {
      enabled: false,
      groups_enabled: false,
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

describe('exchangeAuthorizationCodeForAccessToken (unit)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalAccessTokenTtl = process.env.ACCESS_TOKEN_TTL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/authenticator_test';
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.ACCESS_TOKEN_TTL = '30m';
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
    process.env.ACCESS_TOKEN_TTL = originalAccessTokenTtl;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('includes org claim in an issued JWT and round-trips the org context', async () => {
    const now = new Date('2026-02-15T00:00:00.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-with-org';
    const config = makeConfig({
      enabled: true,
      groups_enabled: true,
    });
    const configUrl = 'https://client.example.com/auth-config';

    const prisma = {
      authorizationCode: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      domainRole: {
        findUnique: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamMember: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-1',
      userId: 'user-1',
      domain: config.domain,
      configUrl,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-1',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    prisma.orgMember.findFirst.mockResolvedValue({
      orgId: 'org-1',
      role: 'admin',
    });
    prisma.teamMember.findMany.mockResolvedValue([
      { teamId: 'team-1', teamRole: 'lead' },
      { teamId: 'team-2', teamRole: 'member' },
    ]);
    prisma.groupMember.findMany.mockResolvedValue([
      { groupId: 'group-1', isAdmin: true },
      { groupId: 'group-2', isAdmin: false },
    ]);

    const { accessToken } = await exchangeAuthorizationCodeForAccessToken(
      { code, config, configUrl },
      {
        now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(claims).toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      domain: config.domain,
      clientId: createClientId(config.domain, sharedSecret),
      role: 'user',
      org: {
        org_id: 'org-1',
        org_role: 'admin',
        teams: ['team-1', 'team-2'],
        team_roles: {
          'team-1': 'lead',
          'team-2': 'member',
        },
        groups: ['group-1', 'group-2'],
        group_admin: ['group-1'],
      },
    });
  });

  it('omits the org claim when org_features is disabled', async () => {
    const now = new Date('2026-02-15T00:00:01.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-without-org';
    const config = makeConfig({ enabled: false });
    const configUrl = 'https://client.example.com/auth-config';

    const prisma = {
      authorizationCode: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      domainRole: {
        findUnique: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamMember: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-2',
      userId: 'user-2',
      domain: config.domain,
      configUrl,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-2',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user2@example.com' });

    const { accessToken } = await exchangeAuthorizationCodeForAccessToken(
      { code, config, configUrl },
      {
        now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(claims).toMatchObject({
      userId: 'user-2',
      email: 'user2@example.com',
      domain: config.domain,
      clientId: createClientId(config.domain, sharedSecret),
      role: 'user',
    });
    expect(claims.org).toBeUndefined();
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it('omits the org claim when the user has no organisation on the domain', async () => {
    const now = new Date('2026-02-15T00:00:02.000Z');
    const sharedSecret = process.env.SHARED_SECRET!;
    const code = 'code-org-missing';
    const config = makeConfig({
      enabled: true,
      groups_enabled: true,
    });
    const configUrl = 'https://client.example.com/auth-config';

    const prisma = {
      authorizationCode: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      domainRole: {
        findUnique: vi.fn(),
      },
      orgMember: {
        findFirst: vi.fn(),
      },
      teamMember: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    prisma.authorizationCode.findUnique.mockResolvedValue({
      id: 'auth-code-3',
      userId: 'user-3',
      domain: config.domain,
      configUrl,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
      codeHash: hashAuthorizationCode(code, sharedSecret),
    });
    prisma.authorizationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.domainRole.findUnique.mockResolvedValue({
      role: 'USER',
      domain: config.domain,
      userId: 'user-3',
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'user3@example.com' });
    prisma.orgMember.findFirst.mockResolvedValue(null);

    const { accessToken } = await exchangeAuthorizationCodeForAccessToken(
      { code, config, configUrl },
      {
        now,
        sharedSecret,
        authServiceIdentifier: process.env.AUTH_SERVICE_IDENTIFIER,
        accessTokenTtl: '15m',
        prisma,
      },
    );

    const claims = await verifyAccessToken(accessToken, {
      sharedSecret,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    expect(claims).toMatchObject({
      userId: 'user-3',
      email: 'user3@example.com',
      domain: config.domain,
      clientId: createClientId(config.domain, sharedSecret),
      role: 'user',
    });
    expect(claims.org).toBeUndefined();
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });
});
