import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { ensureUserHasRequiredTeam } from '../../src/services/user-team-requirement.service.js';

function makeConfig(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/auth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: {
      colors: {
        bg: '#ffffff',
        surface: '#ffffff',
        text: '#111111',
        muted: '#666666',
        primary: '#2563eb',
        primary_text: '#ffffff',
        border: '#dddddd',
        danger: '#dc2626',
        danger_text: '#ffffff',
      },
      radii: {
        card: '16px',
        button: '12px',
        input: '12px',
      },
      density: 'comfortable',
      typography: {
        font_family: 'sans',
        base_text_size: 'md',
      },
      button: {
        style: 'solid',
      },
      card: {
        style: 'bordered',
      },
      logo: {
        url: '',
        alt: 'Logo',
      },
    },
    language_config: 'en',
    org_features: {
      enabled: true,
      groups_enabled: false,
      user_needs_team: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
    },
  };
}

describe('ensureUserHasRequiredTeam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('creates a personal team and promotes the user to admin when they are in an org but have zero teams', async () => {
    const tx = {
      orgMember: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'org-member-1',
          orgId: 'org-1',
          role: 'member',
        }),
        update: vi.fn().mockResolvedValue({ id: 'org-member-1' }),
      },
      teamMember: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'team-member-1' }),
      },
      team: {
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'team-1' }),
      },
    };

    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'alice@example.com',
          name: 'Alice',
        }),
      },
      $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<void>) => await fn(tx)),
    } as unknown as PrismaClient;

    await ensureUserHasRequiredTeam(
      {
        userId: 'user-1',
        config: makeConfig(),
      },
      {
        env: { DATABASE_URL: 'postgres://example' } as never,
        prisma,
      },
    );

    expect(tx.team.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: 'org-1',
          name: "Alice's team",
          isDefault: false,
        }),
      }),
    );
    expect(tx.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          teamRole: 'lead',
        }),
      }),
    );
    expect(tx.orgMember.update).toHaveBeenCalledWith({
      where: { id: 'org-member-1' },
      data: { role: 'admin' },
    });
  });

  it('creates a personal org and default team when the user has no org on the domain', async () => {
    const tx = {
      orgMember: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'org-member-1' }),
      },
      organisation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'org-1' }),
      },
      team: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'team-1' }),
      },
      teamMember: {
        create: vi.fn().mockResolvedValue({ id: 'team-member-1' }),
      },
    };

    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'alice@example.com',
          name: 'Alice',
        }),
      },
      $transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<void>) => await fn(tx)),
    } as unknown as PrismaClient;

    await ensureUserHasRequiredTeam(
      {
        userId: 'user-1',
        config: makeConfig(),
      },
      {
        env: { DATABASE_URL: 'postgres://example' } as never,
        prisma,
      },
    );

    expect(tx.organisation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          domain: 'client.example.com',
          name: 'Alice',
          ownerId: 'user-1',
        }),
      }),
    );
    expect(tx.team.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: 'org-1',
          name: "Alice's team",
          isDefault: true,
        }),
      }),
    );
    expect(tx.orgMember.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        userId: 'user-1',
        role: 'owner',
      },
    });
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-1',
        userId: 'user-1',
        teamRole: 'lead',
      },
    });
  });
});
