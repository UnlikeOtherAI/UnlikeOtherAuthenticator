import { describe, expect, it, vi } from 'vitest';

import {
  buildSidebarPendingInvites,
  buildSidebarTeams,
} from '../../src/services/team-directory.service.js';

// Gap-fix A Task 1 (design §11.4 sidebar contract): `GET /org/me`'s `teams[]` and
// `pending_invites[]` enrichment. Mock-prisma, mirroring org-context.service.test.ts.

function makeTeamsPrisma(overrides: {
  teamMemberFindMany: unknown[];
  refreshTokenGroupBy?: unknown[];
}) {
  return {
    teamMember: {
      findMany: vi.fn(async () => overrides.teamMemberFindMany),
    },
    refreshToken: {
      groupBy: vi.fn(async () => overrides.refreshTokenGroupBy ?? []),
    },
    user: {
      findUnique: vi.fn(),
    },
    teamInvite: {
      findMany: vi.fn(),
    },
  };
}

describe('team-directory service: buildSidebarTeams', () => {
  it('only queries and returns ACTIVE team memberships', async () => {
    const prisma = makeTeamsPrisma({
      teamMemberFindMany: [
        {
          teamId: 'team-1',
          teamRole: 'owner',
          team: {
            orgId: 'org-1',
            name: 'Backend',
            slug: 'backend',
            iconUrl: 'https://cdn.example.com/backend.png',
            org: { name: 'Acme Inc' },
          },
        },
      ],
    });

    const result = await buildSidebarTeams(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(prisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          status: 'ACTIVE',
          team: { org: { domain: 'acme.example.com' } },
        },
      }),
    );
    expect(result).toEqual([
      {
        teamId: 'team-1',
        orgId: 'org-1',
        name: 'Backend',
        slug: 'backend',
        orgName: 'Acme Inc',
        iconUrl: 'https://cdn.example.com/backend.png',
        avatarImageUrl: '/teams/team-1/avatar',
        role: 'owner',
        lastLoginAt: null,
      },
    ]);
  });

  it('sets lastLoginAt to null when no scoped refresh-token session was ever opened', async () => {
    const prisma = makeTeamsPrisma({
      teamMemberFindMany: [
        {
          teamId: 'team-1',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Solo', slug: 'solo', iconUrl: null, org: { name: 'Acme' } },
        },
      ],
      refreshTokenGroupBy: [],
    });

    const result = await buildSidebarTeams(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result[0].lastLoginAt).toBeNull();
  });

  it('orders lastLoginAt DESC with nulls last, then name ASC', async () => {
    const recent = new Date('2026-07-01T00:00:00.000Z');
    const older = new Date('2026-06-01T00:00:00.000Z');

    const prisma = makeTeamsPrisma({
      teamMemberFindMany: [
        {
          teamId: 'team-zzz-null',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Zzz No Login', slug: 'zzz', iconUrl: null, org: { name: 'Acme' } },
        },
        {
          teamId: 'team-older',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Older Login', slug: 'older', iconUrl: null, org: { name: 'Acme' } },
        },
        {
          teamId: 'team-aaa-null',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Aaa No Login', slug: 'aaa', iconUrl: null, org: { name: 'Acme' } },
        },
        {
          teamId: 'team-recent',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Recent Login', slug: 'recent', iconUrl: null, org: { name: 'Acme' } },
        },
      ],
      refreshTokenGroupBy: [
        { teamId: 'team-recent', _max: { createdAt: recent } },
        { teamId: 'team-older', _max: { createdAt: older } },
      ],
    });

    const result = await buildSidebarTeams(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result.map((entry) => entry.teamId)).toEqual([
      'team-recent',
      'team-older',
      'team-aaa-null',
      'team-zzz-null',
    ]);
  });

  it('returns an empty array without querying refresh tokens when there are no ACTIVE memberships', async () => {
    const prisma = makeTeamsPrisma({ teamMemberFindMany: [] });

    const result = await buildSidebarTeams(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result).toEqual([]);
    expect(prisma.refreshToken.groupBy).not.toHaveBeenCalled();
  });

  it('uses the complete active team directory only for an all-memberships product policy', async () => {
    const prisma = makeTeamsPrisma({
      teamMemberFindMany: [
        {
          teamId: 'team-local',
          teamRole: 'member',
          team: { orgId: 'org-local', name: 'Local', slug: 'local', iconUrl: null, org: { name: 'Local org' } },
        },
      ],
    });
    const crossProductPrisma = {
      teamMember: {
        findMany: vi.fn(async () => [
          {
            teamId: 'team-local',
            teamRole: 'member',
            team: { orgId: 'org-local', name: 'Local', slug: 'local', iconUrl: null, org: { name: 'Local org' } },
          },
          {
            teamId: 'team-other',
            teamRole: 'owner',
            team: { orgId: 'org-other', name: 'Other', slug: 'other', iconUrl: null, org: { name: 'Other org' } },
          },
        ]),
      },
    };

    const result = await buildSidebarTeams(
      { userId: 'user-1', domain: 'acme.example.com' },
      {
        prisma,
        crossProductPrisma,
        policy: { scope: 'all_active_memberships', serviceId: 'service-1', product: 'nessie' },
      },
    );

    expect(result.map((team) => team.teamId)).toEqual(['team-local', 'team-other']);
    expect(result.map((team) => team.avatarImageUrl)).toEqual([
      '/teams/team-local/avatar',
      '/teams/team-other/avatar',
    ]);
    expect(result[1]?.lastLoginAt).toBeNull();
    expect(crossProductPrisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          status: 'ACTIVE',
          team: { org: { members: { some: { userId: 'user-1', status: 'ACTIVE' } } } },
        }),
      }),
    );
  });
});

