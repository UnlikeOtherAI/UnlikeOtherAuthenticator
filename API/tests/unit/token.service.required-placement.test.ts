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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-new' }]),
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
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-member' }]),
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

  it.each([
    { caseName: 'a DEACTIVATED organisation membership', orgStatus: 'DEACTIVATED' },
    { caseName: 'a REMOVED team membership', orgStatus: 'ACTIVE' },
  ])('preserves legacy unscoped login without healing around $caseName', async ({ orgStatus }) => {
    const createOrganisation = vi.fn();
    const createTeam = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-tombstone' }]),
      billingAppKey: { findMany: vi.fn() },
      clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'inactive' }) },
      organisation: { create: createOrganisation },
      orgMember: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'org-member-old',
          orgId: 'org-old',
          role: 'member',
          status: orgStatus,
        }),
      },
      team: { create: createTeam },
      teamMember: { count: vi.fn().mockResolvedValue(1) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          email: 'tombstone@example.com',
          id: 'user-tombstone',
          name: 'Tombstone User',
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      resolveRequiredAuthorizationWorkspace(
        {
          config: {
            ...makeConfig({ enabled: true, user_needs_team: true }),
            login_flow: { email_code_enabled: false, workspace_selection: 'off' },
          } as ClientConfig,
          userId: 'user-tombstone',
        },
        { prisma, workspacePrisma: prisma },
      ),
    ).resolves.toBeNull();
    expect(createOrganisation).not.toHaveBeenCalled();
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('preserves a legacy off-flow as unscoped when an active team already satisfies placement', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      billingAppKey: { findMany: vi.fn().mockResolvedValue([]) },
      clientDomain: { findUnique: vi.fn().mockResolvedValue({ status: 'active' }) },
      organisation: { create: vi.fn() },
      orgMember: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'org-member-existing',
          orgId: 'org-existing',
          role: 'member',
          status: 'ACTIVE',
        }),
      },
      team: { create: vi.fn() },
      teamMember: { count: vi.fn().mockResolvedValue(1) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          email: 'existing@example.com',
          id: 'user-existing',
          name: 'Existing User',
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      resolveRequiredAuthorizationWorkspace(
        {
          config: {
            ...makeConfig({ enabled: true, user_needs_team: true }),
            login_flow: { email_code_enabled: false, workspace_selection: 'off' },
          } as ClientConfig,
          userId: 'user-existing',
        },
        { prisma, workspacePrisma: prisma },
      ),
    ).resolves.toBeNull();
    expect(prisma.organisation.create).not.toHaveBeenCalled();
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it('serializes simultaneous product placement and makes the loser reuse the winner workspace', async () => {
    type Workspace = { domain: string; orgId: string; teamId: string };
    let workspace: Workspace | null = null;
    let createCount = 0;
    let lockOwner: string | null = null;
    let nextLock: (() => void) | null = null;
    const firstLocked = deferred();
    const secondQueued = deferred();
    const continueFirst = deferred();

    const releaseLock = (owner: string): void => {
      expect(lockOwner).toBe(owner);
      lockOwner = null;
      const next = nextLock;
      nextLock = null;
      next?.();
    };

    function productConfig(domain: string): ClientConfig {
      return {
        ...makeConfig({ enabled: true, user_needs_team: true }),
        domain,
        login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      } as ClientConfig;
    }

    function makeTransaction(id: 'first' | 'second', domain: string): PrismaClient {
      let firstPolicyRead = true;
      const choiceRow = (): Array<{
        teamId: string;
        teamRole: string;
        team: { iconUrl: null; name: string; orgId: string; slug: string };
      }> =>
        workspace
          ? [
              {
                teamId: workspace.teamId,
                teamRole: 'admin',
                team: {
                  iconUrl: null,
                  name: 'Personal team',
                  orgId: workspace.orgId,
                  slug: 'personal-team',
                },
              },
            ]
          : [];

      return {
        $queryRaw: vi.fn(async () => {
          if (lockOwner === id) return [{ id: 'user-race' }];
          if (lockOwner === null) {
            lockOwner = id;
            if (id === 'first') firstLocked.resolve();
            return [{ id: 'user-race' }];
          }
          secondQueued.resolve();
          await new Promise<void>((resolve) => {
            nextLock = () => {
              lockOwner = id;
              resolve();
            };
          });
          return [{ id: 'user-race' }];
        }),
        billingAppKey: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ serviceId: `svc-${domain}`, service: { identifier: domain } }]),
        },
        clientDomain: {
          findUnique: vi.fn(async () => {
            if (id === 'first' && firstPolicyRead) {
              firstPolicyRead = false;
              await continueFirst.promise;
            }
            return { status: 'active' };
          }),
        },
        organisation: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(async () => {
            createCount += 1;
            return { id: 'org-race' };
          }),
        },
        orgMember: {
          create: vi.fn().mockResolvedValue({ id: 'org-member-race' }),
          findFirst: vi.fn(
            async (args: { where: { org?: { domain?: string }; orgId?: string } }) => {
              if (!workspace) return null;
              if (args.where.org?.domain && args.where.org.domain !== workspace.domain) return null;
              if (args.where.orgId && args.where.orgId !== workspace.orgId) return null;
              return {
                id: 'org-member-race',
                orgId: workspace.orgId,
                role: 'owner',
                status: 'ACTIVE',
              };
            },
          ),
        },
        team: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'team-race' }),
        },
        teamInvite: { findMany: vi.fn().mockResolvedValue([]) },
        teamMember: {
          create: vi.fn(async () => {
            workspace = { domain, orgId: 'org-race', teamId: 'team-race' };
            return { id: 'team-member-race' };
          }),
          findFirst: vi.fn(
            async (args: {
              where: { team?: { org?: { domain?: string }; orgId?: string }; teamId?: string };
            }) => {
              if (!workspace) return null;
              if (args.where.team?.org?.domain && args.where.team.org.domain !== workspace.domain) {
                return null;
              }
              if (args.where.team?.orgId && args.where.team.orgId !== workspace.orgId) return null;
              if (args.where.teamId && args.where.teamId !== workspace.teamId) return null;
              return { id: 'team-member-race' };
            },
          ),
          findMany: vi.fn(
            async (args: {
              where: { team?: { org?: { domain?: string; members?: unknown } } };
            }) => {
              if (!workspace) return [];
              const orgFilter = args.where.team?.org;
              if (orgFilter?.domain && orgFilter.domain !== workspace.domain) return [];
              return choiceRow();
            },
          ),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue({
            email: 'race@example.com',
            id: 'user-race',
            name: 'Race User',
          }),
        },
      } as unknown as PrismaClient;
    }

    const firstTx = makeTransaction('first', 'api.deeptest.live');
    const secondTx = makeTransaction('second', 'api.deepsignal.live');
    const first = resolveRequiredAuthorizationWorkspace(
      { config: productConfig('api.deeptest.live'), userId: 'user-race' },
      { prisma: firstTx, workspacePrisma: firstTx },
    );
    await firstLocked.promise;
    const second = resolveRequiredAuthorizationWorkspace(
      { config: productConfig('api.deepsignal.live'), userId: 'user-race' },
      { prisma: secondTx, workspacePrisma: secondTx },
    );
    await secondQueued.promise;
    expect(createCount).toBe(0);

    continueFirst.resolve();
    const firstResult = await first;
    releaseLock('first');
    const secondResult = await second;
    releaseLock('second');

    expect(firstResult).toEqual({ orgId: 'org-race', teamId: 'team-race' });
    expect(secondResult).toEqual(firstResult);
    expect(createCount).toBe(1);
  });
});
