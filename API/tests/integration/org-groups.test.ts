import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

function secretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

async function createSignedConfigJwt(
  sharedSecret: string,
  orgFeatures: Record<string, unknown>,
): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  const payload = baseClientConfigPayload({
    org_features: {
      enabled: true,
      ...orgFeatures,
    },
  });
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(secretKey(sharedSecret));
}

function orgNameDateSuffix(suffix: string): string {
  return `Acme ${suffix}`;
}

async function signOrgAccessToken(params: {
  subject: string;
  orgId: string;
  domain: string;
  secret: string;
  issuer: string;
}) {
  return await new SignJWT({
    email: 'member@example.com',
    domain: params.domain,
    client_id: createClientId(params.domain, params.secret),
    role: 'user',
    org: {
      org_id: params.orgId,
      org_role: 'member',
      teams: [],
      team_roles: {},
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(params.issuer)
    .setSubject(params.subject)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(secretKey(params.secret));
}

describe.skipIf(!hasDatabase)('GET /org/organisations/:orgId/groups', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await handle.prisma.groupMember.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.group.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  it('returns paginated groups for org members when groups feature is enabled', async () => {
    const user = await handle!.prisma.user.create({
      data: {
        email: 'owner@example.com',
        userKey: 'owner@example.com',
        passwordHash: null,
      },
      select: { id: true },
    });

    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'client.example.com',
        name: orgNameDateSuffix('Org'),
        slug: 'acme-org',
        ownerId: user.id,
      },
      select: { id: true },
    });

    const now = Date.now();
    await handle!.prisma.group.createMany({
      data: [
        {
          orgId: org.id,
          name: orgNameDateSuffix('Group 1'),
          description: 'First',
          createdAt: new Date(now - 30_000),
          updatedAt: new Date(now - 30_000),
        },
        {
          orgId: org.id,
          name: orgNameDateSuffix('Group 2'),
          description: 'Second',
          createdAt: new Date(now - 20_000),
          updatedAt: new Date(now - 20_000),
        },
        {
          orgId: org.id,
          name: orgNameDateSuffix('Group 3'),
          description: 'Third',
          createdAt: new Date(now - 10_000),
          updatedAt: new Date(now - 10_000),
        },
      ],
    });

    const configUrl = 'https://client.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      groups_enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const accessToken = await signOrgAccessToken({
      subject: user.id,
      orgId: org.id,
      domain: 'client.example.com',
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId('client.example.com', process.env.SHARED_SECRET);
    const first = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/groups?domain=client.example.com&config_url=${encodeURIComponent(
        configUrl,
      )}&limit=2`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { data: Array<{ name: string; id: string }>; next_cursor: string | null };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.data[0].name).toBe(orgNameDateSuffix('Group 3'));
    expect(firstBody.data[1].name).toBe(orgNameDateSuffix('Group 2'));
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/groups?domain=client.example.com&config_url=${encodeURIComponent(
        configUrl,
      )}&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { data: Array<{ name: string }>; next_cursor: string | null };
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.data[0].name).toBe(orgNameDateSuffix('Group 1'));
    expect(secondBody.next_cursor).toBeNull();

    await app.close();
  });

  it('returns 404 when groups are disabled for orgs', async () => {
    const user = await handle!.prisma.user.create({
      data: {
        email: 'owner@example.com',
        userKey: 'owner@example.com',
        passwordHash: null,
      },
      select: { id: true },
    });

    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'client.example.com',
        name: orgNameDateSuffix('Org'),
        slug: 'acme-org',
        ownerId: user.id,
      },
      select: { id: true },
    });

    const configUrl = 'https://client.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      groups_enabled: false,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const accessToken = await signOrgAccessToken({
      subject: user.id,
      orgId: org.id,
      domain: 'client.example.com',
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const app = await createApp();
    await app.ready();

    const domainHash = createClientId('client.example.com', process.env.SHARED_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/groups?domain=client.example.com&config_url=${encodeURIComponent(
        configUrl,
      )}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns group details with teams and members when groups are enabled', async () => {
    const owner = await handle!.prisma.user.create({
      data: {
        email: 'owner-detail@example.com',
        userKey: 'owner-detail@example.com',
        passwordHash: null,
      },
      select: { id: true },
    });

    const domain = 'client.example.com';
    const configUrl = 'https://client.example.com/auth-config';
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      groups_enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(configJwt, { status: 200 })));

    const org = await handle!.prisma.organisation.create({
      data: {
        domain,
        name: orgNameDateSuffix('Org'),
        slug: 'acme-org-detail',
        ownerId: owner.id,
      },
      select: { id: true },
    });

    const team = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: orgNameDateSuffix('Team Alpha'),
      },
      select: { id: true },
    });

    const group = await handle!.prisma.group.create({
      data: {
        orgId: org.id,
        name: orgNameDateSuffix('Group Detail'),
        description: 'Group used for integration detail test',
      },
      select: { id: true },
    });

    await handle!.prisma.team.update({
      where: { id: team.id },
      data: { groupId: group.id },
    });

    await handle!.prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId: owner.id,
        isAdmin: true,
      },
    });

    const ownerToken = await signOrgAccessToken({
      subject: owner.id,
      orgId: org.id,
      domain,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const domainHash = createClientId(domain, process.env.SHARED_SECRET);
    const app = await createApp();
    await app.ready();

    const groupRes = await app.inject({
      method: 'GET',
      url: `/org/organisations/${org.id}/groups/${group.id}?domain=${encodeURIComponent(
        domain,
      )}&config_url=${encodeURIComponent(configUrl)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${ownerToken}`,
      },
    });

    expect(groupRes.statusCode).toBe(200);
    const groupBody = groupRes.json() as {
      id: string;
      orgId: string;
      name: string;
      teams: Array<{ id: string; orgId: string; groupId: string | null }>;
      members: Array<{ userId: string; isAdmin: boolean }>;
    };

    expect(groupBody.id).toBe(group.id);
    expect(groupBody.orgId).toBe(org.id);
    expect(groupBody.teams).toHaveLength(1);
    expect(groupBody.teams[0].id).toBe(team.id);
    expect(groupBody.teams[0].groupId).toBe(group.id);
    expect(groupBody.members).toHaveLength(1);
    expect(groupBody.members[0].userId).toBe(owner.id);
    expect(groupBody.members[0].isAdmin).toBe(true);

    await app.close();
  });
});