describe('team-directory service: buildSidebarPendingInvites', () => {
  function inviteRow(overrides?: Record<string, unknown>) {
    return {
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      team: { name: 'Backend' },
      org: { name: 'Acme Inc', slug: 'acme' },
      invitedByName: 'Alice Admin',
      invitedByEmail: 'alice@acme.com',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function makeInvitePrisma(rows: unknown[]) {
    return { teamInvite: { findMany: vi.fn(async () => rows) } };
  }

  function makeDirectoryPrisma(email: string | null) {
    return {
      teamMember: { findMany: vi.fn() },
      refreshToken: { groupBy: vi.fn() },
      user: { findUnique: vi.fn(async () => (email === null ? null : { email })) },
      teamInvite: { findMany: vi.fn() },
    };
  }

  it('names the inviting organisation and excludes expired or unapproved invites', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const prisma = makeDirectoryPrisma('jane@acme.com');
    const invitePrisma = makeInvitePrisma([inviteRow()]);

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma, invitePrisma, now: () => now },
    );

    expect(result).toEqual([
      {
        inviteId: 'invite-1',
        orgId: 'org-1',
        orgName: 'Acme Inc',
        orgSlug: 'acme',
        teamId: 'team-1',
        teamName: 'Backend',
        invitedBy: 'Alice Admin',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);

    const where = invitePrisma.teamInvite.findMany.mock.calls[0]![0]!.where as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND[0]).toEqual({ email: 'jane@acme.com' });
    // The eligibility predicate keeps its own top-level OR (the expiry pair). Composing the
    // organisation reach as a sibling AND clause rather than a spread is what stops that OR
    // being overwritten — an expired invitation would otherwise come back.
    expect(where.AND[1]).toMatchObject({
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });
    // Domain-scoped product: every organisation on this domain, and nothing else. Crucially NOT
    // narrowed to the organisation the caller's access token is scoped to.
    expect(where.AND[2]).toEqual({ OR: [{ org: { domain: 'acme.example.com' } }] });
  });

  it('falls back to the inviter e-mail address when no name was recorded', async () => {
    const prisma = makeDirectoryPrisma('jane@acme.com');
    const invitePrisma = makeInvitePrisma([inviteRow({ invitedByName: null })]);

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma, invitePrisma },
    );

    expect(result[0]?.invitedBy).toBe('alice@acme.com');
  });

  it('reaches organisations of an all-memberships product beyond this domain', async () => {
    const prisma = makeDirectoryPrisma('jane@acme.com');
    const invitePrisma = makeInvitePrisma([
      inviteRow({ orgId: 'org-other', org: { name: 'Bravo Org', slug: 'bravo' } }),
    ]);

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      {
        prisma,
        invitePrisma,
        policy: { scope: 'all_active_memberships', serviceId: 'service-1', product: 'nessie' },
      },
    );

    expect(result[0]?.orgName).toBe('Bravo Org');
    const where = invitePrisma.teamInvite.findMany.mock.calls[0]![0]!.where as {
      AND: Record<string, unknown>[];
    };
    // Same reach as `buildSidebarTeams` under this policy: the domain's organisations plus the
    // ones the caller is already an ACTIVE member of, whichever domain founded them.
    expect(where.AND[2]).toEqual({
      OR: [
        { org: { domain: 'acme.example.com' } },
        { org: { members: { some: { userId: 'user-1', status: 'ACTIVE' } } } },
      ],
    });
  });

  it('returns an empty array when the user cannot be found', async () => {
    const prisma = makeDirectoryPrisma(null);
    const invitePrisma = makeInvitePrisma([]);

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma, invitePrisma },
    );

    expect(result).toEqual([]);
    expect(invitePrisma.teamInvite.findMany).not.toHaveBeenCalled();
  });
});
