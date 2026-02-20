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
import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(
  sharedSecret: string,
  overrides?: Record<string, unknown>,
): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload({ user_scope: 'global', ...overrides }))
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

describe.skipIf(!hasDatabase)('Email verification flow', () => {
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
    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
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

  it('validates the link on GET and creates a user on POST (one-time token)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'test-token-value';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: 'newuser@example.com',
        userKey: 'newuser@example.com',
        domain: null,
        configUrl,
        tokenHash,
        expiresAt,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;

    const landing = await app.inject({
      method: 'GET',
      url: `/auth/email/link?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });

    expect(landing.statusCode).toBe(200);
    expect(landing.json()).toEqual({ ok: true });

    const verify = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as { ok: boolean; code: string; redirect_to: string };
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(10);

    const u = new URL(body.redirect_to);
    expect(`${u.origin}${u.pathname}`).toBe('https://client.example.com/oauth/callback');
    expect(u.searchParams.get('code')).toBe(body.code);

    const user = await handle!.prisma.user.findUnique({
      where: { userKey: 'newuser@example.com' },
      select: { id: true, email: true, passwordHash: true },
    });
    expect(user).not.toBeNull();
    expect(user!.email).toBe('newuser@example.com');
    expect(user!.passwordHash).toBeTruthy();

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, userId: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).not.toBeNull();
    expect(tokenRow!.userId).toBe(user!.id);

    const roles = await handle!.prisma.domainRole.findMany({
      where: { domain: 'client.example.com' },
      select: { role: true, userId: true },
    });
    expect(roles).toHaveLength(1);
    expect(roles[0].userId).toBe(user!.id);
    expect(roles[0].role).toBe('SUPERUSER');

    const codes = await handle!.prisma.authorizationCode.findMany({
      where: { userId: user!.id },
      select: { domain: true, configUrl: true, redirectUrl: true, usedAt: true },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0].domain).toBe('client.example.com');
    expect(codes[0].configUrl).toBe(configUrl);
    expect(codes[0].redirectUrl).toBe('https://client.example.com/oauth/callback');
    expect(codes[0].usedAt).toBeNull();

    // Second use should fail (one-time token).
    const reuse = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken, password: 'Abcdef1!' },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns generic 400 for invalid tokens', async () => {
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
    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;

    const res = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: 'does-not-exist', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('consumes VERIFY_EMAIL tokens without requiring password and creates a null-password user', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'passwordless-token-value';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL',
        email: 'passwordless@example.com',
        userKey: 'passwordless@example.com',
        domain: null,
        configUrl,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        tokenHash,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;
    const landing = await app.inject({
      method: 'GET',
      url: `/auth/email/link?${baseQuery}&token=${encodeURIComponent(rawToken)}`,
    });
    expect(landing.statusCode).toBe(200);
    expect(landing.json()).toEqual({ ok: true });

    const verify = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as { ok: boolean; code: string; redirect_to: string };
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(10);

    const user = await handle!.prisma.user.findUnique({
      where: { userKey: 'passwordless@example.com' },
      select: { id: true, passwordHash: true },
    });
    expect(user).not.toBeNull();
    expect(user!.passwordHash).toBeNull();

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, userId: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).not.toBeNull();
    expect(tokenRow!.userId).toBe(user!.id);

    const log = await handle!.prisma.loginLog.findFirst({
      where: { userId: user!.id },
      select: { authMethod: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).not.toBeNull();
    expect(log!.authMethod).toBe('verify_email');

    await app.close();
  });

  it('auto-places a newly verified user into mapped org/team when registration_domain_mapping matches', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const owner = await handle!.prisma.user.create({
      data: {
        email: 'owner@company.com',
        userKey: 'owner@company.com',
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

    const defaultTeam = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'General',
        isDefault: true,
      },
      select: { id: true },
    });
    const mappedTeam = await handle!.prisma.team.create({
      data: {
        orgId: org.id,
        name: 'Engineering',
        isDefault: false,
      },
      select: { id: true },
    });

    await handle!.prisma.orgMember.create({
      data: {
        orgId: org.id,
        userId: owner.id,
        role: 'owner',
      },
    });
    await handle!.prisma.teamMember.create({
      data: {
        teamId: defaultTeam.id,
        userId: owner.id,
        teamRole: 'member',
      },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET, {
      org_features: { enabled: true },
      registration_domain_mapping: [
        {
          email_domain: 'company.com',
          org_id: org.id,
          team_id: mappedTeam.id,
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'placement-token-value';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL',
        email: 'placed@company.com',
        userKey: 'placed@company.com',
        domain: null,
        configUrl,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        tokenHash,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;
    const verify = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken },
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ ok: true });

    const user = await handle!.prisma.user.findUnique({
      where: { userKey: 'placed@company.com' },
      select: { id: true },
    });
    expect(user).not.toBeNull();

    const orgMembership = await handle!.prisma.orgMember.findFirst({
      where: {
        userId: user!.id,
        orgId: org.id,
      },
      select: { role: true },
    });
    expect(orgMembership).not.toBeNull();
    expect(orgMembership!.role).toBe('member');

    const teamMembership = await handle!.prisma.teamMember.findFirst({
      where: {
        userId: user!.id,
        teamId: mappedTeam.id,
      },
      select: { teamRole: true },
    });
    expect(teamMembership).not.toBeNull();
    expect(teamMembership!.teamRole).toBe('member');

    await app.close();
  });

  it('returns generic 400 when VERIFY_EMAIL_SET_PASSWORD token is consumed without password', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(jwt, { status: 200 })),
    );

    const configUrl = 'https://client.example.com/auth-config';
    const rawToken = 'missing-password-token';
    const tokenHash = hashEmailToken(rawToken, process.env.SHARED_SECRET);

    await handle!.prisma.verificationToken.create({
      data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD',
        email: 'missing-password@example.com',
        userKey: 'missing-password@example.com',
        domain: null,
        configUrl,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        tokenHash,
      },
    });

    const app = await createApp();
    await app.ready();

    const baseQuery = `config_url=${encodeURIComponent(configUrl)}`;
    const res = await app.inject({
      method: 'POST',
      url: `/auth/verify-email?${baseQuery}`,
      payload: { token: rawToken },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    const tokenRow = await handle!.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true },
    });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.usedAt).toBeNull();

    await app.close();
  });
});
