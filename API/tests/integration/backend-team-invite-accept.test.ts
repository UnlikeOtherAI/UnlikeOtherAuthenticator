import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InviteApprovalStatus, InviteRevokedReason } from '@prisma/client';

import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
} from '../helpers/org-user-endpoints-helper.js';

const DOMAIN = 'backend-invite.example.com';
const CONFIG_URL = `https://${DOMAIN}/auth-config`;

describe.skipIf(!hasDatabase)('backend-mode team invitation acceptance', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let domainBearer: string | undefined;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalDebugEnabled = process.env.DEBUG_ENABLED;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    process.env.DEBUG_ENABLED = originalDebugEnabled;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.DEBUG_ENABLED = 'false';
    domainBearer = undefined;
    await handle.prisma.domainRole.deleteMany();
    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function stubConfig(backendOrgManagement: boolean): Promise<void> {
    const jwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { backend_org_management: backendOrgManagement },
      DOMAIN,
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(jwt, { status: 200 })));
  }

  function url(orgId: string, teamId: string, inviteId: string): string {
    return (
      `/org/organisations/${orgId}/teams/${teamId}/invitations/${inviteId}/accept` +
      `?domain=${encodeURIComponent(DOMAIN)}&config_url=${encodeURIComponent(CONFIG_URL)}`
    );
  }

  async function createDomainUser(email: string) {
    const user = await createTestUser(handle!, email);
    await handle!.prisma.domainRole.create({ data: { domain: DOMAIN, userId: user.id } });
    return user;
  }

  async function seedWorkspace(label: string) {
    const owner = await createDomainUser(`${label.toLowerCase()}-owner@example.com`);
    const org = await handle.prisma.organisation.create({
      data: {
        domain: DOMAIN,
        name: `${label} Org`,
        slug: `${label.toLowerCase()}-org`,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    await handle.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const team = await handle.prisma.team.create({
      data: {
        orgId: org.id,
        name: `${label} Team`,
        slug: `${label.toLowerCase()}-team`,
        isDefault: true,
      },
      select: { id: true },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: team.id, userId: owner.id, teamRole: 'owner' },
    });
    return { ownerId: owner.id, orgId: org.id, teamId: team.id };
  }

  async function seedInvite(params: {
    orgId: string;
    teamId: string;
    email: string;
    approvalStatus?: InviteApprovalStatus;
    expiresAt?: Date;
    revokedAt?: Date;
    revokedReason?: InviteRevokedReason;
    requestedByUserId?: string;
  }) {
    return await handle.prisma.teamInvite.create({
      data: {
        orgId: params.orgId,
        teamId: params.teamId,
        email: params.email,
        lastSentAt: new Date(),
        expiresAt: params.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        approvalStatus: params.approvalStatus,
        revokedAt: params.revokedAt,
        revokedReason: params.revokedReason,
        requestedByUserId: params.requestedByUserId,
      },
      select: { id: true },
    });
  }

  async function createBackendRequestState(backendOrgManagement = true) {
    await stubConfig(backendOrgManagement);
    if (!domainBearer) {
      domainBearer = await seedDomainSecret(handle.prisma, DOMAIN);
    }
    const app = await createApp();
    await app.ready();
    return { app, headers: { authorization: `Bearer ${domainBearer}` } };
  }

  it('creates both memberships, marks the invite accepted, and repeats as idempotent success', async () => {
    const workspace = await seedWorkspace('Happy');
    const invitee = await createDomainUser('happy-invitee@example.com');
    const invite = await seedInvite({
      orgId: workspace.orgId,
      teamId: workspace.teamId,
      email: 'happy-invitee@example.com',
    });
    const { app, headers } = await createBackendRequestState();

    try {
      const request = {
        method: 'POST' as const,
        url: url(workspace.orgId, workspace.teamId, invite.id),
        headers,
        payload: { userId: invitee.id },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        ok: true,
        orgId: workspace.orgId,
        teamId: workspace.teamId,
      });

      expect(
        await handle.prisma.orgMember.findUnique({
          where: { orgId_userId: { orgId: workspace.orgId, userId: invitee.id } },
          select: { role: true, status: true },
        }),
      ).toEqual({ role: 'member', status: 'ACTIVE' });
      expect(
        await handle.prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: workspace.teamId, userId: invitee.id } },
          select: { teamRole: true, status: true },
        }),
      ).toEqual({ teamRole: 'member', status: 'ACTIVE' });
      expect(
        await handle.prisma.teamInvite.findUniqueOrThrow({
          where: { id: invite.id },
          select: { acceptedUserId: true, acceptedAt: true },
        }),
      ).toEqual({ acceptedUserId: invitee.id, acceptedAt: expect.any(Date) });

      const repeat = await app.inject(request);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual(first.json());
      expect(
        await handle.prisma.orgMember.count({
          where: { orgId: workspace.orgId, userId: invitee.id },
        }),
      ).toBe(1);
      expect(
        await handle.prisma.teamMember.count({
          where: { teamId: workspace.teamId, userId: invitee.id },
        }),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('refuses a present user token and a config without backend_org_management', async () => {
    const workspace = await seedWorkspace('Guard');
    const invitee = await createDomainUser('guard-invitee@example.com');
    const invite = await seedInvite({
      orgId: workspace.orgId,
      teamId: workspace.teamId,
      email: 'guard-invitee@example.com',
    });

    const enabled = await createBackendRequestState(true);
    try {
      const response = await enabled.app.inject({
        method: 'POST',
        url: url(workspace.orgId, workspace.teamId, invite.id),
        headers: { ...enabled.headers, 'x-uoa-access-token': 'Bearer user-token' },
        payload: { userId: invitee.id },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Request failed' });
    } finally {
      await enabled.app.close();
    }

    const disabled = await createBackendRequestState(false);
    try {
      const response = await disabled.app.inject({
        method: 'POST',
        url: url(workspace.orgId, workspace.teamId, invite.id),
        headers: disabled.headers,
        payload: { userId: invitee.id },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Request failed' });
    } finally {
      await disabled.app.close();
    }
  });

  it('publishes ORG_CONFLICT_ON_DOMAIN when retrying can never resolve the acceptance', async () => {
    const existing = await seedWorkspace('Existing');
    const target = await seedWorkspace('Target');
    const invitee = await createDomainUser('conflict-invitee@example.com');
    await handle.prisma.orgMember.create({
      data: { orgId: existing.orgId, userId: invitee.id, role: 'member' },
    });
    await handle.prisma.teamMember.create({
      data: { teamId: existing.teamId, userId: invitee.id, teamRole: 'member' },
    });
    const invite = await seedInvite({
      orgId: target.orgId,
      teamId: target.teamId,
      email: 'conflict-invitee@example.com',
    });
    const { app, headers } = await createBackendRequestState();

    try {
      const response = await app.inject({
        method: 'POST',
        url: url(target.orgId, target.teamId, invite.id),
        headers,
        payload: { userId: invitee.id },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Request failed',
        code: 'ORG_CONFLICT_ON_DOMAIN',
      });
      expect(
        await handle.prisma.teamInvite.findUniqueOrThrow({
          where: { id: invite.id },
          select: { acceptedAt: true, acceptedUserId: true },
        }),
      ).toEqual({ acceptedAt: null, acceptedUserId: null });
    } finally {
      await app.close();
    }
  });

  it('keeps invalid invite state and path bindings on the generic 400 body', async () => {
    const workspace = await seedWorkspace('Generic');
    const wrongTeam = await handle.prisma.team.create({
      data: { orgId: workspace.orgId, name: 'Wrong Team', slug: 'wrong-team' },
      select: { id: true },
    });
    const emailMismatchUser = await createDomainUser('mismatch-user@example.com');
    const revokedUser = await createDomainUser('revoked-user@example.com');
    const expiredUser = await createDomainUser('expired-user@example.com');
    const pendingUser = await createDomainUser('pending-user@example.com');

    const cases = [
      {
        label: 'email mismatch',
        userId: emailMismatchUser.id,
        invite: await seedInvite({
          orgId: workspace.orgId,
          teamId: workspace.teamId,
          email: 'different-email@example.com',
        }),
      },
      {
        label: 'revoked',
        userId: revokedUser.id,
        invite: await seedInvite({
          orgId: workspace.orgId,
          teamId: workspace.teamId,
          email: 'revoked-user@example.com',
          revokedAt: new Date(),
          revokedReason: 'REVOKED',
        }),
      },
      {
        label: 'expired',
        userId: expiredUser.id,
        invite: await seedInvite({
          orgId: workspace.orgId,
          teamId: workspace.teamId,
          email: 'expired-user@example.com',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      },
      {
        label: 'approval pending',
        userId: pendingUser.id,
        invite: await seedInvite({
          orgId: workspace.orgId,
          teamId: workspace.teamId,
          email: 'pending-user@example.com',
          approvalStatus: 'PENDING',
          requestedByUserId: workspace.ownerId,
        }),
      },
    ];
    const { app, headers } = await createBackendRequestState();

    try {
      for (const testCase of cases) {
        const response = await app.inject({
          method: 'POST',
          url: url(workspace.orgId, workspace.teamId, testCase.invite.id),
          headers,
          payload: { userId: testCase.userId },
        });
        expect(response.statusCode, testCase.label).toBe(400);
        expect(response.json(), testCase.label).toEqual({ error: 'Request failed' });
      }

      const pathMismatch = await app.inject({
        method: 'POST',
        url: url(workspace.orgId, wrongTeam.id, cases[0].invite.id),
        headers,
        payload: { userId: emailMismatchUser.id },
      });
      expect(pathMismatch.statusCode).toBe(400);
      expect(pathMismatch.json()).toEqual({ error: 'Request failed' });
    } finally {
      await app.close();
    }
  });
});
