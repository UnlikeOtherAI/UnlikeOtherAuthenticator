import { SignJWT } from 'jose';
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

import { createApp } from '../../src/app.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(
  sharedSecret: string,
  overrides?: Record<string, unknown>,
): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload(overrides))
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe('GET /auth/domain-mapping (config + rate limiting)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns generic 400 when config_url is missing', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/domain-mapping?email_domain=company.com',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns generic 400 when config JWT is invalid', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-a-valid-jwt', { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('rate limits requests per IP', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const url = `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`;
    const ip = '198.51.100.200';

    for (let i = 0; i < 60; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url,
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mapped: false });
    }

    const blocked = await app.inject({
      method: 'GET',
      url,
      remoteAddress: ip,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

describe.skipIf(!hasDatabase)('GET /auth/domain-mapping (mapping resolution)', () => {
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

  beforeEach(async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.loginLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.groupMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.group.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns mapped org/team details when mapping references existing records', async () => {
    const owner = await handle!.prisma.user.create({
      data: {
        email: 'owner@client.example.com',
        userKey: 'owner@client.example.com',
        domain: null,
        passwordHash: null,
      },
      select: { id: true },
    });

    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'client.example.com',
        name: 'Client Org',
        slug: 'client-org',
        ownerId: owner.id,
      },
      select: { id: true, name: true },
    });
    const team = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Engineering',
        isDefault: false,
      },
      select: { id: true, name: true },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      registration_domain_mapping: [
        {
          email_domain: 'company.com',
          org_id: org.id,
          team_id: team.id,
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
      remoteAddress: '198.51.100.21',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mapped: true,
      org_id: org.id,
      org_name: org.name,
      team_id: team.id,
      team_name: team.name,
    });

    await app.close();
  });

  it('returns mapped=false when domain is not configured in registration_domain_mapping', async () => {
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      registration_domain_mapping: [
        {
          email_domain: 'other.com',
          org_id: 'org_missing',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
      remoteAddress: '198.51.100.22',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mapped: false });

    await app.close();
  });

  it('returns mapped=false when mapping references a missing organisation', async () => {
    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      registration_domain_mapping: [
        {
          email_domain: 'company.com',
          org_id: 'org_does_not_exist',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
      remoteAddress: '198.51.100.23',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mapped: false });

    await app.close();
  });

  it('returns mapped=false when mapped organisation belongs to another domain', async () => {
    const owner = await handle!.prisma.user.create({
      data: {
        email: 'owner@other-domain.example.com',
        userKey: 'owner@other-domain.example.com',
        domain: null,
        passwordHash: null,
      },
      select: { id: true },
    });
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'other-domain.example.com',
        name: 'Other Org',
        slug: 'other-org',
        ownerId: owner.id,
      },
      select: { id: true },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      registration_domain_mapping: [
        {
          email_domain: 'company.com',
          org_id: org.id,
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
      remoteAddress: '198.51.100.24',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mapped: false });

    await app.close();
  });

  it('returns mapped=false when mapped team is stale', async () => {
    const owner = await handle!.prisma.user.create({
      data: {
        email: 'owner@client.example.com',
        userKey: 'owner@client.example.com',
        domain: null,
        passwordHash: null,
      },
      select: { id: true },
    });
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: 'client.example.com',
        name: 'Client Org',
        slug: 'client-org',
        ownerId: owner.id,
      },
      select: { id: true },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, {
      registration_domain_mapping: [
        {
          email_domain: 'company.com',
          org_id: org.id,
          team_id: 'team_does_not_exist',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })),
    );

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/domain-mapping?config_url=${encodeURIComponent(configUrl)}&email_domain=company.com`,
      remoteAddress: '198.51.100.25',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mapped: false });

    await app.close();
  });
});
