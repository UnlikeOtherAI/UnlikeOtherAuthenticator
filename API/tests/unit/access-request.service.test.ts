import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  approveAccessRequest,
  handlePostAuthenticationAccessRequest,
  rejectAccessRequest,
} from '../../src/services/access-request.service.js';
import { testUiTheme } from '../helpers/test-config.js';

function makeConfig(overrides?: Partial<ClientConfig>): ClientConfig {
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
    access_requests: {
      enabled: true,
      target_org_id: 'org-1',
      target_team_id: 'team-1',
      auto_grant_domains: ['example.com'],
      notify_org_roles: ['owner', 'admin'],
      admin_review_url: 'https://admin.example.com/review',
    },
    ...overrides,
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

function makeAccessRequestRow(overrides?: Record<string, unknown>) {
  return {
    id: 'request-1',
    orgId: 'org-1',
    teamId: 'team-1',
    email: 'alex@example.com',
    requestName: 'Alex Example',
    status: 'PENDING',
    requestedAt: new Date('2026-03-28T10:00:00.000Z'),
    lastRequestedAt: new Date('2026-03-28T10:00:00.000Z'),
    reviewedAt: null,
    reviewReason: null,
    notifiedAt: new Date('2026-03-28T10:00:00.000Z'),
    createdAt: new Date('2026-03-28T10:00:00.000Z'),
    updatedAt: new Date('2026-03-28T10:00:00.000Z'),
    userId: 'user-1',
    reviewedByUserId: null,
    ...overrides,
  };
}

function makePrisma() {
  return {
    organisation: {
      findFirst: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    teamMember: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    orgMember: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    accessRequest: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaClient;
}

describe('access request services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-grants users whose verified email domain matches the configured allowlist', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'client.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      name: 'Core Team',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'alex@example.com',
      name: 'Alex Example',
    });
    prisma.teamMember.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.create.mockResolvedValue({ id: 'org-member-1' });
    prisma.teamMember.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    prisma.teamMember.create.mockResolvedValue({ id: 'team-member-1' });

    const sendAccessRequestNotificationEmail = vi.fn(async () => undefined);

    const result = await handlePostAuthenticationAccessRequest(
      {
        userId: 'user-1',
        config: makeConfig(),
      },
      {
        env: makeEnv(),
        prisma,
        now: () => new Date('2026-03-28T10:00:00.000Z'),
        sendAccessRequestNotificationEmail,
      },
    );

    expect(result).toEqual({ status: 'continue' });
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-1',
        userId: 'user-1',
        teamRole: 'member',
      },
      select: { id: true },
    });
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(sendAccessRequestNotificationEmail).not.toHaveBeenCalled();
  });

  it('creates or refreshes a pending request and emails configured reviewers when auto-grant does not apply', async () => {
    const prisma = makePrisma();
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'client.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      name: 'Core Team',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'alex@outside.test',
      name: 'Alex Example',
    });
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.accessRequest.findFirst.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue(
      makeAccessRequestRow({ email: 'alex@outside.test' }),
    );
    prisma.orgMember.findMany.mockResolvedValue([
      { user: { email: 'owner@example.com' } },
      { user: { email: 'admin@example.com' } },
    ]);

    const sendAccessRequestNotificationEmail = vi.fn(async () => undefined);

    const result = await handlePostAuthenticationAccessRequest(
      {
        userId: 'user-1',
        config: makeConfig(),
      },
      {
        env: makeEnv(),
        prisma,
        now: () => new Date('2026-03-28T10:00:00.000Z'),
        sendAccessRequestNotificationEmail,
      },
    );

    expect(result).toMatchObject({
      status: 'requested',
      request: {
        id: 'request-1',
        email: 'alex@outside.test',
        status: 'pending',
      },
    });
    expect(prisma.accessRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'alex@outside.test',
        userId: 'user-1',
        requestName: 'Alex Example',
      }),
      select: expect.any(Object),
    });
    expect(sendAccessRequestNotificationEmail).toHaveBeenCalledTimes(2);
    expect(sendAccessRequestNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.com',
        reviewUrl: 'https://admin.example.com/review',
        requesterEmail: 'alex@outside.test',
        requesterName: 'Alex Example',
        organisationName: 'Acme',
        teamName: 'Core Team',
      }),
    );
  });

  it('approves a pending request and adds the requester to the configured team', async () => {
    const prisma = makePrisma();
    prisma.accessRequest.findFirst.mockResolvedValueOnce(makeAccessRequestRow());
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'client.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      name: 'Core Team',
    });
    prisma.orgMember.findFirst.mockResolvedValue(null);
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.create.mockResolvedValue({ id: 'org-member-1' });
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.teamMember.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    prisma.teamMember.create.mockResolvedValue({ id: 'team-member-1' });
    prisma.accessRequest.update.mockResolvedValue(
      makeAccessRequestRow({
        status: 'APPROVED',
        reviewedAt: new Date('2026-03-28T11:00:00.000Z'),
        reviewedByUserId: 'reviewer-1',
        reviewReason: 'Approved by admin',
      }),
    );

    const result = await approveAccessRequest(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        requestId: 'request-1',
        config: makeConfig(),
        reviewedByUserId: 'reviewer-1',
        reviewReason: 'Approved by admin',
      },
      {
        env: makeEnv(),
        prisma,
        now: () => new Date('2026-03-28T11:00:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      id: 'request-1',
      status: 'approved',
      reviewedByUserId: 'reviewer-1',
      reviewReason: 'Approved by admin',
    });
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-1',
        userId: 'user-1',
        teamRole: 'member',
      },
      select: { id: true },
    });
  });

  it('rejects a pending request without adding memberships', async () => {
    const prisma = makePrisma();
    prisma.accessRequest.findFirst.mockResolvedValueOnce(makeAccessRequestRow());
    prisma.accessRequest.update.mockResolvedValue(
      makeAccessRequestRow({
        status: 'REJECTED',
        reviewedAt: new Date('2026-03-28T11:30:00.000Z'),
        reviewedByUserId: 'reviewer-2',
        reviewReason: 'Not approved',
      }),
    );

    const result = await rejectAccessRequest(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        requestId: 'request-1',
        config: makeConfig(),
        reviewedByUserId: 'reviewer-2',
        reviewReason: 'Not approved',
      },
      {
        env: makeEnv(),
        prisma,
        now: () => new Date('2026-03-28T11:30:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      id: 'request-1',
      status: 'rejected',
      reviewedByUserId: 'reviewer-2',
      reviewReason: 'Not approved',
    });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });
});
