import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { toInviteRecord } from '../../src/services/team-invite.service.base.js';
import { getTeamInvite } from '../../src/services/team-invite.service.management.js';
import { AppError } from '../../src/utils/errors.js';

// The by-id read never writes, so nothing here should reach the audit client; a `create` call on
// this mock would mean the read grew a side effect.
const orgAuditLog = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: () => {
    throw new Error('getPrisma() must not be reached: every test injects deps.prisma');
  },
  getAdminPrisma: () => ({ orgAuditLog }),
  connectPrisma: async () => {},
  disconnectPrisma: async () => {},
}));

const NOW = new Date('2026-08-15T12:00:00.000Z');

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

function makeInviteRow(overrides?: Record<string, unknown>) {
  return {
    id: 'invite-1',
    orgId: 'org-1',
    teamId: 'team-1',
    email: 'new.hire@example.com',
    inviteName: 'New Hire',
    teamRole: 'member',
    redirectUrl: null,
    invitedByUserId: 'inviter-1',
    invitedByName: 'Team Owner',
    invitedByEmail: 'owner@example.com',
    acceptedUserId: null,
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    revokedReason: null,
    openedAt: null,
    openCount: 0,
    lastSentAt: NOW,
    expiresAt: new Date('2026-09-14T12:00:00.000Z'),
    approvalStatus: 'NOT_REQUIRED',
    requestedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePrisma(invite: ReturnType<typeof makeInviteRow> | null = makeInviteRow()) {
  return {
    organisation: {
      findFirst: vi.fn().mockImplementation((args: { where: { domain: string } }) =>
        Promise.resolve(
          args.where.domain === 'client.example.com'
            ? {
                id: 'org-1',
                domain: 'client.example.com',
                name: 'Acme',
                slug: 'acme',
                ownerId: 'owner-1',
                memberInvites: 'allowed',
                iconUrl: null,
                createdAt: NOW,
                updatedAt: NOW,
              }
            : null,
        ),
      ),
    },
    team: {
      findFirst: vi.fn().mockResolvedValue({ id: 'team-1', name: 'Core Team' }),
    },
    teamInvite: {
      findFirst: vi.fn().mockResolvedValue(invite),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    verificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as PrismaClient;
}

const deps = (prisma: PrismaClient) => ({
  env: makeEnv(),
  prisma,
  now: () => NOW,
});

const params = {
  orgId: 'org-1',
  teamId: 'team-1',
  inviteId: 'invite-1',
  domain: 'client.example.com',
};

describe('getTeamInvite (GET .../teams/:teamId/invitations/:inviteId)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the invitation in exactly the record shape the list serializes', async () => {
    const row = makeInviteRow();
    const prisma = makePrisma(row);

    const record = await getTeamInvite(params, deps(prisma));

    // Byte-for-byte the list's own projection — one shape, derived once, for both endpoints.
    expect(record).toEqual(toInviteRecord(row, NOW, 'client.example.com'));
    expect(record.id).toBe('invite-1');
    expect(record.status).toBe('pending');
    expect(record.approvalStatus).toBe('not_required');
    // Avatar base URL comes from the process env (Docs/Auth/avatars.md §9), so pin the path, not
    // the origin: the invitee's own email never gets one, the inviter does.
    expect(record.invitedByAvatarImageUrl).toContain(
      '/domain/users/inviter-1/avatar?domain=client.example.com',
    );
    expect(record.acceptedAvatarImageUrl).toBeNull();
  });

  it('scopes the lookup to the resolved org and team, and writes nothing', async () => {
    const prisma = makePrisma();

    await getTeamInvite(params, deps(prisma));

    expect(prisma.teamInvite.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invite-1', orgId: 'org-1', teamId: 'team-1' },
      }),
    );
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(prisma.teamInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    expect(orgAuditLog.create).not.toHaveBeenCalled();
  });

  it('derives the same terminal statuses the list does (revoked, replaced, expired)', async () => {
    const revoked = await getTeamInvite(
      params,
      deps(makePrisma(makeInviteRow({ revokedAt: NOW, revokedReason: 'REVOKED' }))),
    );
    expect(revoked.status).toBe('revoked');

    const replaced = await getTeamInvite(
      params,
      deps(makePrisma(makeInviteRow({ revokedAt: NOW, revokedReason: 'REPLACED' }))),
    );
    expect(replaced.status).toBe('replaced');

    const expired = await getTeamInvite(
      params,
      deps(makePrisma(makeInviteRow({ expiresAt: new Date('2026-08-01T00:00:00.000Z') }))),
    );
    expect(expired.status).toBe('expired');
  });

  it('unknown invite id: generic 404 carrying no specific reason', async () => {
    const prisma = makePrisma(null);

    await expect(
      getTeamInvite({ ...params, inviteId: 'invite-does-not-exist' }, deps(prisma)),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'NOT_FOUND' });
  });

  it("an invitation on another team of the same org: the same generic 404", async () => {
    // The org/team resolve fine; the invite row simply does not match the (org, team, id) triple.
    const prisma = makePrisma(null);

    await expect(getTeamInvite({ ...params, teamId: 'team-1' }, deps(prisma))).rejects.toBeInstanceOf(
      AppError,
    );
    expect(prisma.teamInvite.findFirst).toHaveBeenCalledTimes(1);
  });

  it("cross-domain: another domain's org resolves to the same generic 404", async () => {
    const prisma = makePrisma();

    await expect(
      getTeamInvite({ ...params, domain: 'other.example.com' }, deps(prisma)),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Refused at org resolution — the invite row is never read, so nothing about it can leak.
    expect(prisma.teamInvite.findFirst).not.toHaveBeenCalled();
  });

  it('unknown team: generic 404 before the invite is read', async () => {
    const prisma = makePrisma();
    prisma.team.findFirst.mockResolvedValue(null);

    await expect(
      getTeamInvite({ ...params, teamId: 'team-elsewhere' }, deps(prisma)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.teamInvite.findFirst).not.toHaveBeenCalled();
  });
});
