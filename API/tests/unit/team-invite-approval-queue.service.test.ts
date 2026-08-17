import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { toInviteRecord } from '../../src/services/team-invite.service.base.js';
import { approveInvite, denyInvite } from '../../src/services/team-invite.service.member.js';
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
