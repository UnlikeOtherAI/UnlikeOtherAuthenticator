import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfidentialDelegationMapping, deleteConfidentialDelegationMapping, resolveConfidentialDelegation,
  updateConfidentialDelegationMapping } from '../../src/services/confidential-delegation.service.js';
import { exchangeConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import { resetAccessTokenKeyCache, signConfidentialAccessToken } from '../../src/services/oauth/access-token.service.js';
import { lockProductTeamPolicyShared } from '../../src/services/product-team-policy-lock.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const issuer = 'https://authentication.example.com', resource = 'https://resource.example.com/api';
const actor = { email: 'synthetic-operator@example.com' };

describe.skipIf(!process.env.DATABASE_URL)('delegation CRUD versus locked real RS256 issuance on PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK };
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('Owned PostgreSQL required');
    handle = created;
    keys = await generateKeyPair('RS256', { extractable: true });
    publicJwk = { ...await exportJWK(keys.publicKey), kid: 'delegation-race', alg: 'RS256', use: 'sig' };
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(keys.privateKey), kid: publicJwk.kid });
    process.env.PUBLIC_BASE_URL = issuer;
    resetAccessTokenKeyCache();
  });
  afterAll(async () => {
    resetAccessTokenKeyCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });
  async function fixture() {
    const suffix = randomUUID(), domain = `${suffix}.example.com`, product = 'runtime-product';
    const client = await handle.prisma.clientDomain.create({ data: { domain, label: 'Race', status: 'active' } });
    const user = await handle.prisma.user.create({ data: { email: `${suffix}@example.com`, userKey: suffix } });
    await handle.prisma.domainRole.create({ data: { domain, userId: user.id, role: 'USER' } });
    const configJwt = await new SignJWT({ domain, jwks_url: `https://${domain}/jwks` })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid }).sign(keys.privateKey);
    const config = validateConfigFields(baseClientConfigPayload({ domain, org_features: { enabled: false } }));
    const params = { authenticatedClientDomainId: client.id, product, resource, scope: 'ai.invoke', config, configJwt };
    const create = () => createConfidentialDelegationMapping({ sourceDomain: domain, product, resource, scopes: ['ai.invoke'], actor }, { prisma: handle.prisma });
    const jti = randomUUID();
    const assertion = await new SignJWT({ source_domain: domain, tv: 0 })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }).setIssuer(domain)
      .setAudience(`${issuer}/auth/token`).setSubject(user.id).setJti(jti).setIssuedAt()
      .setExpirationTime('60s').sign(keys.privateKey);
    return { domain, user, create, params: { ...params, subjectToken: assertion }, jti };
  }
  async function waitForBlocked(pid: number) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const [row] = await handle.prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`;
      if (row.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected real PostgreSQL policy-lock waiter');
  }

  it('holds supported mapping creation behind an in-flight shared policy reader', async () => {
    const f = await fixture(), entered = latch(), release = latch();
    let pid = 0;
    const read = handle.prisma.$transaction(async tx => {
      await lockProductTeamPolicyShared(tx);
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      entered.release(); await release.promise;
    }, { timeout: 15_000 });
    await entered.promise;
    const create = f.create();
    try { await waitForBlocked(pid); } finally { release.release(); await read; }
    const mapping = await create;
    expect(mapping).toMatchObject({ product: f.params.product, resource, enabled: true });
  });

  it('keeps deletion waiting through real signing and commit, then refuses fresh issuance', async () => {
    const f = await fixture(), mapping = await f.create(), signing = latch(), release = latch();
    let pid = 0;
    const exchange = exchangeConfidentialSubjectToken(f.params, { prisma: handle.prisma,
      fetchJwks: async () => ({ keys: [publicJwk] }), consumeSubjectRateLimit: () => {},
      resolveDelegation: async (params, deps) => {
        const result = await resolveConfidentialDelegation(params, deps);
        // The authoritative second resolution runs inside the shared policy tx.
        if (deps?.prisma !== handle.prisma) pid = (await deps!.prisma!.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        return result;
      },
      signAccessToken: async claims => { signing.release(); await release.promise; return signConfidentialAccessToken(claims); },
    });
    await signing.promise;
    const deletion = deleteConfidentialDelegationMapping({ mappingId: mapping.id, actor }, { prisma: handle.prisma });
    try { await waitForBlocked(pid); } finally { release.release(); }
    const issued = await exchange;
    await deletion;
    const verified = await jwtVerify(issued.accessToken, keys.publicKey, { issuer, audience: resource, algorithms: ['RS256'] });
    expect(verified.payload.sub).toBe(f.user.id);
    expect(verified.payload.scope).toBe('ai.invoke');
    expect(await handle.prisma.confidentialAssertionUse.count({ where: { sourceDomain: f.domain } })).toBe(1);
    await expect(exchangeConfidentialSubjectToken(f.params, { prisma: handle.prisma,
      fetchJwks: async () => ({ keys: [publicJwk] }), consumeSubjectRateLimit: () => {},
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('re-resolves a mapping disabled after preflight and leaves its assertion unconsumed', async () => {
    const f = await fixture(), mapping = await f.create(), preflight = latch(), release = latch();
    let resolutions = 0;
    const exchange = exchangeConfidentialSubjectToken(f.params, { prisma: handle.prisma,
      fetchJwks: async () => ({ keys: [publicJwk] }), consumeSubjectRateLimit: () => {},
      resolveDelegation: async (params, deps) => {
        const result = await resolveConfidentialDelegation(params, deps);
        if (++resolutions === 1) { preflight.release(); await release.promise; }
        return result;
      },
    });
    const outcome = exchange.then(() => ({ issued: true }), error => ({ error }));
    await preflight.promise;
    try {
      await updateConfidentialDelegationMapping({ mappingId: mapping.id, enabled: false, actor }, { prisma: handle.prisma });
    } finally { release.release(); }
    expect(await outcome).toMatchObject({ error: { statusCode: 403 } });
    expect(await handle.prisma.confidentialAssertionUse.count({ where: {
      sourceDomain: f.domain, jtiHash: createHash('sha256').update(f.jti).digest('hex'),
    } })).toBe(0);
  });
});
