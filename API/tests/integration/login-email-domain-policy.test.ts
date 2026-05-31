import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { assertEmailDomainAllowedForLogin } from '../../src/services/login-domain-policy.service.js';
import { isAppError } from '../../src/utils/errors.js';
import { createTestDb } from '../helpers/test-db.js';
import { hasDatabase } from '../helpers/org-user-endpoints-helper.js';

const adminSecret = 'test-admin-token-secret-with-enough-length';
const issuer = 'uoa-auth-service';
const adminDomain = 'admin.example.com';

async function superuserToken(userId: string): Promise<string> {
  return await new SignJWT({
    email: 'root@admin.example.com',
    domain: adminDomain,
    client_id: 'client-id',
    role: 'superuser',
    tv: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(adminSecret));
}

async function expectBlocked(userId: string, domain: string): Promise<void> {
  await expect(assertEmailDomainAllowedForLogin({ userId, domain })).rejects.toSatisfy(
    (err: unknown) => isAppError(err) && err.statusCode === 403,
  );
}

describe.skipIf(!hasDatabase)('login email-domain policy (DB-backed)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  let app: Awaited<ReturnType<typeof createApp>>;
  let adminUserId: string;

  // Seeded ids.
  let restrictedOrgId = '';
  let restrictedTeamId = '';
  let openOrgId = '';

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');

    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.ADMIN_AUTH_DOMAIN = adminDomain;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = adminSecret;
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = issuer;

    const prisma = handle.prisma;

    // Admin superuser (subject of the admin bearer; middleware verifies the DomainRole in DB).
    const admin = await prisma.user.create({
      data: { email: 'root@admin.example.com', userKey: 'root@admin.example.com' },
      select: { id: true },
    });
    adminUserId = admin.id;
    await prisma.domainRole.create({
      data: { domain: adminDomain, userId: adminUserId, role: 'SUPERUSER' },
    });

    // --- Client-domain-level restriction (allow only @acme.com) ---
    await prisma.clientDomain.create({
      data: { domain: 'restrict.example.com', label: 'Restrict', allowedEmailDomains: ['acme.com'] },
    });
    await prisma.user.create({ data: { email: 'alice@acme.com', userKey: 'alice@acme.com' } });
    await prisma.user.create({ data: { email: 'mallory@evil.com', userKey: 'mallory@evil.com' } });
    const restrictSuper = await prisma.user.create({
      data: { email: 'root@evil.com', userKey: 'root@evil.com' },
      select: { id: true },
    });
    await prisma.domainRole.create({
      data: { domain: 'restrict.example.com', userId: restrictSuper.id, role: 'SUPERUSER' },
    });

    // --- Org-level restriction on an otherwise-open client domain ---
    await prisma.clientDomain.create({ data: { domain: 'open.example.com', label: 'Open' } });
    const orgOwner = await prisma.user.create({
      data: { email: 'owner@acme.com', userKey: 'owner@acme.com' },
      select: { id: true },
    });
    const restrictedOrg = await prisma.organisation.create({
      data: {
        domain: 'open.example.com',
        name: 'Acme Org',
        slug: 'acme-org',
        ownerId: orgOwner.id,
        allowedEmailDomains: ['acme.com'],
      },
      select: { id: true },
    });
    restrictedOrgId = restrictedOrg.id;
    const orgEvil = await prisma.user.create({
      data: { email: 'bob@evil.com', userKey: 'bob@evil.com' },
      select: { id: true },
    });
    await prisma.orgMember.create({ data: { orgId: restrictedOrgId, userId: orgEvil.id, role: 'member' } });
    (globalThis as Record<string, unknown>).__orgEvilId = orgEvil.id;

    // --- Team-level restriction (org open, team restricted) ---
    const openOrg = await prisma.organisation.create({
      data: { domain: 'open.example.com', name: 'Open Org', slug: 'open-org', ownerId: orgOwner.id },
      select: { id: true },
    });
    openOrgId = openOrg.id;
    const restrictedTeam = await prisma.team.create({
      data: { orgId: openOrgId, name: 'Secure', slug: 'secure', allowedEmailDomains: ['acme.com'] },
      select: { id: true },
    });
    restrictedTeamId = restrictedTeam.id;
    const teamEvil = await prisma.user.create({
      data: { email: 'ted@evil.com', userKey: 'ted@evil.com' },
      select: { id: true },
    });
    await prisma.orgMember.create({ data: { orgId: openOrgId, userId: teamEvil.id, role: 'member' } });
    await prisma.teamMember.create({ data: { teamId: restrictedTeamId, userId: teamEvil.id } });
    (globalThis as Record<string, unknown>).__teamEvilId = teamEvil.id;

    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  async function userIdByEmail(email: string): Promise<string> {
    const row = await handle!.prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    return row.id;
  }

  it('allows a matching email at the client-domain level', async () => {
    const id = await userIdByEmail('alice@acme.com');
    await expect(
      assertEmailDomainAllowedForLogin({ userId: id, domain: 'restrict.example.com' }),
    ).resolves.toBeUndefined();
  });

  it('blocks a non-matching email at the client-domain level', async () => {
    const id = await userIdByEmail('mallory@evil.com');
    await expectBlocked(id, 'restrict.example.com');
  });

  it('lets a SUPERUSER bypass the client-domain restriction', async () => {
    const id = await userIdByEmail('root@evil.com');
    await expect(
      assertEmailDomainAllowedForLogin({ userId: id, domain: 'restrict.example.com' }),
    ).resolves.toBeUndefined();
  });

  it('blocks on an org-level restriction even when the client domain is open', async () => {
    const id = (globalThis as Record<string, unknown>).__orgEvilId as string;
    await expectBlocked(id, 'open.example.com');
  });

  it('blocks on a team-level restriction even when the org and client domain are open', async () => {
    const id = (globalThis as Record<string, unknown>).__teamEvilId as string;
    await expectBlocked(id, 'open.example.com');
  });

  it('persists allowed_email_domains via the admin domain endpoint', async () => {
    const token = await superuserToken(adminUserId);
    const res = await app.inject({
      method: 'PUT',
      url: '/internal/admin/domains/restrict.example.com',
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed_email_domains: ['acme.com', 'ACME.io'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowedEmailDomains).toEqual(['acme.com', 'acme.io']);

    const row = await handle!.prisma.clientDomain.findUniqueOrThrow({
      where: { domain: 'restrict.example.com' },
      select: { allowedEmailDomains: true },
    });
    expect(row.allowedEmailDomains).toEqual(['acme.com', 'acme.io']);
  });

  it('rejects an invalid domain entry with 400', async () => {
    const token = await superuserToken(adminUserId);
    const res = await app.inject({
      method: 'PUT',
      url: '/internal/admin/domains/restrict.example.com',
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed_email_domains: ['not a domain'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('persists allowed_email_domains via the admin organisation endpoint', async () => {
    const token = await superuserToken(adminUserId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/internal/admin/organisations/${restrictedOrgId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed_email_domains: ['acme.com', 'partner.com'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowedEmailDomains).toEqual(['acme.com', 'partner.com']);
  });

  it('persists allowed_email_domains via the admin team endpoint', async () => {
    const token = await superuserToken(adminUserId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/internal/admin/organisations/${openOrgId}/teams/${restrictedTeamId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed_email_domains: ['acme.com'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().team.allowedEmailDomains).toEqual(['acme.com']);
  });

  it('rejects admin writes without a superuser token', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/internal/admin/organisations/${restrictedOrgId}`,
      payload: { allowed_email_domains: ['acme.com'] },
    });
    expect(res.statusCode).toBe(401);
  });
});
