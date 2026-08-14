import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  approveInvite,
  denyInvite,
  listPendingApprovalInvites,
} from '../../src/services/team-invite.service.member.js';
import { testUiTheme } from '../helpers/test-config.js';

// A2.1a approval-contract tests for the member service slice. Distinct from
// team-invite-member.service.test.ts (the 502-line Phase-4 behaviour suite,
// deliberately untouched): this file pins the contract-alignment guarantees —
// the actionable+PENDING+unexpired list predicate, the legacy owner-role rail,
// the terminal-row guard, and the expired-PENDING deny allowance.

const NOW = new Date('2026-04-01T00:00:00.000Z');
const FUTURE = new Date('2026-05-01T00:00:00.000Z');
const PAST = new Date('2026-03-01T00:00:00.000Z');

function makeConfig(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
    org_features: {
      enabled: true,
      groups_enabled: false,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
    },
  } as ClientConfig;
}

function makeEnv() {
  return {
    NODE_ENV: 'test' as const,
    HOST: '127.0.0.1',
    PORT: 3000,
    PUBLIC_BASE_URL: 'https://auth.example.com',
    LOG_LEVEL: 'info' as const,
    SHARED_SECRET: 'test-shared-secret-with-enough-length',
    AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
    DATABASE_URL: 'postgres://example.invalid/db',
    ACCESS_TOKEN_TTL: '30m',
    LOG_RETENTION_DAYS: 90,
    AI_TRANSLATION_PROVIDER: 'disabled' as const,
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
  };
}

type InviteRow = {
  id: string;
  orgId: string;
  teamId: string;
  email: string;
  inviteName: string | null;
  teamRole: string;
  redirectUrl: string | null;
  invitedByUserId: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  acceptedUserId: string | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  revokedAt: Date | null;
  openedAt: Date | null;
  openCount: number;
  lastSentAt: Date;
  expiresAt: Date | null;
  approvalStatus: string;
  requestedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  team?: { id: string; name: string };
  org?: { name: string; domain: string };
};

function makeInviteRow(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: 'invite-1',
    orgId: 'org-1',
    teamId: 'team-1',
    email: 'pending@example.com',
    inviteName: null,
    teamRole: 'member',
    redirectUrl: null,
    invitedByUserId: 'member-1',
    invitedByName: null,
    invitedByEmail: null,
    acceptedUserId: null,
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    openedAt: null,
    openCount: 0,
    lastSentAt: NOW,
    expiresAt: FUTURE,
    approvalStatus: 'PENDING',
    requestedByUserId: 'member-1',
    createdAt: NOW,
    updatedAt: NOW,
    // Present on every findOrgInviteOrThrow read (the select joins team/org);
    // harmless extra keys on the findMany list rows.
    team: { id: 'team-1', name: 'Core Team' },
    org: { name: 'Acme', domain: 'client.example.com' },
    ...overrides,
  };
}

/**
 * Small local fake that enforces the WHERE contract instead of parroting a
 * fixed resolved value: findMany filters the seeded rows through the exact
 * partial-index predicate (acceptedAt/declinedAt/revokedAt null, approval
 * not DENIED), explicit PENDING, and expiresAt null-or-after-now. If the
 * service's WHERE drifts (e.g. drops the terminal-timestamp pins or the
 * expiry window), the wrong rows qualify and these tests fail.
 */
function makePrisma(rows: InviteRow[] = []) {
  const teamInvite = {
    findFirst: vi.fn(async (args: { where: { id: string; orgId: string } }) => {
      return rows.find((r) => r.id === args.where.id && r.orgId === args.where.orgId) ?? null;
    }),
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const where = args.where;
      const now = (where.OR as Array<{ expiresAt: { gt: Date } | null }>)[1].expiresAt as {
        gt: Date;
      };
      return rows.filter((row) => {
        if (row.orgId !== where.orgId) return false;
        if (where.approvalStatus !== undefined && row.approvalStatus !== where.approvalStatus) {
          return false;
        }
        const notDenied = where.approvalStatus as { not?: string } | string;
        if (typeof notDenied === 'object' && notDenied?.not && row.approvalStatus === notDenied.not) {
          return false;
        }
        if (where.acceptedAt === null && row.acceptedAt) return false;
        if (where.declinedAt === null && row.declinedAt) return false;
        if (where.revokedAt === null && row.revokedAt) return false;
        if (row.expiresAt !== null && row.expiresAt.getTime() <= now.gt.getTime()) return false;
        return true;
      });
    }),
    update: vi.fn(async (args: { where: { id: string }; data: { approvalStatus: string } }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error('row not found');
      return { ...row, approvalStatus: args.data.approvalStatus };
    }),
  };

  return {
    organisation: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'org-1',
        domain: 'client.example.com',
        name: 'Acme',
      }),
    },
    teamInvite,
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    verificationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'token-row' }),
    },
    orgAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  } as unknown as PrismaClient;
}

const makeDeps = (prisma: PrismaClient) => ({
  env: makeEnv(),
  prisma,
  now: () => NOW,
  sharedSecret: 'test-shared-secret-with-enough-length',
  generateEmailToken: () => 'token-123',
  hashEmailToken: () => 'hash-123',
  sendTeamInviteEmail: vi.fn(async () => undefined),
});

