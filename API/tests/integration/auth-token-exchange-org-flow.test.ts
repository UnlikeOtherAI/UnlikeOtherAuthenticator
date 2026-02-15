import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { jwtVerify } from 'jose';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  hasDatabase,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';

type OrgClaim = {
  org_id: string;
  org_role: string;
  teams: string[];
  team_roles: Record<string, string>;
  groups?: string[];
  group_admin?: string[];
};

describe.skipIf(!hasDatabase)('POST /auth/token with org context from org flow', () => {
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
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;

    await clearOrgTestDatabase(handle);
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('propagates org, default team, and team roles into the issued access token', async () => {
    const domain = 'client.example.com';
    const configUrl = 'https://client.example.com/auth-config';
    const password = 'Abcdef1!';

    const passwordHash = await hashPassword(password);
    const owner = await handle!.prisma.user.create({
      data: {
        email: 'org-owner-flow@example.com',
        userKey: 'org-owner-flow@example.com',
        passwordHash,
      },
      select: { id: true },
    });
    const member = await handle!.prisma.user.create({
      data: {
        email: 'org-member-flow@example.com',
        userKey: 'org-member-flow@example.com',
        passwordHash,
      },
      select: { id: true },
    });

    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const orgCreatorToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const domainHash = createClientId(domain, process.env.SHARED_SECRET!);
    const createOrgResponse = await app.inject({
      method: 'POST',
      url: `/org/organisations?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${orgCreatorToken}`,
      },
      payload: {
        name: 'Flow Org',
      },
    });
    expect(createOrgResponse.statusCode).toBe(200);
    const org = createOrgResponse.json() as { id: string };

    const defaultTeam = await handle!.prisma.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    expect(defaultTeam).not.toBeNull();

    const ownerOrgToken = await signAccessToken({
      subject: owner.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: {
        orgId: org.id,
        orgRole: 'owner',
        teams: [defaultTeam!.id],
        team_roles: {
          [defaultTeam!.id]: 'member',
        },
      },
    });

    const createTeamResponse = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerOrgToken}`,
      },
      payload: {
        name: 'Engineering',
      },
    });
    expect(createTeamResponse.statusCode).toBe(200);
    const team = createTeamResponse.json() as { id: string };

    const addMemberResponse = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerOrgToken}`,
      },
      payload: {
        userId: member.id,
      },
    });
    expect(addMemberResponse.statusCode).toBe(200);

    const addTeamMemberResponse = await app.inject({
      method: 'POST',
      url: `/org/organisations/${org.id}/teams/${team.id}/members?domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerOrgToken}`,
      },
      payload: {
        userId: member.id,
        teamRole: 'lead',
      },
    });
    expect(addTeamMemberResponse.statusCode).toBe(200);

    const loginResponse = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: {
        email: 'org-member-flow@example.com',
        password,
      },
    });
    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json() as { ok: boolean; code: string };
    expect(loginBody.ok).toBe(true);
    expect(typeof loginBody.code).toBe('string');

    const tokenResponse = await app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
      },
      payload: {
        code: loginBody.code,
      },
    });
    expect(tokenResponse.statusCode).toBe(200);

    const tokenBody = tokenResponse.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');

    const { payload } = await jwtVerify(
      tokenBody.access_token,
      new TextEncoder().encode(process.env.SHARED_SECRET!),
      { issuer: process.env.AUTH_SERVICE_IDENTIFIER },
    );

    expect(payload.domain).toBe(domain);
    expect(payload.sub).toBe(member.id);
    expect(payload.org).toBeDefined();

    const orgClaim = payload.org as OrgClaim;
    expect(orgClaim.org_id).toBe(org.id);
    expect(orgClaim.org_role).toBe('member');
    expect(orgClaim.teams.slice().sort()).toEqual([defaultTeam!.id, team.id].sort());
    expect(orgClaim.team_roles[defaultTeam!.id]).toBe('member');
    expect(orgClaim.team_roles[team.id]).toBe('lead');
    expect(orgClaim.groups).toBeUndefined();

    await app.close();
  });
});
