import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { signAccessToken } from '../../src/services/token-signing.service.js';
import { lockProductTeamPolicyShared } from '../../src/services/product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from '../../src/services/refresh-session-lock.service.js';
import { createRlsTestDb } from './test-db.js';
import { seedDomainSecret } from './domain-secret.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from './test-config.js';

export const profileDirectoryDomain = 'profile-directory.example.com';
const adminDomain = 'admin.example.com';
const configUrl = `https://${profileDirectoryDomain}/config`;
export const profileDirectoryQuery = `?domain=${profileDirectoryDomain}&config_url=${encodeURIComponent(configUrl)}`;
const environmentKeys = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'ADMIN_AUTH_DOMAIN', 'ADMIN_ACCESS_TOKEN_SECRET',
  'USER_ACCESS_TOKEN_PRIVATE_JWK', 'USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'] as const;
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export async function createProfileDirectoryFixture(options: { backendOrgManagement?: boolean } = {}) {
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const handle = await createRlsTestDb();
  if (!handle) throw new Error('Owned test database is required');
  process.env.DATABASE_URL = handle.appDatabaseUrl;
  process.env.DATABASE_ADMIN_URL = handle.adminDatabaseUrl;
  process.env.ADMIN_AUTH_DOMAIN = adminDomain;
  process.env.ADMIN_ACCESS_TOKEN_SECRET = 'synthetic-profile-directory-admin-secret';
  delete process.env.USER_ACCESS_TOKEN_PRIVATE_JWK;
  delete process.env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON;
  await disconnectPrisma();
  const db = handle.prisma;
  const appUrl = new URL(handle.appDatabaseUrl);
  appUrl.searchParams.set('connection_limit', '2');
  const appDb = new PrismaClient({ datasources: { db: { url: appUrl.toString() } } });
  const domainHash = await seedDomainSecret(db, profileDirectoryDomain);
  const domain = await db.clientDomain.findUniqueOrThrow({ where: { domain: profileDirectoryDomain } });
  const configJwt = await signTestConfigJwt(baseClientConfigPayload({ domain: profileDirectoryDomain,
    org_features: { enabled: true, groups_enabled: true, backend_org_management: options.backendOrgManagement ?? false }, login_flow: { team_selection: 'off' } }));
  vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));
  const operator = await db.user.create({ data: { email: 'directory-operator@example.com', userKey: 'directory-operator@example.com' } });
  await db.domainRole.create({ data: { domain: adminDomain, userId: operator.id, role: 'SUPERUSER' } });
  const adminToken = await signAccessToken({ userId: operator.id, email: operator.email!, domain: adminDomain,
    clientId: `admin:${adminDomain}`, role: 'superuser', tokenVersion: 0, ttl: '30m',
    sharedSecret: process.env.ADMIN_ACCESS_TOKEN_SECRET, issuer: process.env.AUTH_SERVICE_IDENTIFIER!, relyingPartyToken: false });
  const app = await createApp();
  await app.ready();

  async function subject() {
    const suffix = randomUUID();
    const owner = await db.user.create({ data: { email: `${suffix}@example.com`, userKey: suffix, name: 'Canonical Owner' } });
    const target = await db.user.create({ data: { email: `${suffix}-target@example.com`, userKey: suffix + '-target', name: 'Canonical Target' } });
    await db.domainRole.createMany({ data: [owner.id, target.id].map(userId => ({ domain: profileDirectoryDomain, userId, role: 'USER' as const })) });
    const org = await db.organisation.create({ data: { domain: profileDirectoryDomain, name: 'Authority', slug: 'org-' + suffix, ownerId: owner.id } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'General', slug: 'general', isDefault: true } });
    await db.orgMember.createMany({ data: [{ orgId: org.id, userId: owner.id, role: 'owner' }, { orgId: org.id, userId: target.id, role: 'member' }] });
    await db.teamMember.createMany({ data: [{ teamId: team.id, userId: owner.id, teamRole: 'owner' }, { teamId: team.id, userId: target.id, teamRole: 'member' }] });
    const token = (ttl = '30m') => signAccessToken({ userId: owner.id, email: 'old-profile@example.com', domain: profileDirectoryDomain,
      clientId: domain.id, role: 'user', tokenVersion: 0, ttl, sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!, relyingPartyToken: true,
      org: { org_id: org.id, org_role: 'owner', teams: [team.id], team_roles: { [team.id]: 'owner' } } });
    return { owner, target, org, team, token, headers: { authorization: `Bearer ${domainHash}`, 'x-uoa-access-token': await token() } };
  }

  async function directory(f: Awaited<ReturnType<typeof subject>>, permissions = ['MEMBERSHIP_READ', 'DISPLAY_READ']) {
    const issued = await app.inject({ method: 'POST', url: '/internal/admin/directory-credentials',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { client_domain_id: domain.id, label: 'Runtime proof', expires_at: new Date(Date.now() + 120_000).toISOString() } });
    if (issued.statusCode !== 201) throw new Error(`Directory issuance failed with HTTP ${issued.statusCode}`);
    const credential = issued.json<{ id: string; secret: string }>();
    const granted = await app.inject({ method: 'PUT', url: `/org/organisations/${f.org.id}/product-access/${credential.id}${profileDirectoryQuery}`,
      headers: f.headers, payload: { permissions } });
    if (granted.statusCode !== 200) throw new Error(`Directory owner grant failed with HTTP ${granted.statusCode}`);
    return { id: credential.id, headers: { authorization: `Bearer ${credential.secret}` } };
  }

  async function holdUser(userId: string) {
    const entered = latch(), released = latch();
    let pid = 0;
    const work = db.$transaction(async tx => {
      await lockProductTeamPolicyShared(tx);
      await lockRefreshSessionUser(userId, { prisma: tx });
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pid = rows[0].pid;
      entered.release();
      await released.promise;
    }, { timeout: 15_000 });
    await entered.promise;
    return { pid, release: async () => { released.release(); await work; } };
  }

  async function waitForBlocked(pid: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`;
      if (rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected actual PostgreSQL lock waiter was not observed');
  }

  async function close(retain = false) {
    await app.close();
    await appDb.$disconnect();
    await disconnectPrisma();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    if (retain) {
      await db.$disconnect();
      console.info(`Retained failed authority fixture schema: ${handle!.schema}`);
    } else await handle!.cleanup();
  }
  return { app, db, appDb, handle, domain, domainHash, adminToken, subject, directory, holdUser, waitForBlocked, close };
}