describe('listPendingApprovalInvites contract (A2.1a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the actionable predicate, explicit PENDING, and the expiry null-or-after-now filter to Prisma', async () => {
    const prisma = makePrisma([]);
    await listPendingApprovalInvites(
      { orgId: 'org-1', domain: 'client.example.com' },
      makeDeps(prisma),
    );

    expect(prisma.teamInvite.findMany).toHaveBeenCalledTimes(1);
    const where = (prisma.teamInvite.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .where as Record<string, unknown>;
    // Partial-index predicate (spread first): terminal rows can never surface.
    expect(where.acceptedAt).toBeNull();
    expect(where.declinedAt).toBeNull();
    expect(where.revokedAt).toBeNull();
    // Explicit PENDING overrides the predicate's `not DENIED` clause.
    expect(where.approvalStatus).toBe('PENDING');
    // Unexpired-or-never-expires window pinned to the injected clock.
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: NOW } }]);
    expect(where.orgId).toBe('org-1');
  });

  it('excludes approved/not-required/denied/accepted/declined/revoked/expired invitations', async () => {
    const rows = [
      makeInviteRow({ id: 'inv-pending', email: 'pending@example.com' }),
      makeInviteRow({ id: 'inv-pending-never-expires', expiresAt: null }),
      makeInviteRow({ id: 'inv-approved', approvalStatus: 'APPROVED' }),
      makeInviteRow({ id: 'inv-not-required', approvalStatus: 'NOT_REQUIRED' }),
      makeInviteRow({ id: 'inv-denied', approvalStatus: 'DENIED' }),
      makeInviteRow({ id: 'inv-accepted', acceptedAt: NOW, acceptedUserId: 'user-1' }),
      makeInviteRow({ id: 'inv-declined', declinedAt: NOW }),
      makeInviteRow({ id: 'inv-revoked', revokedAt: NOW }),
      // Legacy alignment leftover: still stamped PENDING but revoked — must not surface.
      makeInviteRow({ id: 'inv-legacy-revoked-pending', revokedAt: NOW }),
      makeInviteRow({ id: 'inv-expired', expiresAt: PAST }),
    ];
    const prisma = makePrisma(rows);

    const result = await listPendingApprovalInvites(
      { orgId: 'org-1', domain: 'client.example.com' },
      makeDeps(prisma),
    );

    expect(result.data.map((r) => r.id).sort()).toEqual([
      'inv-pending',
      'inv-pending-never-expires',
    ]);
  });
});

describe('approve/deny contract guards (A2.1a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const runApprove = (row: InviteRow) => {
    const prisma = makePrisma([row]);
    const deps = makeDeps(prisma);
    return {
      prisma,
      deps,
      promise: approveInvite(
        {
          orgId: 'org-1',
          domain: 'client.example.com',
          inviteId: row.id,
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          reviewerUserId: 'admin-1',
        },
        deps,
      ),
    };
  };

  const runDeny = (row: InviteRow) => {
    const prisma = makePrisma([row]);
    const deps = makeDeps(prisma);
    return {
      prisma,
      deps,
      promise: denyInvite(
        {
          orgId: 'org-1',
          domain: 'client.example.com',
          inviteId: row.id,
          reviewerUserId: 'admin-1',
        },
        deps,
      ),
    };
  };

  it.each([
    ['accepted', makeInviteRow({ acceptedAt: NOW, acceptedUserId: 'user-1' })],
    ['declined', makeInviteRow({ declinedAt: NOW })],
    ['revoked', makeInviteRow({ revokedAt: NOW })],
  ])('approve of a terminal (%s) PENDING row fails generically before teamInvite.update', async (_label, row) => {
    const { prisma, deps, promise } = runApprove(row);
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', makeInviteRow({ acceptedAt: NOW, acceptedUserId: 'user-1' })],
    ['declined', makeInviteRow({ declinedAt: NOW })],
    ['revoked', makeInviteRow({ revokedAt: NOW })],
  ])('deny of a terminal (%s) PENDING row fails generically before teamInvite.update', async (_label, row) => {
    const { prisma, promise } = runDeny(row);
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'NOT_REQUIRED', 'DENIED'])(
    'approve of a non-PENDING (%s) row fails generically before teamInvite.update',
    async (approvalStatus) => {
      const { prisma, deps, promise } = runApprove(makeInviteRow({ approvalStatus }));
      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(prisma.teamInvite.update).not.toHaveBeenCalled();
      expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
    },
  );

  it.each(['APPROVED', 'NOT_REQUIRED', 'DENIED'])(
    'deny of a non-PENDING (%s) row fails generically before teamInvite.update',
    async (approvalStatus) => {
      const { prisma, promise } = runDeny(makeInviteRow({ approvalStatus }));
      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    },
  );

  it('approve of a legacy owner-role PENDING row fails generically before teamInvite.update', async () => {
    const { prisma, deps, promise } = runApprove(makeInviteRow({ teamRole: 'owner' }));
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('deny of a legacy owner-role PENDING row fails generically before teamInvite.update', async () => {
    const { prisma, promise } = runDeny(makeInviteRow({ teamRole: 'owner' }));
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it('approve of an expired PENDING row fails generically before teamInvite.update', async () => {
    const { prisma, deps, promise } = runApprove(makeInviteRow({ expiresAt: PAST }));
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(deps.sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('deny of an expired unresolved PENDING member row remains allowed', async () => {
    const row = makeInviteRow({ teamRole: 'member', expiresAt: PAST });
    const { prisma, promise } = runDeny(row);

    const result = await promise;

    expect(result.approvalStatus).toBe('denied');
    expect(prisma.teamInvite.update).toHaveBeenCalledTimes(1);
    expect(prisma.teamInvite.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { approvalStatus: 'DENIED' },
      select: expect.any(Object),
    });
  });
});
