import { createHash, randomUUID } from 'node:crypto';

import { ConfidentialDelegationScope, Prisma } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.js';
import { ORG_SUBJECT_ASSERTION_AUDIENCE } from '../../src/middleware/org-role-guard.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
  TEST_SHARED_SECRET,
} from '../helpers/test-config.js';

const gates = vi.hoisted(() => ({
  beforePlatformRead: undefined as undefined | (() => Promise<void>),
  beforeExchangeEpoch: undefined as undefined | (() => void),
  beforeAuthority: undefined as undefined | (() => Promise<void>),
  jwks: { keys: [] as unknown[] },
}));

// Only external key transport and scheduling are controlled. Signature checks,
// authority queries, Prisma pools, PostgreSQL locks and HTTP handlers are real.
vi.mock('../../src/services/jwks-fetch.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/jwks-fetch.service.js')>(),
  fetchPartnerJwks: async () => gates.jwks,
}));
vi.mock('../../src/services/domain-role.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/domain-role.service.js')>();
  return { ...actual, isPlatformSuperuser: async (...args: Parameters<typeof actual.isPlatformSuperuser>) => {
    await gates.beforePlatformRead?.();
    return actual.isPlatformSuperuser(...args);
  } };
});
vi.mock('../../src/services/authentication-epoch.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/authentication-epoch.service.js')>();
  return { ...actual, lockAndAssertAuthenticationEpoch:
    async (...args: Parameters<typeof actual.lockAndAssertAuthenticationEpoch>) => {
      gates.beforeExchangeEpoch?.();
      return actual.lockAndAssertAuthenticationEpoch(...args);
    } };
});
vi.mock('../../src/services/tenant-effect-authority.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/tenant-effect-authority.service.js')>();
  return { ...actual, assertTenantEffectAuthority:
    async (...args: Parameters<typeof actual.assertTenantEffectAuthority>) => {
      await gates.beforeAuthority?.();
      return actual.assertTenantEffectAuthority(...args);
    } };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function boundedPoolUrl(value: string, connections: number): string {
  const url = new URL(value);
  url.searchParams.set('connection_limit', String(connections));
  url.searchParams.set('pool_timeout', '20');
  return url.toString();
}

const DOMAIN = 'pool-cycle.example.com';
const CONFIG_URL = `https://${DOMAIN}/auth/config`;
const ISSUER = 'https://authentication.unlikeotherai.com';
const RESOURCE = 'https://ledger.unlikeotherai.com';
const SOURCE_KID = 'pool-cycle-source';

// This gate must never report green with no PostgreSQL coverage.
if (!process.env.DATABASE_URL) throw new Error('Real PostgreSQL DATABASE_URL is required');

