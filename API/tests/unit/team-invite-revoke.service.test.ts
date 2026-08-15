import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import type { OrgActorProvenance } from '../../src/services/org-audit-log.service.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
import { toInviteRecord } from '../../src/services/team-invite.service.base.js';
import { approveInvite, denyInvite } from '../../src/services/team-invite.service.member.js';
import { revokeTeamInvite } from '../../src/services/team-invite.service.revoke.js';
import { AppError } from '../../src/utils/errors.js';
import { testUiTheme } from '../helpers/test-config.js';

// `auditOrg` writes best-effort through the BYPASSRLS admin client (design §4.10), so backend-mode
// provenance is asserted on this mock — the same convention as team.service.members.audit.test.ts.
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

const backendActor: OrgActorProvenance = {
  via: 'domain_backend',
  sourceDomain: 'client.example.com',
};

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
    inviteName: null,
    teamRole: 'member',
    redirectUrl: null,
    invitedByUserId: 'inviter-1',
    invitedByName: null,
    invitedByEmail: null,
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
    orgMember: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    teamMember: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    teamInvite: {
      findFirst: vi.fn().mockResolvedValue(invite),
      update: vi.fn().mockResolvedValue({ id: 'invite-1' }),
    },
    verificationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaClient;
}

const deps = (prisma: PrismaClient) => ({
  env: makeEnv(),
  prisma,
  now: () => NOW,
});

function mockActiveOrgMember(prisma: PrismaClient, userId: string, role: string): void {
  prisma.orgMember.findFirst.mockResolvedValue({
    id: `m-${userId}`,
    orgId: 'org-1',
    userId,
    role,
  });
}

