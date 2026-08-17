import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import type { OrgActorProvenance } from '../../src/services/org-audit-log.service.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
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

/**
 * The verified client config `revokeTeamInvite` now takes — its capability gate resolves the
 * domain's `role_grants` out of it. No `org_features` block, so the legacy default table applies,
 * which is exactly what these tests assert against.
 */
function makeRevokeConfig(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
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
      findFirst: vi.fn().mockImplementation((args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === 'org-1'
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
        config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
          config: makeRevokeConfig(),
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
          config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
        config: makeRevokeConfig(),
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
          config: makeRevokeConfig(),
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
          config: makeRevokeConfig(),
        },
        deps(prisma),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // The org's origin is `client.example.com`; the caller arrives from another product's domain
  // holding an access token already scoped to this org. Membership, not origin, is the gate.
  it('another UOA-integrated product: the owner revokes the same invite, org resolved by id', async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'owner-1', 'owner');

    const result = await revokeTeamInvite(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        inviteId: 'invite-1',
        domain: 'other.example.com',
        actorUserId: 'owner-1',
        config: makeRevokeConfig(),
      },
      deps(prisma),
    );

    expect(result).toEqual({ ok: true });
    expect(prisma.organisation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-1' } }),
    );
  });

  it('another product, but the caller holds no ACTIVE membership: 403, nothing written', async () => {
    const prisma = makePrisma();
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.findFirst.mockResolvedValue(null);
    const params = {
      orgId: 'org-1',
      teamId: 'team-1',
      inviteId: 'invite-1',
      domain: 'other.example.com',
      actorUserId: 'outsider-1',
      config: makeRevokeConfig(),
    };

    await expect(revokeTeamInvite(params, deps(prisma))).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(orgAuditLog.create).not.toHaveBeenCalled();
  });

  it('unknown org id: still the same generic 404, and the invite is never read', async () => {
    const prisma = makePrisma();
    mockActiveOrgMember(prisma, 'owner-1', 'owner');
    const params = {
      orgId: 'org-elsewhere',
      teamId: 'team-1',
      inviteId: 'invite-1',
      domain: 'client.example.com',
      actorUserId: 'owner-1',
      config: makeRevokeConfig(),
    };

    await expect(revokeTeamInvite(params, deps(prisma))).rejects.toMatchObject({ statusCode: 404 });
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
          config: makeRevokeConfig(),
        },
        deps(prisma),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });
});