describe('/org/me and confidential exchange with production pool limits', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let sourceKey: KeyLike;
  let domainHash: string;
  let subject: string;
  let orgId: string;
  let teamId: string;
  let assuranceReference: string;
  let assuranceId: string;
  let clientDomainId: string;
  const failures: { path: string; code: string }[] = [];
  const saved = Object.fromEntries([
    'DATABASE_URL', 'DATABASE_ADMIN_URL', 'SHARED_SECRET', 'PUBLIC_BASE_URL',
    'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK', 'STRIPE_BILLING_ENABLED',
  ].map((key) => [key, process.env[key]]));

  beforeAll(async () => {
    const created = await createRlsTestDb();
    if (!created) throw new Error('Real PostgreSQL DATABASE_URL is required');
    db = created;
    await disconnectPrisma();
    process.env.DATABASE_URL = boundedPoolUrl(db.appDatabaseUrl, 3);
    process.env.DATABASE_ADMIN_URL = boundedPoolUrl(db.adminDatabaseUrl, 2);
    process.env.SHARED_SECRET = TEST_SHARED_SECRET;
    process.env.PUBLIC_BASE_URL = ISSUER;
    process.env.STRIPE_BILLING_ENABLED = 'false';

    const source = await generateKeyPair('RS256');
    sourceKey = source.privateKey;
    gates.jwks.keys = [{ ...await exportJWK(source.publicKey), kid: SOURCE_KID, alg: 'RS256', use: 'sig' }];
    const signer = await generateKeyPair('RS256', { extractable: true });
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({
      ...await exportJWK(signer.privateKey), kid: 'pool-cycle-resource', alg: 'RS256', use: 'sig',
    });
    resetAccessTokenKeyCache();

    domainHash = await seedDomainSecret(db.prisma, DOMAIN, TEST_SHARED_SECRET);
    const client = await db.prisma.clientDomain.findUniqueOrThrow({ where: { domain: DOMAIN } });
    clientDomainId = client.id;
    await db.prisma.enterpriseProductReadiness.create({ data: { clientDomain: DOMAIN, minimumAssuranceVersion: 1 } });
    await db.prisma.confidentialDelegationMapping.create({ data: {
      clientDomainId: client.id, product: 'nessie', resource: RESOURCE,
      scopes: [ConfidentialDelegationScope.AI_INVOKE],
    } });
    const user = await db.prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, userKey: randomUUID(),
    } });
    subject = user.id;
    await db.prisma.domainRole.create({ data: { domain: DOMAIN, userId: subject, role: 'USER' } });
    const org = await db.prisma.organisation.create({ data: {
      domain: DOMAIN, name: 'Pool regression', slug: `pool-${randomUUID()}`, ownerId: subject,
    } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: {
      orgId, name: 'Selected team', slug: 'selected-team', isDefault: true,
    } });
    teamId = team.id;
    await db.prisma.orgMember.create({ data: { orgId, userId: subject, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { teamId, userId: subject, teamRole: 'admin' } });

    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 600_000);
    await db.prisma.refreshToken.create({ data: {
      familyId, userId: subject, domain: DOMAIN, orgId, teamId,
      clientId: 'pool-regression-source', configUrl: CONFIG_URL, tokenHash: randomUUID(),
      expiresAt: new Date(expiresAt.getTime() + 1_000),
    } });
    const proof = await db.prisma.$transaction((tx) => issueSessionAssurance({
      familyId, userId: subject, clientDomain: DOMAIN, credentialEpoch: 0, orgId, teamId,
      method: 'independent', observedAt: new Date(), authenticatedAt: null,
      mfaSource: 'none', amr: ['pwd'], expiresAt, policyGeneration: 0,
    }, tx));
    assuranceReference = proof.reference;
    assuranceId = proof.assurance.id;

    const config = await signTestConfigJwt(baseClientConfigPayload({
      domain: DOMAIN, jwks_url: `https://${DOMAIN}/.well-known/jwks.json`,
      redirect_urls: [`https://${DOMAIN}/callback`], org_features: { enabled: true },
    }));
    vi.stubGlobal('fetch', await createTestConfigFetchHandler({ [CONFIG_URL]: config }));
    app = await createApp();
    app.addHook('onError', (request, _reply, error, done) => {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)) {
        failures.push({ path: request.routeOptions.url ?? 'unknown', code });
      }
      done();
    });
    await app.ready();
  });

  afterAll(async () => {
    gates.beforePlatformRead = undefined;
    gates.beforeExchangeEpoch = undefined;
    gates.beforeAuthority = undefined;
    if (app) await app.close();
    await disconnectPrisma();
    resetAccessTokenKeyCache();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (db) await db.cleanup();
  });

  async function assertion(audience: string): Promise<string> {
    return new SignJWT({ source_domain: DOMAIN, tv: 0, active: { orgId, teamId },
      assurance_ref: assuranceReference, assurance_version: 1 })
      .setProtectedHeader({ alg: 'RS256', kid: SOURCE_KID })
      .setIssuer(DOMAIN).setAudience(audience).setSubject(subject)
      .setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(sourceKey);
  }

  function readOrgMe(credential: string) {
    return app.inject({ method: 'GET',
      url: `/org/me?domain=${DOMAIN}&config_url=${encodeURIComponent(CONFIG_URL)}`,
      headers: { authorization: `Bearer ${domainHash}`, 'x-uoa-subject-assertion': credential },
    });
  }

  function exchange(credential: string) {
    return app.inject({ method: 'POST', url: `/auth/token?config_url=${encodeURIComponent(CONFIG_URL)}`,
      headers: { authorization: `Bearer ${domainHash}` }, payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', subject_token: credential,
        product: 'nessie', resource: RESOURCE, scope: 'ai.invoke',
      } });
  }

  async function userLockOccupancy(): Promise<{ waitingWriters: number; adminReaders: number; sharedReaders: number }> {
    const identity = JSON.stringify(['uoa:refresh-session:user:v1', subject]);
    const rows = await db.prisma.$queryRaw<{ waitingWriters: number; adminReaders: number; sharedReaders: number }[]>(Prisma.sql`
      WITH target AS (SELECT hashtextextended(${identity}, 0) AS key)
      SELECT count(*) FILTER (WHERE locks.mode = 'ExclusiveLock' AND NOT locks.granted)::int AS "waitingWriters",
             count(*) FILTER (WHERE locks.mode = 'ShareLock' AND locks.granted)::int AS "sharedReaders",
             count(*) FILTER (WHERE locks.mode = 'ShareLock' AND locks.granted
               AND activity.usename = 'uoa_admin')::int AS "adminReaders"
        FROM pg_locks locks JOIN pg_stat_activity activity ON activity.pid = locks.pid, target
       WHERE locks.locktype = 'advisory'
         AND locks.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND locks.classid::bigint = ((target.key >> 32) & 4294967295)
         AND locks.objid::bigint = (target.key & 4294967295) AND locks.objsubid = 1
    `);
    return rows[0] ?? { waitingWriters: 0, adminReaders: 0, sharedReaders: 0 };
  }

  it('uses real RLS roles and completes both paths without contention', async () => {
    const roles = await db.prisma.$queryRaw<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>(
      Prisma.sql`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('uoa_app', 'uoa_admin')`,
    );
    expect(roles).toContainEqual({ rolname: 'uoa_app', rolbypassrls: false, rolsuper: false });
    expect(roles).toContainEqual({ rolname: 'uoa_admin', rolbypassrls: true, rolsuper: false });
    expect(await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`)
      .toEqual([{ role: 'uoa_app' }]);
    const readProof = await assertion(ORG_SUBJECT_ASSERTION_AUDIENCE);
    const read = await readOrgMe(readProof);
    expect(read.statusCode, JSON.stringify(failures)).toBe(200);
    expect(read.json().org.org_id).toBe(orgId);
    // GET reads do not consume the assertion jti; the same live proof remains readable.
    expect((await readOrgMe(readProof)).statusCode).toBe(200);
    const tokenProof = await assertion(`${ISSUER}/auth/token`);
    expect((await exchange(tokenProof)).statusCode, JSON.stringify(failures)).toBe(200);
    expect((await exchange(tokenProof)).statusCode).toBe(401);
  });

  type Authority = 'credential epoch' | 'identity' | 'org membership' | 'team membership' | 'assurance' | 'domain secret';
  async function changeAuthority(kind: Authority, denied: boolean) {
    switch (kind) {
      case 'credential epoch':
        return db.prisma.user.update({ where: { id: subject }, data: { tokenVersion: denied ? 1 : 0 } });
      case 'identity':
        return db.prisma.user.update({ where: { id: subject }, data: { lifecycleStatus: denied ? 'DISABLED' : 'ACTIVE' } });
      case 'org membership':
        return db.prisma.orgMember.update({ where: { orgId_userId: { orgId, userId: subject } },
          data: { status: denied ? 'REMOVED' : 'ACTIVE' } });
      case 'team membership':
        return db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId: subject } },
          data: { status: denied ? 'REMOVED' : 'ACTIVE' } });
      case 'assurance':
        return db.prisma.sessionAssurance.update({ where: { id: assuranceId }, data: { revokedAt: denied ? new Date() : null } });
      case 'domain secret':
        return db.prisma.clientDomainSecret.updateMany({ where: { domainId: clientDomainId }, data: { active: !denied } });
    }
  }

  it.each<Authority>(['credential epoch', 'identity', 'org membership', 'team membership', 'assurance', 'domain secret'])(
    'rechecks %s revoked after credential preflight before returning a snapshot', async (kind) => {
      let entered = false;
      const release = deferred();
      gates.beforeAuthority = async () => { entered = true; await release.promise; };
      const read = readOrgMe(await assertion(ORG_SUBJECT_ASSERTION_AUDIENCE));
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2_000, interval: 10 });
        await changeAuthority(kind, true);
        release.resolve();
        expect([401, 403]).toContain((await read).statusCode);
      } finally {
        release.resolve();
        gates.beforeAuthority = undefined;
        await Promise.allSettled([read]);
        await changeAuthority(kind, false);
      }
    },
  );

  it('keeps the admin projection inside live memberships, lifecycles and server-owned product policy', async () => {
    const owner = await db.prisma.user.create({ data: { userKey: randomUUID(), email: `${randomUUID()}@example.test` } });
    async function directoryTeam(domain: string, member = true, orgActive = true, teamActive = true) {
      const org = await db.prisma.organisation.create({ data: { domain, name: 'Directory boundary',
        slug: `boundary-${randomUUID()}`, ownerId: owner.id, lifecycleStatus: orgActive ? 'ACTIVE' : 'DISABLED' } });
      if (member) await db.prisma.orgMember.create({ data: { orgId: org.id, userId: subject, role: 'member' } });
      const team = await db.prisma.team.create({ data: { orgId: org.id, name: 'Directory boundary',
        slug: 'boundary', lifecycleStatus: teamActive ? 'ACTIVE' : 'DISABLED' } });
      await db.prisma.teamMember.create({ data: { teamId: team.id, userId: subject, teamRole: 'member' } });
      return team.id;
    }
    const local = await directoryTeam(DOMAIN);
    const excluded = await Promise.all([directoryTeam(DOMAIN, false), directoryTeam(DOMAIN, true, false),
      directoryTeam(DOMAIN, true, true, false), directoryTeam('other-product.example.com', false)]);
    const foreign = await directoryTeam('other-product.example.com');
    const before = await readOrgMe(await assertion(ORG_SUBJECT_ASSERTION_AUDIENCE));
    expect(before.statusCode).toBe(200);
    expect(before.json().self_identity.subject).toBe(subject);
    const beforeIds = before.json().org.team_directory.map((team: { teamId: string }) => team.teamId);
    expect(beforeIds.sort()).toEqual([teamId, local].sort());
    const service = await db.prisma.billingService.create({ data: { identifier: `boundary-${randomUUID()}`, name: 'Boundary' } });
    const key = await db.prisma.billingAppKey.create({ data: { serviceId: service.id, name: 'Boundary',
      actorIssuer: `https://${DOMAIN}`, actorAudience: `${ISSUER}/billing/v1/effective-tariff`,
      actorKeyId: randomUUID(), actorPublicJwk: {}, checkoutReturnOrigins: [`https://${DOMAIN}`],
      keyPrefix: randomUUID().slice(0, 12), secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      purpose: 'CUSTOMER_LIFECYCLE' } });
    try {
      const after = await readOrgMe(await assertion(ORG_SUBJECT_ASSERTION_AUDIENCE));
      expect(after.statusCode).toBe(200);
      expect(after.json().org.org_id).toBe(orgId);
      const afterIds = after.json().org.team_directory.map((team: { teamId: string }) => team.teamId);
      expect(afterIds.sort()).toEqual([teamId, local, foreign].sort());
      for (const id of excluded) expect(afterIds).not.toContain(id);
    } finally {
      await db.prisma.billingAppKey.delete({ where: { id: key.id } });
      await db.prisma.billingService.delete({ where: { id: service.id } });
    }
  });

  it('completes a shared authority read while two same-user exchanges contend for admin connections', async () => {
    const releaseRead = deferred();
    let readEntered = false;
    let exchangeCount = 0;
    gates.beforePlatformRead = async () => {
      readEntered = true;
      await releaseRead.promise;
    };
    gates.beforeExchangeEpoch = () => {
      exchangeCount += 1;
    };
    failures.length = 0;
    const readProof = await assertion(ORG_SUBJECT_ASSERTION_AUDIENCE);
    const tokenProofs = await Promise.all([assertion(`${ISSUER}/auth/token`), assertion(`${ISSUER}/auth/token`)]);
    const read = readOrgMe(readProof);
    const writers: ReturnType<typeof exchange>[] = [];
    try {
      await vi.waitFor(() => expect(readEntered).toBe(true), { timeout: 2_000, interval: 10 });
      const reader = await userLockOccupancy();
      expect(reader.sharedReaders).toBe(1);
      expect([0, 1]).toContain(reader.adminReaders);
      const availableAdminSlots = 2 - reader.adminReaders;
      writers.push(...tokenProofs.map(exchange));
      await vi.waitFor(() => expect(exchangeCount).toBe(availableAdminSlots), { timeout: 2_000, interval: 10 });
      // Fill every remaining admin slot and observe the real PostgreSQL wait graph.
      // An authority read owning an admin transaction already occupies one of them.
      let contended: Awaited<ReturnType<typeof userLockOccupancy>> | undefined;
      await vi.waitFor(async () => {
        const observed = await userLockOccupancy();
        expect(observed.waitingWriters).toBe(availableAdminSlots);
        contended = observed;
      }, { timeout: 1_500, interval: 10 });
      releaseRead.resolve();
      const [readResult, ...writerResults] = await Promise.all([read, ...writers]);
      const diagnostic = JSON.stringify({ pausedReader: reader, contended, failures });
      expect(readResult.statusCode, diagnostic).toBe(200);
      expect(writerResults.map((response) => response.statusCode), diagnostic).toEqual([200, 200]);
      expect(readResult.json().org.org_id).toBe(orgId);
    } finally {
      releaseRead.resolve();
      gates.beforePlatformRead = undefined;
      gates.beforeExchangeEpoch = undefined;
      await Promise.allSettled([read, ...writers]);
    }
  });
});
