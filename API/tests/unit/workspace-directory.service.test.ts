import { describe, expect, it, vi } from 'vitest';

import {
  buildSidebarPendingInvites,
  buildSidebarWorkspaces,
} from '../../src/services/workspace-directory.service.js';

// Gap-fix A Task 1 (design §11.4 sidebar contract): `GET /org/me`'s `workspaces[]` and
// `pending_invites[]` enrichment. Mock-prisma, mirroring org-context.service.test.ts.

function makeWorkspacesPrisma(overrides: {
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

describe('workspace-directory service: buildSidebarWorkspaces', () => {
  it('only queries and returns ACTIVE team memberships', async () => {
    const prisma = makeWorkspacesPrisma({
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

    const result = await buildSidebarWorkspaces(
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
        role: 'owner',
        lastLoginAt: null,
      },
    ]);
  });

  it('sets lastLoginAt to null when no scoped refresh-token session was ever opened', async () => {
    const prisma = makeWorkspacesPrisma({
      teamMemberFindMany: [
        {
          teamId: 'team-1',
          teamRole: 'member',
          team: { orgId: 'org-1', name: 'Solo', slug: 'solo', iconUrl: null, org: { name: 'Acme' } },
        },
      ],
      refreshTokenGroupBy: [],
    });

    const result = await buildSidebarWorkspaces(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result[0].lastLoginAt).toBeNull();
  });

  it('orders lastLoginAt DESC with nulls last, then name ASC', async () => {
    const recent = new Date('2026-07-01T00:00:00.000Z');
    const older = new Date('2026-06-01T00:00:00.000Z');

    const prisma = makeWorkspacesPrisma({
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

    const result = await buildSidebarWorkspaces(
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
    const prisma = makeWorkspacesPrisma({ teamMemberFindMany: [] });

    const result = await buildSidebarWorkspaces(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result).toEqual([]);
    expect(prisma.refreshToken.groupBy).not.toHaveBeenCalled();
  });
});

describe('workspace-directory service: buildSidebarPendingInvites', () => {
  it('excludes expired invites and invites still awaiting member-invite approval', async () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const prisma = {
      teamMember: { findMany: vi.fn() },
      refreshToken: { groupBy: vi.fn() },
      user: { findUnique: vi.fn(async () => ({ email: 'jane@acme.com' })) },
      teamInvite: {
        findMany: vi.fn(async () => [
          {
            id: 'invite-1',
            teamId: 'team-1',
            team: { name: 'Backend' },
            invitedByName: 'Alice Admin',
            invitedByEmail: 'alice@acme.com',
            expiresAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]),
      },
    };

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma, now: () => now },
    );

    expect(result).toEqual([
      {
        inviteId: 'invite-1',
        teamId: 'team-1',
        teamName: 'Backend',
        invitedBy: 'Alice Admin',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    expect(prisma.teamInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: 'jane@acme.com',
          org: { domain: 'acme.example.com' },
          acceptedAt: null,
          declinedAt: null,
          revokedAt: null,
          // Task 1 uses the chooser's default eligibility (no PENDING approvals surfaced yet).
          approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
        }),
      }),
    );
  });

  it('returns an empty array when the user cannot be found', async () => {
    const prisma = {
      teamMember: { findMany: vi.fn() },
      refreshToken: { groupBy: vi.fn() },
      user: { findUnique: vi.fn(async () => null) },
      teamInvite: { findMany: vi.fn() },
    };

    const result = await buildSidebarPendingInvites(
      { userId: 'user-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result).toEqual([]);
    expect(prisma.teamInvite.findMany).not.toHaveBeenCalled();
  });
});