describe('revokeTeamInvite (DELETE .../teams/:teamId/invitations/:inviteId)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('org owner: revokes a sent invite, stamps REVOKED, consumes tokens, audits', async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'owner-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: { revokedAt: NOW, revokedReason: 'REVOKED' },
      select: { id: true },
    });
    expect(prisma.verificationToken.updateMany).toHaveBeenCalledWith({
      where: { teamInviteId: 'invite-1', usedAt: null },
      data: { usedAt: NOW },
    });
    expect(orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'owner-1',
        action: 'invite.revoked',
        targetType: 'invite',
        targetId: 'invite-1',
      }),
    });
  });

  it('team admin (not an org manager): allowed via the shared team-manager check', async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'team-admin-1', 'member');
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'admin' });

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'team-admin-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).toHaveBeenCalledTimes(1);
  });

  it('original inviter (plain ACTIVE member): allowed', async () => {
    const prisma = makePrisma(makeInviteRow({ invitedByUserId: 'inviter-1' }));
    mockActiveOrgMember(prisma, 'inviter-1', 'member');
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'inviter-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).toHaveBeenCalledTimes(1);
  });

  it('plain member who is neither manager nor inviter: 403, nothing written', async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'member-1', 'member');
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-1',
          domain: 'client.example.com',
          actorUserId: 'member-1',
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(orgAuditLog.create).not.toHaveBeenCalled();
  });

  it('inviter whose org membership is no longer ACTIVE: 403', async () => {
    const prisma = makePrisma(makeInviteRow({ invitedByUserId: 'inviter-1' }));
    // activeOnly membership lookup answers null — deactivated/removed inviter.
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.findFirst.mockResolvedValue(null);

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-1',
          domain: 'client.example.com',
          actorUserId: 'inviter-1',
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it('backend mode: allowed with no acting user; audit row carries uoa_actor provenance', async () => {
    const prisma = makePrisma();

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actor: backendActor,
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    // The pairing outranks member roles — no membership lookups are needed at all.
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
    expect(orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: null,
        action: 'invite.revoked',
        metadata: expect.objectContaining({
          [ORG_AUDIT_ACTOR_METADATA_KEY]: {
            via: 'domain_backend',
            source_domain: 'client.example.com',
          },
        }),
      }),
    });
  });

  it('invite still awaiting member-invite approval (PENDING): revocable', async () => {
    const prisma = makePrisma(
      makeInviteRow({ approvalStatus: 'PENDING', requestedByUserId: 'member-9' }),
    );
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'owner-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).toHaveBeenCalledTimes(1);
  });

  it('already revoked: idempotent 200 with no second write and no second audit row', async () => {
    const prisma = makePrisma(
      makeInviteRow({ revokedAt: new Date('2026-08-01T00:00:00.000Z'), revokedReason: 'REVOKED' }),
    );
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'owner-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(prisma.verificationToken.updateMany).not.toHaveBeenCalled();
    expect(orgAuditLog.create).not.toHaveBeenCalled();
  });

  it('already declined: idempotent 200, the declined record stays untouched', async () => {
    const prisma = makePrisma(
      makeInviteRow({ declinedAt: new Date('2026-08-01T00:00:00.000Z') }),
    );
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'client.example.com',
        actorUserId: 'owner-1',
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it('already accepted: 409 INVITATION_ALREADY_ACCEPTED', async () => {
    const prisma = makePrisma(
      makeInviteRow({
        acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
        acceptedUserId: 'user-9',
      }),
    );
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-1',
          domain: 'client.example.com',
          actorUserId: 'owner-1',
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'INVITATION_ALREADY_ACCEPTED',
    });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it('unknown invite id: generic 404', async () => {
    const prisma = makePrisma(null);
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'missing',
          domain: 'client.example.com',
          actorUserId: 'owner-1',
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("cross-domain: another domain's org resolves to the same generic 404", async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-1',
          domain: 'other.example.com',
          actorUserId: 'owner-1',
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.teamInvite.findFirst).not.toHaveBeenCalled();
  });

  it('names neither an acting user nor a backend actor: loud 500, never an unattributed write', async () => {
    const prisma = makePrisma();

    await expect(
      revokeTeamInvite(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          inviteId: 'invite-1',
          domain: 'client.example.com',
        },
        deps(prisma),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });
});

describe('approval queue after revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    } as ClientConfig;
  }

  function makeApprovalPrisma() {
    const prisma = makePrisma(
      makeInviteRow({
        approvalStatus: 'PENDING',
        requestedByUserId: 'member-9',
        revokedAt: new Date('2026-08-10T00:00:00.000Z'),
        revokedReason: 'REVOKED',
      }),
    );
    // findOrgInviteOrThrow includes the team/org relations on the row.
    prisma.teamInvite.findFirst.mockResolvedValue({
      ...makeInviteRow({
        approvalStatus: 'PENDING',
        requestedByUserId: 'member-9',
        revokedAt: new Date('2026-08-10T00:00:00.000Z'),
        revokedReason: 'REVOKED',
      }),
      team: { id: 'team-1', name: 'Core Team' },
      org: { name: 'Acme', domain: 'client.example.com' },
    });
    return prisma;
  }

  it('approveInvite refuses a revoked invite instead of emailing a dead link', async () => {
    const prisma = makeApprovalPrisma();
    const sendTeamInviteEmail = vi.fn(async () => undefined);

    await expect(
      approveInvite(
        {
          orgId: 'org-1',
          domain: 'client.example.com',
          inviteId: 'invite-1',
          config: makeConfig(),
          configUrl: 'https://client.example.com/auth-config',
          reviewerUserId: 'owner-1',
        },
        { env: makeEnv(), prisma, now: () => NOW, sendTeamInviteEmail },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(sendTeamInviteEmail).not.toHaveBeenCalled();
  });

  it('denyInvite refuses a revoked invite instead of overwriting its record', async () => {
    const prisma = makeApprovalPrisma();

    await expect(
      denyInvite(
        {
          orgId: 'org-1',
          domain: 'client.example.com',
          inviteId: 'invite-1',
          reviewerUserId: 'owner-1',
        },
        { env: makeEnv(), prisma, now: () => NOW },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });
});

describe('derived invite status for revocation', () => {
  it('an explicitly revoked invite reads "revoked"; a replaced one keeps "replaced"', () => {
    const revoked = toInviteRecord(
      makeInviteRow({ revokedAt: NOW, revokedReason: 'REVOKED' }),
      NOW,
      'client.example.com',
    );
    const replaced = toInviteRecord(
      makeInviteRow({ revokedAt: NOW, revokedReason: 'REPLACED' }),
      NOW,
      'client.example.com',
    );
    // Pre-migration rows have no reason; the only writer of revokedAt until now was replacement.
    const legacy = toInviteRecord(
      makeInviteRow({ revokedAt: NOW, revokedReason: null }),
      NOW,
      'client.example.com',
    );

    expect(revoked.status).toBe('revoked');
    expect(replaced.status).toBe('replaced');
    expect(legacy.status).toBe('replaced');
  });
});
