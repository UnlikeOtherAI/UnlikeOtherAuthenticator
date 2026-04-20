import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  TeamMemberRecord,
  TeamInviteRecord,
  TeamRecord,
  TeamWithMembersRecord,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('user-facing /org team CRUD and membership', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) {
      throw new Error('DATABASE_URL is required for DB-backed tests');
    }

    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;

    if (handle) {
      await handle.cleanup();
    }
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;

    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('manages teams, team pagination, and team memberships', async () => {
    const domain = 'org-teams.example.com';
    const orgConfigUrl = 'https://org-teams.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const owner = await createTestUser(handle!, 'team-owner@example.com');
    const teamMember = await createTestUser(handle!, 'team-member@example.com');

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const ownerBaseToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const createOrg = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerBaseToken}`,
      },
      payload: { name: 'Acme Teams' },
    });
    expect(createOrg.statusCode).toBe(200);
    const org = createOrg.json() as { id: string; domain: string; name: string; slug: string };

    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: {
        orgId: org.id,
        orgRole: 'owner',
        teams: [],
        team_roles: {},
      },
    });

    const addMember = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { userId: teamMember.id },
    });
    expect(addMember.statusCode).toBe(200);

    const createdTeamIds: string[] = [];
    for (let i = 1; i <= 2; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${ownerToken}`,
        },
        payload: {
          name: `Project Team ${i}`,
          ...(i === 1 ? { slug: 'project-team-primary' } : {}),
          description: `Team ${i} for project users`,
        },
      });
      expect(res.statusCode).toBe(200);
      const created = res.json() as TeamRecord;
      expect(created.orgId).toBe(org.id);
      expect(created.slug).toBe(i === 1 ? 'project-team-primary' : `project-team-${i}`);
      createdTeamIds.push(created.id);
      expect(created.description).toBe(`Team ${i} for project users`);
    }

    const teamsFirst = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}&limit=2`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(teamsFirst.statusCode).toBe(200);
    const teamsFirstPage = teamsFirst.json() as { data: TeamRecord[]; next_cursor: string | null };
    expect(teamsFirstPage.data).toHaveLength(2);
    expect(teamsFirstPage.next_cursor).not.toBeNull();

    const teamById = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(teamById.statusCode).toBe(200);
    const team = teamById.json() as TeamWithMembersRecord;
    expect(team.id).toBe(createdTeamIds[0]);
    expect(team.slug).toBe('project-team-primary');
    expect(team.members).toHaveLength(0);

    const updateTeam = await app.inject({
      method: 'PUT',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { slug: 'project-team-renamed', description: 'Updated description' },
    });
    expect(updateTeam.statusCode).toBe(200);
    expect((updateTeam.json() as TeamRecord).description).toBe('Updated description');
    expect((updateTeam.json() as TeamRecord).slug).toBe('project-team-renamed');

    const createInvites = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/invitations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        redirectUrl: 'https://org-teams.example.com/oauth/callback',
        invitedBy: {
          userId: owner.id,
          name: 'Team Owner',
          email: 'team-owner@example.com',
        },
        invites: [
          {
            email: 'pending-user@example.com',
            name: 'Pending User',
          },
          {
            email: 'team-member@example.com',
            name: 'Existing Member',
            teamRole: 'lead',
          },
        ],
      },
    });
    expect(createInvites.statusCode).toBe(200);
    const inviteResponse = createInvites.json() as {
      results: Array<{ email: string; status: string; invite?: TeamInviteRecord }>;
    };
    expect(inviteResponse.results).toHaveLength(2);
    expect(inviteResponse.results.every((item) => item.status === 'invited')).toBe(true);

    const pendingInvites = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/invitations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
    });
    expect(pendingInvites.statusCode).toBe(200);
    const pendingList = pendingInvites.json() as { data: TeamInviteRecord[] };
    expect(pendingList.data).toHaveLength(2);
    expect(pendingList.data.some((invite) => invite.invitedByName === 'Team Owner')).toBe(true);

    const resendInvite = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/invitations/${pendingList.data[0].id}/resend?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
    });
    expect(resendInvite.statusCode).toBe(200);
    expect((resendInvite.json() as TeamInviteRecord).id).not.toBe(pendingList.data[0].id);

    const addTeamMember = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: {
        userId: teamMember.id,
        teamRole: 'lead',
      },
    });
    expect(addTeamMember.statusCode).toBe(200);

    const teamAfterAdd = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(teamAfterAdd.statusCode).toBe(200);
    const teamWithMember = teamAfterAdd.json() as TeamWithMembersRecord;
    const teamRoles = teamWithMember.members.map((member: TeamMemberRecord) => member.teamRole);
    expect(teamRoles).toContain('lead');
    expect(teamWithMember.members.some((member: TeamMemberRecord) => member.userId === teamMember.id)).toBe(true);

    const changeTeamRole = await app.inject({
      method: 'PUT',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/members/${teamMember.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
      payload: { teamRole: 'member' },
    });
    expect(changeTeamRole.statusCode).toBe(200);
    expect((changeTeamRole.json() as { teamRole: string }).teamRole).toBe('member');

    const removeTeamMember = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[0]}/members/${teamMember.id}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(removeTeamMember.statusCode).toBe(200);

    const deleteTeam = await app.inject({
      method: 'DELETE',
      url: `/org/organisations/${org.id}/teams/${createdTeamIds[1]}?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(orgConfigUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });
    expect(deleteTeam.statusCode).toBe(200);

    await app.close();
  });
});
