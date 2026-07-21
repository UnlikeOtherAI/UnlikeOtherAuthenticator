import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { verifyAccessToken } from '../../src/services/access-token.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { resolveRequiredAuthorizationWorkspace } from '../../src/services/required-workspace-placement.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../src/services/token.service.js';
import { createClientId } from '../../src/utils/hash.js';
import {
  makeConfig,
  TEST_CODE_CHALLENGE,
  TEST_CODE_VERIFIER,
  useTokenServiceTestEnv,
} from './helpers/token-service-test-helpers.js';

describe('required workspace placement during token exchange', () => {
  useTokenServiceTestEnv();

  it('creates, validates, persists, and signs the exact workspace for a brand-new user', async () => {
    const now = new Date('2026-07-21T20:00:00.000Z');
    const config = {
      ...makeConfig({
        enabled: true,
        groups_enabled: false,
        user_needs_team: true,
        allow_user_create_org: true,
      }),
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' as const },
    } as ClientConfig;
    let placed = false;
    const prisma = {
      authorizationCode: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'code-row',
          userId: 'user-new',
          domain: config.domain,
          configUrl: 'https://client.example.com/auth-config',
          redirectUrl: 'https://client.example.com/oauth/callback',
          codeChallenge: TEST_CODE_CHALLENGE,
          codeChallengeMethod: 'S256',
          expiresAt: new Date(now.getTime() + 60_000),
          usedAt: null,
          orgId: null,
          teamId: null,
          rememberMe: true,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      billingAppKey: { findMany: vi.fn() },
      clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'inactive' }) },
      domainRole: {
        findUnique: vi.fn().mockResolvedValue({ role: 'USER', domain: config.domain }),
      },
      organisation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'org-new' }),
      },
      orgMember: {
        create: vi.fn().mockResolvedValue({ id: 'org-member-new' }),
        findFirst: vi.fn(async () =>
          placed ? { id: 'org-member-new', orgId: 'org-new', role: 'owner' } : null,
        ),
        findMany: vi.fn(async () => (placed ? [{ orgId: 'org-new', role: 'owner' }] : [])),
      },
      refreshToken: { create: vi.fn().mockResolvedValue({ id: 'refresh-new' }) },
      team: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'team-new' }),
      },
      teamInvite: { findMany: vi.fn().mockResolvedValue([]) },
      teamMember: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockImplementation(async () => {
          placed = true;
          return { id: 'team-member-new' };
        }),
        findFirst: vi.fn(async () => (placed ? { id: 'team-member-new' } : null)),
        findMany: vi.fn(async (args: { select?: { team?: unknown } }) => {
          if (!placed) return [];
          return args.select?.team
            ? [
                {
                  teamId: 'team-new',
                  teamRole: 'admin',
                  team: {
                    iconUrl: null,
                    name: "New User's team",
                    orgId: 'org-new',
                    slug: 'new-user-s-team',
                  },
                },
              ]
            : [{ teamId: 'team-new', teamRole: 'admin' }];
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-new',
          email: 'new.user@example.com',
          name: 'New User',
          tokenVersion: 0,
        }),
      },
    } as unknown as PrismaClient;
    const sharedSecret = process.env.SHARED_SECRET!;

    const result = await exchangeAuthorizationCodeForTokens(
      {
        code: 'new-user-code',
        config,
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback',
        clientId: createClientId(config.domain, sharedSecret),
        codeVerifier: TEST_CODE_VERIFIER,
      },
      { now: () => now, prisma, sharedSecret },
    );

    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-new', teamId: 'team-new' }),
      }),
    );
    const claims = await verifyAccessToken(result.accessToken, {
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
      prisma,
      sharedSecret,
    });
    expect(claims.active).toEqual({ orgId: 'org-new', teamId: 'team-new' });
    expect(result.firstLogin?.memberships.teams).toContainEqual({
      iconUrl: null,
      orgId: 'org-new',
      role: 'admin',
      teamId: 'team-new',
    });
  });

  it('fails closed on multiple product workspaces before personal placement', async () => {
    const config = {
      ...makeConfig({ enabled: true, user_needs_team: true }),
      domain: 'api.deeptest.live',
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' as const },
    } as ClientConfig;
    const createOrganisation = vi.fn();
    const prisma = {
      organisation: { create: createOrganisation },
      teamInvite: { findMany: vi.fn().mockResolvedValue([]) },
      teamMember: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'member@example.com' }) },
    } as unknown as PrismaClient;
    const workspacePrisma = {
      billingAppKey: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ serviceId: 'svc-deeptest', service: { identifier: 'deeptest' } }]),
      },
      clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'active' }) },
      teamMember: {
        findMany: vi.fn().mockResolvedValue([
          {
            teamId: 'team-a',
            teamRole: 'member',
            team: { iconUrl: null, name: 'A', orgId: 'org-a', slug: 'a' },
          },
          {
            teamId: 'team-b',
            teamRole: 'member',
            team: { iconUrl: null, name: 'B', orgId: 'org-b', slug: 'b' },
          },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(
      resolveRequiredAuthorizationWorkspace(
        { config, userId: 'user-member' },
        {
          env: { DATABASE_URL: 'postgres://example' } as never,
          prisma,
          workspacePrisma,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_AUTH_CODE' });
    expect(createOrganisation).not.toHaveBeenCalled();
  });
});
